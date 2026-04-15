const { RestClientV5 } = require("bybit-api");
const ind = require("./indicators");
const config = require("./config");

const s = config.strategy;
const client = new RestClientV5({ testnet: false });

async function fetchAllCandles(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    let result;
    try {
      const resp = await client.getKline({ category: "linear", symbol, interval, start: cursor, limit: 1000 });
      result = resp.result;
    } catch (err) {
      break;
    }
    if (!result || !result.list || result.list.length === 0) break;
    const candles = result.list
      .map((c) => ({ timestamp: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]) }))
      .reverse();
    if (candles.length === 0) break;
    all.push(...candles);
    const lastTs = candles[candles.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise((r) => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter((c) => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; });
}

function htfTrend(candles) {
  const closes = candles.map((c) => c.close);
  const emaFast = ind.ema(closes, s.htfEmaFast);
  const emaSlow = ind.ema(closes, s.htfEmaSlow);
  const i = candles.length - 2;
  if (i < 0 || emaFast[i] === null || emaSlow[i] === null) return 0;
  return emaFast[i] > emaSlow[i] ? 1 : emaFast[i] < emaSlow[i] ? -1 : 0;
}

async function fastBacktest(symbol, tfMinutes, months) {
  const now = Date.now();
  const startTime = now - months * 30 * 86400000;
  const interval = String(tfMinutes);

  const [ltfCandles, dCandles, wCandles, mCandles] = await Promise.all([
    fetchAllCandles(symbol, interval, startTime, now),
    fetchAllCandles(symbol, "D", startTime - 120 * 86400000, now),
    fetchAllCandles(symbol, "W", startTime - 365 * 86400000, now),
    fetchAllCandles(symbol, "M", startTime - 730 * 86400000, now),
  ]);

  if (ltfCandles.length < 100) return null;

  const dCloses = dCandles.map((c) => c.close);
  const wCloses = wCandles.map((c) => c.close);
  const mCloses = mCandles.map((c) => c.close);
  const dEmaFast = ind.ema(dCloses, s.htfEmaFast);
  const dEmaSlow = ind.ema(dCloses, s.htfEmaSlow);
  const wEmaFast = ind.ema(wCloses, s.htfEmaFast);
  const wEmaSlow = ind.ema(wCloses, s.htfEmaSlow);
  const mEmaFast = ind.ema(mCloses, s.htfEmaFast);
  const mEmaSlow = ind.ema(mCloses, s.htfEmaSlow);

  function getMtfTrend(ts) {
    const dIdx = dCandles.findLastIndex((c) => c.timestamp < ts);
    const wIdx = wCandles.findLastIndex((c) => c.timestamp < ts);
    const mIdx = mCandles.findLastIndex((c) => c.timestamp < ts);
    const dT = dIdx > 0 && dEmaFast[dIdx] && dEmaSlow[dIdx] ? (dEmaFast[dIdx] > dEmaSlow[dIdx] ? 1 : -1) : 0;
    const wT = wIdx > 0 && wEmaFast[wIdx] && wEmaSlow[wIdx] ? (wEmaFast[wIdx] > wEmaSlow[wIdx] ? 1 : -1) : 0;
    const mT = mIdx > 0 && mEmaFast[mIdx] && mEmaSlow[mIdx] ? (mEmaFast[mIdx] > mEmaSlow[mIdx] ? 1 : -1) : 0;
    const bullCount = [dT, wT, mT].filter((t) => t === 1).length;
    const bearCount = [dT, wT, mT].filter((t) => t === -1).length;
    return {
      htfBullish: bullCount >= s.htfMinAgree, htfBearish: bearCount >= s.htfMinAgree,
      htfConflict: s.htfStrict && bullCount > 0 && bearCount > 0,
    };
  }

  const closes = ltfCandles.map((c) => c.close);
  const highs = ltfCandles.map((c) => c.high);
  const lows = ltfCandles.map((c) => c.low);
  const volumes = ltfCandles.map((c) => c.volume);

  const vwapValues = ind.vwap(ltfCandles);
  const st = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const stochRsi = ind.stochRsi(closes, s.rsiLen, s.stochLen, s.stochK, s.stochD);
  const atrValues = ind.atr(highs, lows, closes, 14);
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const volSma = ind.sma(volumes, s.volSmaLen);

  const trades = [];
  let position = null;
  let longTriggered = false, shortTriggered = false;
  let barsSinceLoss = 999, barsSinceClose = 999;
  let equity = 1000;
  const equityCurve = [];
  const COMMISSION = 0.0004;

  function isSessionOk(timestamp) {
    if (!s.useSessionFilter) return true;
    const hour = new Date(timestamp).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) { if (hour >= s.sessionSkipStart || hour < s.sessionSkipEnd) return false; }
    else { if (hour >= s.sessionSkipStart && hour < s.sessionSkipEnd) return false; }
    if (s.sessionSkipHours && s.sessionSkipHours.includes(hour)) return false;
    return true;
  }
  function isDowOk(timestamp) {
    if (!s.useDowFilter) return true;
    const dow = new Date(timestamp).getUTCDay();
    return !s.skipDays || !s.skipDays.includes(dow);
  }

  function closeTrade(pos, exitPrice, barIdx, reason) {
    const isLong = pos.side === "Buy";
    const pnlPct = isLong
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeMultiplier
      : ((pos.entryPrice - exitPrice) / pos.entryPrice) * pos.sizeMultiplier;
    const rMultiple = isLong ? (exitPrice - pos.entryPrice) / pos.entryAtr : (pos.entryPrice - exitPrice) / pos.entryAtr;
    equity += equity * pnlPct;
    equity -= equity * COMMISSION;
    trades.push({ pnlPct: pnlPct * 100, rMultiple, reason });
    if (pnlPct < 0) barsSinceLoss = 0;
    barsSinceClose = 0;
    longTriggered = false; shortTriggered = false;
    position = null;
  }

  const warmup = 60;
  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i]; const high = highs[i]; const low = lows[i]; const ts = ltfCandles[i].timestamp;
    const mtf = getMtfTrend(ts);
    const aboveVwap = price > vwapValues[i]; const belowVwap = price < vwapValues[i];
    const stBullish = st.direction[i] === -1; const stBearish = st.direction[i] === 1;
    const stFlipBear = i > 0 && st.direction[i] === 1 && st.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st.direction[i] === -1 && st.direction[i - 1] === 1;
    const kCrossUp = ind.crossover(stochRsi.k, stochRsi.d, i);
    const kCrossDown = ind.crossunder(stochRsi.k, stochRsi.d, i);
    const stochLongOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] < s.osLevel;
    const stochShortOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] > (100 - s.osLevel);
    const adxOk = !s.useAdx || (dmiResult.adx[i] !== null && dmiResult.adx[i] > s.adxThresh);
    const diLongOk = !s.useDi || dmiResult.diPlus[i] > dmiResult.diMinus[i];
    const diShortOk = !s.useDi || dmiResult.diMinus[i] > dmiResult.diPlus[i];
    const volAboveMin = !s.useVol || volumes[i] > volSma[i] * s.volMult;
    const volBelowMax = !s.volMaxMult || volumes[i] <= volSma[i] * s.volMaxMult;
    const volOk = volAboveMin && volBelowMax;
    const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
    const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;

    if (stFlipBear) longTriggered = false;
    if (stFlipBull) shortTriggered = false;

    // Exits (15m high/low)
    if (position) {
      const isLong = position.side === "Buy";
      const barsHeld = i - position.entryBar;
      if (isLong) position.highest = Math.max(position.highest, high);
      else position.lowest = Math.min(position.lowest, low);

      let exited = false;
      if (isLong && low <= position.sl) { closeTrade(position, Math.max(position.sl, low), i, "SL"); exited = true; }
      else if (!isLong && high >= position.sl) { closeTrade(position, Math.min(position.sl, high), i, "SL"); exited = true; }
      else if (isLong && high >= position.tp) { closeTrade(position, Math.min(position.tp, high), i, "TP"); exited = true; }
      else if (!isLong && low <= position.tp) { closeTrade(position, Math.max(position.tp, low), i, "TP"); exited = true; }

      if (!exited && s.usePartial && position.partialLevel < 1) {
        if ((isLong && high >= position.partial1) || (!isLong && low <= position.partial1)) {
          const exitP = position.partial1;
          const pp = isLong ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial1Pct : ((position.entryPrice - exitP) / position.entryPrice) * s.partial1Pct;
          equity += equity * pp - equity * COMMISSION * 2 * s.partial1Pct;
          position.partialLevel = 1; position.sizeMultiplier -= s.partial1Pct;
        }
      }
      if (!exited && s.usePartial && position.partialLevel === 1) {
        if ((isLong && high >= position.partial2) || (!isLong && low <= position.partial2)) {
          const exitP = position.partial2;
          const pp = isLong ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial2Pct : ((position.entryPrice - exitP) / position.entryPrice) * s.partial2Pct;
          equity += equity * pp - equity * COMMISSION * 2 * s.partial2Pct;
          position.partialLevel = 2; position.sizeMultiplier -= s.partial2Pct;
          position.sl = position.entryPrice;
        }
      }
      if (!exited && s.useTrailRest && position.partialLevel >= 1) {
        const uR = isLong ? (price - position.entryPrice) / position.entryAtr : (position.entryPrice - price) / position.entryAtr;
        if (uR >= s.trailBeR) {
          if (isLong) position.sl = Math.max(position.sl, position.entryPrice);
          else position.sl = Math.min(position.sl, position.entryPrice);
        }
        if (uR >= s.trailStartR) {
          if (isLong) { const tsl = Math.max(position.entryPrice, position.highest - position.entryAtr * s.trailAtrMult); position.sl = Math.max(position.sl, tsl); }
          else { const tsl = Math.min(position.entryPrice, position.lowest + position.entryAtr * s.trailAtrMult); position.sl = Math.min(position.sl, tsl); }
        }
      }
      if (!exited && s.maxBarsTrade > 0 && barsHeld >= s.maxBarsTrade) { closeTrade(position, price, i, "MaxDur"); }
      if (!exited && isLong && stFlipBear) {
        const uR = (price - position.entryPrice) / position.entryAtr;
        if (s.beOnStFlip && uR > 0) position.sl = Math.max(position.sl, position.entryPrice);
        else if (uR <= 0) closeTrade(position, price, i, "STFlip");
      }
      if (!exited && position && !isLong && stFlipBull) {
        const uR = (position.entryPrice - price) / position.entryAtr;
        if (s.beOnStFlip && uR > 0) position.sl = Math.min(position.sl, position.entryPrice);
        else if (uR <= 0) closeTrade(position, price, i, "STFlip");
      }
    }

    // Entries
    if (!position) {
      barsSinceClose++; barsSinceLoss++;
      const atrVal = atrValues[i]; if (!atrVal) continue;
      const sessionOk = isSessionOk(ts); const dowOk = isDowOk(ts);
      const longSig = aboveVwap && stBullish && kCrossUp && stochLongOk && adxOk && diLongOk && volOk && mtf.htfBullish && !mtf.htfConflict && cooldownOk && reentryOk && !longTriggered && sessionOk && dowOk;
      const shortSig = belowVwap && stBearish && kCrossDown && stochShortOk && adxOk && diShortOk && volOk && mtf.htfBearish && !mtf.htfConflict && cooldownOk && reentryOk && !shortTriggered && sessionOk && dowOk;

      if (longSig) {
        position = { side: "Buy", entryPrice: price, entryAtr: atrVal, sl: price - atrVal * s.slMult, tp: price + atrVal * s.tpMult, partial1: price + atrVal * s.partial1Mult, partial2: price + atrVal * s.partial2Mult, partialLevel: 0, entryBar: i, highest: price, lowest: price, sizeMultiplier: 1 };
        longTriggered = true; equity -= equity * COMMISSION;
      } else if (shortSig) {
        position = { side: "Sell", entryPrice: price, entryAtr: atrVal, sl: price + atrVal * s.slMult, tp: price - atrVal * s.tpMult, partial1: price - atrVal * s.partial1Mult, partial2: price - atrVal * s.partial2Mult, partialLevel: 0, entryBar: i, highest: price, lowest: price, sizeMultiplier: 1 };
        shortTriggered = true; equity -= equity * COMMISSION;
      }
    }
    equityCurve.push({ equity });
  }

  // Stats
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const pf = losses.length > 0 ? Math.abs(wins.reduce((s, t) => s + t.pnlPct, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0)) : wins.length > 0 ? 99 : 0;
  let peak = 1000, maxDD = 0;
  for (const pt of equityCurve) { if (pt.equity > peak) peak = pt.equity; const dd = ((peak - pt.equity) / peak) * 100; if (dd > maxDD) maxDD = dd; }

  return {
    symbol, trades: trades.length, wins: wins.length, losses: losses.length,
    winRate, pnl: ((equity / 1000 - 1) * 100), maxDD, pf,
    candles: ltfCandles.length,
  };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function main() {
  const months = parseInt(process.argv[2] || "12");
  const tf = parseInt(process.argv[3] || "15");

  // Get top 50 by volume
  console.log("Fetching top 50 USDT perpetual pairs by 24h volume...\n");
  const { result } = await client.getTickers({ category: "linear" });
  const pairs = result.list
    .filter((t) => t.symbol.endsWith("USDT") && !t.symbol.includes("PERP"))
    .map((t) => ({ symbol: t.symbol, vol: parseFloat(t.turnover24h) }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 50)
    .map((t) => t.symbol);

  console.log(`Testing ${pairs.length} pairs over ${months} months on ${tf}m...\n`);

  const results = [];
  for (let i = 0; i < pairs.length; i++) {
    const sym = pairs[i];
    process.stdout.write(`[${i + 1}/${pairs.length}] ${sym.padEnd(16)} `);
    try {
      const r = await fastBacktest(sym, tf, months);
      if (r && r.trades >= 5) {
        results.push(r);
        console.log(`PnL: ${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(1)}%  WR: ${r.winRate.toFixed(0)}%  PF: ${r.pf.toFixed(2)}  Trades: ${r.trades}  DD: ${r.maxDD.toFixed(1)}%`);
      } else {
        console.log(r ? `Skipped (${r.trades} trades < 5)` : "Skipped (no data)");
      }
    } catch (err) {
      console.log(`Error: ${err.message}`);
    }
  }

  // Sort by PnL
  results.sort((a, b) => b.pnl - a.pnl);

  console.log("\n" + "=".repeat(90));
  console.log(`  TOP 50 SCAN — ${tf}m — ${months} months — sorted by PnL`);
  console.log("=".repeat(90));
  console.log(`  ${"#".padEnd(4)} ${"Symbol".padEnd(16)} ${"PnL%".padEnd(9)} ${"WR%".padEnd(7)} ${"PF".padEnd(7)} ${"Trades".padEnd(8)} ${"W/L".padEnd(8)} ${"MaxDD%".padEnd(9)} Candles`);
  console.log(`  ${"─".repeat(86)}`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const pnlStr = `${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(1)}%`;
    console.log(
      `  ${String(i + 1).padEnd(4)} ${r.symbol.padEnd(16)} ${pnlStr.padEnd(9)} ${r.winRate.toFixed(1).padEnd(7)} ${r.pf.toFixed(2).padEnd(7)} ${String(r.trades).padEnd(8)} ${(r.wins + "/" + r.losses).padEnd(8)} ${r.maxDD.toFixed(1).padEnd(9)} ${r.candles}`
    );
  }
  console.log("=".repeat(90));
}

main().catch((err) => { console.error("Scan failed:", err.message); process.exit(1); });
