/**
 * ORB Strategy Scanner — tests current config across multiple pairs
 * Usage: node src/strategies/orb/scan.js [months] [pairs...]
 * Example: node src/strategies/orb/scan.js 3
 */

const { RestClientV5 } = require("bybit-api");
const ind = require("../../common/indicators");
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
    } catch (err) { break; }
    if (!result || !result.list || result.list.length === 0) break;
    const candles = result.list.map(c => ({
      timestamp: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    })).reverse();
    if (candles.length === 0) break;
    all.push(...candles);
    const lastTs = candles[candles.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise(r => setTimeout(r, 150));
  }
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; });
}

async function scanPair(symbol, months) {
  const now = Date.now();
  const startTime = now - months * 30 * 86400000;
  const tfMinutes = 5;
  const trendTf = s.trendTf || "15";

  const [ltfCandles, oneMinCandles, trendCandles] = await Promise.all([
    fetchAllCandles(symbol, "5", startTime, now),
    fetchAllCandles(symbol, "1", startTime, now),
    fetchAllCandles(symbol, trendTf, startTime - 30 * 86400000, now),
  ]);

  if (ltfCandles.length < 500) return null; // not enough data

  const barMs = tfMinutes * 60000;
  const minutesByBar = new Map();
  for (const c of oneMinCandles) {
    const barTs = Math.floor(c.timestamp / barMs) * barMs;
    if (!minutesByBar.has(barTs)) minutesByBar.set(barTs, []);
    minutesByBar.get(barTs).push(c);
  }

  // Pre-compute indicators
  const trendHighs = trendCandles.map(c => c.high);
  const trendLows = trendCandles.map(c => c.low);
  const trendCloses = trendCandles.map(c => c.close);
  const trendSt = ind.supertrend(trendHighs, trendLows, trendCloses, s.stAtrLen, s.stFactor);

  function getTrend(ts) {
    const idx = trendCandles.findLastIndex(c => c.timestamp < ts);
    if (idx < 1) return { bullish: false, bearish: false, age: 0 };
    const dir = trendSt.direction[idx];
    let age = 0;
    for (let j = idx; j >= 0; j--) { if (trendSt.direction[j] === dir) age++; else break; }
    return { bullish: dir === -1, bearish: dir === 1, age };
  }

  const closes = ltfCandles.map(c => c.close);
  const highs = ltfCandles.map(c => c.high);
  const lows = ltfCandles.map(c => c.low);
  const volumes = ltfCandles.map(c => c.volume);

  const st5m = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const atrValues = ind.atr(highs, lows, closes, 14);
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const volSma = ind.sma(volumes, s.volSmaLen);

  // Session tracking
  const sessionHours = Array.isArray(s.sessionStartHour) ? s.sessionStartHour : [s.sessionStartHour];
  function getSessionId(ts) {
    const d = new Date(ts);
    let bestStartTs = 0, bestHour = sessionHours[0];
    for (const hour of sessionHours) {
      const candidate = new Date(d);
      candidate.setUTCHours(hour, 0, 0, 0);
      if (candidate.getTime() > ts) candidate.setUTCDate(candidate.getUTCDate() - 1);
      if (candidate.getTime() > bestStartTs) { bestStartTs = candidate.getTime(); bestHour = hour; }
    }
    return new Date(bestStartTs).toISOString().slice(0, 10) + "T" + String(bestHour).padStart(2, "0");
  }

  const sessionRanges = new Map();
  function getRange(barIndex) {
    const ts = ltfCandles[barIndex].timestamp;
    const sid = getSessionId(ts);
    if (!sessionRanges.has(sid)) sessionRanges.set(sid, { high: -Infinity, low: Infinity, barsCollected: 0, firstBarIdx: barIndex });
    const range = sessionRanges.get(sid);
    const barsInSession = barIndex - range.firstBarIdx;
    if (barsInSession < s.orbBars) {
      range.high = Math.max(range.high, highs[barIndex]);
      range.low = Math.min(range.low, lows[barIndex]);
      range.barsCollected = barsInSession + 1;
      return { high: range.high, low: range.low, width: range.high - range.low, established: false, sessionId: sid };
    }
    return { high: range.high, low: range.low, width: range.high - range.low, established: true, sessionId: sid };
  }

  // Simulation
  const trades = [];
  let position = null;
  let longTriggeredSession = "", shortTriggeredSession = "";
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

  const warmup = 60;
  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i];
    const high = highs[i];
    const low = lows[i];
    const ts = ltfCandles[i].timestamp;
    const trend = getTrend(ts);
    const range = getRange(i);
    const stFlipBear = i > 0 && st5m.direction[i] === 1 && st5m.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st5m.direction[i] === -1 && st5m.direction[i - 1] === 1;

    if (position) {
      const isLong = position.side === "Buy";
      const barsHeld = i - position.entryBar;
      let exitReason = null;
      const minuteCandles = minutesByBar.get(ts) || [];

      for (const mc of minuteCandles) {
        if (exitReason) break;
        const mHigh = mc.high, mLow = mc.low, mPrice = mc.close;
        if (isLong) position.highest = Math.max(position.highest, mHigh);
        else position.lowest = Math.min(position.lowest, mLow);
        const unrealizedR = isLong ? (mPrice - position.entryPrice) / position.entryAtr : (position.entryPrice - mPrice) / position.entryAtr;

        if (isLong && mLow <= position.sl) { exitReason = "SL"; closeTrade(position, Math.max(position.sl, mLow), i); break; }
        else if (!isLong && mHigh >= position.sl) { exitReason = "SL"; closeTrade(position, Math.min(position.sl, mHigh), i); break; }
        if (isLong && mHigh >= position.tp) { exitReason = "TP"; closeTrade(position, Math.min(position.tp, mHigh), i); break; }
        else if (!isLong && mLow <= position.tp) { exitReason = "TP"; closeTrade(position, Math.max(position.tp, mLow), i); break; }

        if (s.useTrailRest) {
          if (unrealizedR >= s.trailBeR) {
            if (isLong) position.sl = Math.max(position.sl, position.entryPrice);
            else position.sl = Math.min(position.sl, position.entryPrice);
          }
          if (unrealizedR >= s.trailStartR) {
            if (isLong) { const trailSl = Math.max(position.entryPrice, position.highest - position.entryAtr * s.trailAtrMult); position.sl = Math.max(position.sl, trailSl); }
            else { const trailSl = Math.min(position.entryPrice, position.lowest + position.entryAtr * s.trailAtrMult); position.sl = Math.min(position.sl, trailSl); }
          }
        }
      }

      if (minuteCandles.length === 0 && !exitReason) {
        if (isLong) position.highest = Math.max(position.highest, high);
        else position.lowest = Math.min(position.lowest, low);
        if (isLong && low <= position.sl) { closeTrade(position, Math.max(position.sl, low), i); exitReason = "SL"; }
        else if (!isLong && high >= position.sl) { closeTrade(position, Math.min(position.sl, high), i); exitReason = "SL"; }
        else if (isLong && high >= position.tp) { closeTrade(position, Math.min(position.tp, high), i); exitReason = "TP"; }
        else if (!isLong && low <= position.tp) { closeTrade(position, Math.max(position.tp, low), i); exitReason = "TP"; }
      }

      if (!exitReason && s.maxBarsTrade > 0 && barsHeld >= s.maxBarsTrade) { closeTrade(position, price, i); exitReason = "MaxDur"; }
      if (!exitReason && isLong && stFlipBear) {
        const ur = (price - position.entryPrice) / position.entryAtr;
        if (s.beOnStFlip && ur > 0) position.sl = Math.max(position.sl, position.entryPrice);
        else if (ur <= 0) { closeTrade(position, price, i); exitReason = "STFlip"; }
      }
      if (!exitReason && !isLong && stFlipBull) {
        const ur = (position.entryPrice - price) / position.entryAtr;
        if (s.beOnStFlip && ur > 0) position.sl = Math.min(position.sl, position.entryPrice);
        else if (ur <= 0) { closeTrade(position, price, i); exitReason = "STFlip"; }
      }
    }

    if (!position) {
      barsSinceClose++; barsSinceLoss++;
      const atrVal = atrValues[i];
      if (!atrVal || !range.established) continue;

      const sessionOk = isSessionOk(ts);
      const dowOk = isDowOk(ts);
      const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
      const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;
      const adxOk = !s.useAdx || (dmiResult.adx[i] !== null && dmiResult.adx[i] > s.adxThresh);
      const volOk = !s.useVol || volumes[i] > volSma[i] * s.volMult;
      const trendAgeOk = !s.minTrendAge || trend.age >= s.minTrendAge;
      const rangeOk = range.width >= atrVal * s.minRangeAtr && range.width <= atrVal * s.maxRangeAtr;

      const breakoutLong = rangeOk && price > range.high;
      const breakoutShort = rangeOk && price < range.low;

      const diConfirmOk = !s.diConfirm || (breakoutLong ? (dmiResult.diPlus[i] > dmiResult.diMinus[i]) : breakoutShort ? (dmiResult.diMinus[i] > dmiResult.diPlus[i]) : true);
      const stAlignOk = !s.stAlign || (breakoutLong ? st5m.direction[i] === -1 : breakoutShort ? st5m.direction[i] === 1 : true);

      const longSig = breakoutLong && trend.bullish && trendAgeOk && adxOk && volOk && cooldownOk && reentryOk
        && longTriggeredSession !== range.sessionId && sessionOk && dowOk && diConfirmOk && stAlignOk;
      const shortSig = breakoutShort && trend.bearish && trendAgeOk && adxOk && volOk && cooldownOk && reentryOk
        && shortTriggeredSession !== range.sessionId && sessionOk && dowOk && diConfirmOk && stAlignOk;

      if (longSig) {
        const rawSl = range.low - atrVal * s.slBuffer;
        const maxSl = price - atrVal * s.maxSlAtr;
        const sl = Math.max(rawSl, maxSl);
        const tp = price + range.width * s.tpRangeMult;
        position = { side: "Buy", entryPrice: price, entryAtr: atrVal, sl, tp, entryBar: i, highest: price, lowest: price, sizeMultiplier: 1, entryTimestamp: ts };
        longTriggeredSession = range.sessionId;
        equity -= equity * COMMISSION;
      } else if (shortSig) {
        const rawSl = range.high + atrVal * s.slBuffer;
        const maxSl = price + atrVal * s.maxSlAtr;
        const sl = Math.min(rawSl, maxSl);
        const tp = price - range.width * s.tpRangeMult;
        position = { side: "Sell", entryPrice: price, entryAtr: atrVal, sl, tp, entryBar: i, highest: price, lowest: price, sizeMultiplier: 1, entryTimestamp: ts };
        shortTriggeredSession = range.sessionId;
        equity -= equity * COMMISSION;
      }
    }
    equityCurve.push({ timestamp: ts, equity });
  }

  function closeTrade(pos, exitPrice, barIdx) {
    const isLong = pos.side === "Buy";
    const pnlPct = isLong ? ((exitPrice - pos.entryPrice) / pos.entryPrice) : ((pos.entryPrice - exitPrice) / pos.entryPrice);
    equity += equity * pnlPct;
    equity -= equity * COMMISSION;
    trades.push({ pnlPct: pnlPct * 100 });
    if (pnlPct < 0) barsSinceLoss = 0;
    barsSinceClose = 0;
    position = null;
  }

  // Compute stats
  const totalTrades = trades.length;
  if (totalTrades === 0) return null;

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = (wins.length / totalTrades) * 100;
  const profitFactor = losses.length > 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnlPct, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
    : wins.length > 0 ? Infinity : 0;

  let maxDrawdown = 0, peak = equityCurve[0]?.equity || 1000;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = ((peak - pt.equity) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const netPct = ((equity / 1000) - 1) * 100;

  return { symbol, trades: totalTrades, winRate, netPct, profitFactor, maxDrawdown, equity };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  const months = parseInt(process.argv[2] || "6");

  // Get top pairs by volume
  const https = require("https");
  const fetchTickers = () => new Promise((resolve, reject) => {
    https.get("https://api.bybit.com/v5/market/tickers?category=linear", res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
      res.on("error", reject);
    });
  });

  const tickerData = await fetchTickers();
  const skip = new Set(["XAUTUSDT", "XAGUSDT", "XAUUSDT"]); // commodities
  let pairs = tickerData.result.list
    .filter(t => t.symbol.endsWith("USDT") && !skip.has(t.symbol))
    .map(t => ({ symbol: t.symbol, vol: parseFloat(t.turnover24h) }))
    .sort((a, b) => b.vol - a.vol)
    .slice(0, 50)
    .map(t => t.symbol);

  // Allow CLI override
  const cliPairs = process.argv.slice(3).filter(a => !a.startsWith("--"));
  if (cliPairs.length > 0) pairs = cliPairs;

  console.log(`\nORB Scanner — ${months}m — ${pairs.length} pairs`);
  console.log(`Config: orbBars=${s.orbBars} tpMult=${s.tpRangeMult} adx=${s.adxThresh} trail=${s.trailBeR}/${s.trailStartR}/${s.trailAtrMult}`);
  console.log(`Filters: diConfirm=${s.diConfirm} stAlign=${s.stAlign} session=${s.useSessionFilter} dow=${s.skipDays}\n`);

  const results = [];
  const concurrency = 3;

  for (let i = 0; i < pairs.length; i += concurrency) {
    const batch = pairs.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(async (symbol) => {
      process.stdout.write(`  [${i + batch.indexOf(symbol) + 1}/${pairs.length}] ${symbol}...\r`);
      try {
        return await scanPair(symbol, months);
      } catch (err) {
        return null;
      }
    }));
    for (const r of batchResults) {
      if (r) {
        results.push(r);
        const flag = r.netPct > 10 && r.profitFactor > 1.3 ? " ***" : r.netPct > 0 ? " +" : "";
        console.log(`  ${r.symbol.padEnd(16)} ${r.netPct > 0 ? "+" : ""}${r.netPct.toFixed(1)}% PF ${r.profitFactor === Infinity ? "INF" : r.profitFactor.toFixed(2)} DD ${r.maxDrawdown.toFixed(1)}% WR ${r.winRate.toFixed(0)}% (${r.trades} trades)${flag}`);
      }
    }
  }

  // Sort by profit factor
  results.sort((a, b) => b.profitFactor - a.profitFactor);

  console.log("\n" + "=".repeat(70));
  console.log("  RESULTS RANKED BY PROFIT FACTOR");
  console.log("=".repeat(70));
  console.log("  " + "Symbol".padEnd(16) + "Net%".padEnd(10) + "PF".padEnd(8) + "DD%".padEnd(8) + "WR%".padEnd(8) + "Trades");
  console.log("  " + "-".repeat(56));

  for (const r of results) {
    const pf = r.profitFactor === Infinity ? "INF" : r.profitFactor.toFixed(2);
    const net = (r.netPct > 0 ? "+" : "") + r.netPct.toFixed(1) + "%";
    console.log(`  ${r.symbol.padEnd(16)} ${net.padEnd(10)} ${pf.padEnd(8)} ${r.maxDrawdown.toFixed(1).padEnd(8)} ${r.winRate.toFixed(0).padEnd(8)} ${r.trades}`);
  }

  // Highlight winners
  const winners = results.filter(r => r.netPct > 5 && r.profitFactor > 1.2 && r.maxDrawdown < 20);
  if (winners.length > 0) {
    console.log("\n  WINNERS (net>5%, PF>1.2, DD<20%):");
    for (const r of winners) {
      console.log(`    ${r.symbol} — +${r.netPct.toFixed(1)}% PF ${r.profitFactor.toFixed(2)} DD ${r.maxDrawdown.toFixed(1)}%`);
    }
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

main().catch(err => { console.error("Scanner failed:", err.message); process.exit(1); });
