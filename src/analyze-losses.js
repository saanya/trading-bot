/**
 * Deep analysis of backtest trades — identifies patterns in losses
 * Usage: node analyze-losses.js SYMBOL MONTHS TF
 */
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
    } catch (err) { break; }
    if (!result || !result.list || result.list.length === 0) break;
    const candles = result.list.map((c) => ({
      timestamp: parseInt(c[0]), open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
    })).reverse();
    if (candles.length === 0) break;
    all.push(...candles);
    const lastTs = candles[candles.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise((r) => setTimeout(r, 200));
  }
  const seen = new Set();
  return all.filter((c) => { if (seen.has(c.timestamp)) return false; seen.add(c.timestamp); return true; });
}

async function analyze(symbol, tfMinutes, months) {
  const now = Date.now();
  const startTime = now - months * 30 * 24 * 60 * 60 * 1000;
  const interval = String(tfMinutes);

  console.log(`Fetching ${symbol} data (${months} months)...\n`);

  const [ltfCandles, dCandles, wCandles, mCandles] = await Promise.all([
    fetchAllCandles(symbol, interval, startTime, now),
    fetchAllCandles(symbol, "D", startTime - 120 * 86400000, now),
    fetchAllCandles(symbol, "W", startTime - 365 * 86400000, now),
    fetchAllCandles(symbol, "M", startTime - 730 * 86400000, now),
  ]);

  // Pre-compute HTF EMAs
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
      daily: dT, weekly: wT, monthly: mT,
      trendScore: dT + wT + mT,
      htfBullish: bullCount >= s.htfMinAgree,
      htfBearish: bearCount >= s.htfMinAgree,
      htfConflict: s.htfStrict && bullCount > 0 && bearCount > 0,
      fullConfluence: bullCount === 3 || bearCount === 3,
      bullCount, bearCount,
    };
  }

  // Pre-compute LTF indicators
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

  // Run simulation capturing extra data per trade
  const trades = [];
  let position = null;
  let longTriggered = false;
  let shortTriggered = false;
  let barsSinceLoss = 999;
  let barsSinceClose = 999;
  let equity = 1000;
  const COMMISSION = 0.0004;
  const warmup = 60;

  function isSessionOk(timestamp) {
    if (!s.useSessionFilter) return true;
    const hour = new Date(timestamp).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) {
      return !(hour >= s.sessionSkipStart || hour < s.sessionSkipEnd);
    }
    return !(hour >= s.sessionSkipStart && hour < s.sessionSkipEnd);
  }

  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i];
    const high = highs[i];
    const low = lows[i];
    const ts = ltfCandles[i].timestamp;
    const mtf = getMtfTrend(ts);
    const aboveVwap = price > vwapValues[i];
    const belowVwap = price < vwapValues[i];
    const stBullish = st.direction[i] === -1;
    const stBearish = st.direction[i] === 1;
    const stFlipBear = i > 0 && st.direction[i] === 1 && st.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st.direction[i] === -1 && st.direction[i - 1] === 1;
    const kCrossUp = ind.crossover(stochRsi.k, stochRsi.d, i);
    const kCrossDown = ind.crossunder(stochRsi.k, stochRsi.d, i);
    const stochLongOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] < s.osLevel;
    const stochShortOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] > (100 - s.osLevel);
    const adxVal = dmiResult.adx[i];
    const adxOk = !s.useAdx || (adxVal !== null && adxVal > s.adxThresh);
    const diLongOk = !s.useDi || dmiResult.diPlus[i] > dmiResult.diMinus[i];
    const diShortOk = !s.useDi || dmiResult.diMinus[i] > dmiResult.diPlus[i];
    const volOk = !s.useVol || volumes[i] > volSma[i] * s.volMult;
    const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
    const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;

    if (stFlipBear) longTriggered = false;
    if (stFlipBull) shortTriggered = false;

    if (position) {
      const isLong = position.side === "Buy";
      const barsHeld = i - position.entryBar;
      const unrealizedR = isLong
        ? (price - position.entryPrice) / position.entryAtr
        : (position.entryPrice - price) / position.entryAtr;
      const inProfit = unrealizedR > 0;
      let exitReason = null;

      if (isLong) position.highest = Math.max(position.highest, high);
      else position.lowest = Math.min(position.lowest, low);

      if (isLong && low <= position.sl) {
        exitReason = "Stop Loss";
        closeTrade(position, Math.max(position.sl, low), i, exitReason);
      } else if (!isLong && high >= position.sl) {
        exitReason = "Stop Loss";
        closeTrade(position, Math.min(position.sl, high), i, exitReason);
      } else if (isLong && high >= position.tp) {
        exitReason = "Take Profit";
        closeTrade(position, Math.min(position.tp, high), i, exitReason);
      } else if (!isLong && low <= position.tp) {
        exitReason = "Take Profit";
        closeTrade(position, Math.max(position.tp, low), i, exitReason);
      }

      if (!exitReason && s.usePartial && position.partialLevel < 1) {
        if ((isLong && high >= position.partial1) || (!isLong && low <= position.partial1)) {
          const exitP = position.partial1;
          const partialPnl = isLong
            ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial1Pct
            : ((position.entryPrice - exitP) / position.entryPrice) * s.partial1Pct;
          equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial1Pct;
          position.partialLevel = 1;
          position.sizeMultiplier -= s.partial1Pct;
        }
      }
      if (!exitReason && s.usePartial && position.partialLevel === 1) {
        if ((isLong && high >= position.partial2) || (!isLong && low <= position.partial2)) {
          const exitP = position.partial2;
          const partialPnl = isLong
            ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial2Pct
            : ((position.entryPrice - exitP) / position.entryPrice) * s.partial2Pct;
          equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial2Pct;
          position.partialLevel = 2;
          position.sizeMultiplier -= s.partial2Pct;
          position.sl = position.entryPrice;
        }
      }
      if (!exitReason && s.useTrailRest && position.partialLevel >= 1) {
        if (unrealizedR >= s.trailBeR) {
          if (isLong) position.sl = Math.max(position.sl, position.entryPrice);
          else position.sl = Math.min(position.sl, position.entryPrice);
        }
        if (unrealizedR >= s.trailStartR) {
          if (isLong) {
            const trailSl = Math.max(position.entryPrice, position.highest - position.entryAtr * s.trailAtrMult);
            position.sl = Math.max(position.sl, trailSl);
          } else {
            const trailSl = Math.min(position.entryPrice, position.lowest + position.entryAtr * s.trailAtrMult);
            position.sl = Math.min(position.sl, trailSl);
          }
        }
      }
      if (!exitReason && s.maxBarsTrade > 0 && barsHeld >= s.maxBarsTrade) {
        exitReason = "Max Duration";
        closeTrade(position, price, i, exitReason);
      }
      if (!exitReason && isLong && stFlipBear) {
        if (s.beOnStFlip && inProfit) position.sl = Math.max(position.sl, position.entryPrice);
        else if (!inProfit) { exitReason = "ST Flip"; closeTrade(position, price, i, exitReason); }
      }
      if (!exitReason && !isLong && stFlipBull) {
        if (s.beOnStFlip && inProfit) position.sl = Math.min(position.sl, position.entryPrice);
        else if (!inProfit) { exitReason = "ST Flip"; closeTrade(position, price, i, exitReason); }
      }
    }

    if (!position) {
      barsSinceClose++;
      barsSinceLoss++;
      const atrVal = atrValues[i];
      if (!atrVal) continue;
      const sessionOk = isSessionOk(ts);

      const longSig = aboveVwap && stBullish && kCrossUp && stochLongOk && adxOk && diLongOk && volOk
        && mtf.htfBullish && !mtf.htfConflict && cooldownOk && reentryOk && !longTriggered && sessionOk;
      const shortSig = belowVwap && stBearish && kCrossDown && stochShortOk && adxOk && diShortOk && volOk
        && mtf.htfBearish && !mtf.htfConflict && cooldownOk && reentryOk && !shortTriggered && sessionOk;

      if (longSig || shortSig) {
        const side = longSig ? "Buy" : "Sell";
        const atrMult = longSig ? 1 : -1;
        position = {
          side,
          entryPrice: price,
          entryAtr: atrVal,
          sl: price - atrMult * atrVal * s.slMult,
          tp: price + atrMult * atrVal * s.tpMult,
          partial1: price + atrMult * atrVal * s.partial1Mult,
          partial2: price + atrMult * atrVal * s.partial2Mult,
          partialLevel: 0,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: 1,
          entryTimestamp: ts,
          // Extra analysis data
          entryAdx: adxVal,
          entryStochK: stochRsi.k[i],
          entryVolRatio: volSma[i] > 0 ? volumes[i] / volSma[i] : 1,
          entryMtfScore: mtf.trendScore,
          entryMtfFull: mtf.fullConfluence,
          entryDiPlus: dmiResult.diPlus[i],
          entryDiMinus: dmiResult.diMinus[i],
          entryVwapDist: ((price - vwapValues[i]) / vwapValues[i]) * 100,
        };
        if (longSig) longTriggered = true;
        else shortTriggered = true;
        equity -= equity * COMMISSION;
      }
    }
  }

  function closeTrade(pos, exitPrice, barIdx, reason) {
    const isLong = pos.side === "Buy";
    const pnlPct = isLong
      ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * pos.sizeMultiplier
      : ((pos.entryPrice - exitPrice) / pos.entryPrice) * pos.sizeMultiplier;
    const rMultiple = isLong
      ? (exitPrice - pos.entryPrice) / pos.entryAtr
      : (pos.entryPrice - exitPrice) / pos.entryAtr;

    equity += equity * pnlPct;
    equity -= equity * COMMISSION;

    const entryHour = new Date(pos.entryTimestamp).getUTCHours();
    const entryDow = new Date(pos.entryTimestamp).getUTCDay();
    const entryMonth = new Date(pos.entryTimestamp).toISOString().slice(0, 7);

    trades.push({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnlPct: pnlPct * 100,
      rMultiple,
      barsHeld: barIdx - pos.entryBar,
      reason,
      partialLevel: pos.partialLevel,
      entryTime: new Date(pos.entryTimestamp).toISOString(),
      exitTime: new Date(ltfCandles[barIdx].timestamp).toISOString(),
      entryHour,
      entryDow,
      entryMonth,
      entryAdx: pos.entryAdx,
      entryStochK: pos.entryStochK,
      entryVolRatio: pos.entryVolRatio,
      entryMtfScore: pos.entryMtfScore,
      entryMtfFull: pos.entryMtfFull,
      entryDiPlus: pos.entryDiPlus,
      entryDiMinus: pos.entryDiMinus,
      entryVwapDist: pos.entryVwapDist,
      win: pnlPct > 0,
    });

    if (pnlPct < 0) barsSinceLoss = 0;
    barsSinceClose = 0;
    longTriggered = false;
    shortTriggered = false;
    position = null;
  }

  // ─── DEEP ANALYSIS ─────────────────────────────────────────────────────────

  const wins = trades.filter((t) => t.win);
  const losses = trades.filter((t) => !t.win);

  console.log("=".repeat(70));
  console.log("  LOSS ANALYSIS — " + symbol + " " + tfMinutes + "m — " + months + " months");
  console.log("=".repeat(70));
  console.log(`\n  Total: ${trades.length} trades | ${wins.length} wins | ${losses.length} losses | WR: ${(wins.length/trades.length*100).toFixed(1)}%`);

  // 1. By Side
  console.log("\n  ─── BY SIDE ───────────────────────────────────────────");
  for (const side of ["Buy", "Sell"]) {
    const st = trades.filter((t) => t.side === side);
    const sw = st.filter((t) => t.win);
    const avgPnl = st.length > 0 ? st.reduce((s, t) => s + t.pnlPct, 0) / st.length : 0;
    console.log(`  ${side === "Buy" ? "LONG " : "SHORT"}: ${st.length} trades | ${sw.length} wins (${(sw.length/st.length*100||0).toFixed(0)}% WR) | avg PnL: ${avgPnl.toFixed(2)}%`);
  }

  // 2. By Entry Hour
  console.log("\n  ─── BY ENTRY HOUR (UTC) ───────────────────────────────");
  const hourBuckets = {};
  for (const t of trades) {
    const h = t.entryHour;
    if (!hourBuckets[h]) hourBuckets[h] = { total: 0, wins: 0, pnl: 0 };
    hourBuckets[h].total++;
    if (t.win) hourBuckets[h].wins++;
    hourBuckets[h].pnl += t.pnlPct;
  }
  const sortedHours = Object.keys(hourBuckets).sort((a, b) => a - b);
  for (const h of sortedHours) {
    const b = hourBuckets[h];
    const wr = (b.wins / b.total * 100).toFixed(0);
    const bar = b.pnl >= 0 ? "+".repeat(Math.min(20, Math.round(b.pnl * 2))) : "-".repeat(Math.min(20, Math.round(Math.abs(b.pnl) * 2)));
    console.log(`  ${String(h).padStart(2, "0")}:00  ${String(b.total).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${b.pnl >= 0 ? "+" : ""}${b.pnl.toFixed(2).padStart(7)}%  ${b.pnl >= 0 ? "🟩" : "🟥"} ${bar}`);
  }

  // 3. By Day of Week
  console.log("\n  ─── BY DAY OF WEEK ───────────────────────────────────");
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowBuckets = {};
  for (const t of trades) {
    const d = t.entryDow;
    if (!dowBuckets[d]) dowBuckets[d] = { total: 0, wins: 0, pnl: 0 };
    dowBuckets[d].total++;
    if (t.win) dowBuckets[d].wins++;
    dowBuckets[d].pnl += t.pnlPct;
  }
  for (let d = 0; d < 7; d++) {
    const b = dowBuckets[d];
    if (!b) continue;
    const wr = (b.wins / b.total * 100).toFixed(0);
    console.log(`  ${dayNames[d]}  ${String(b.total).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${b.pnl >= 0 ? "+" : ""}${b.pnl.toFixed(2).padStart(7)}%`);
  }

  // 4. By Month
  console.log("\n  ─── BY MONTH ─────────────────────────────────────────");
  const monthBuckets = {};
  for (const t of trades) {
    const m = t.entryMonth;
    if (!monthBuckets[m]) monthBuckets[m] = { total: 0, wins: 0, pnl: 0 };
    monthBuckets[m].total++;
    if (t.win) monthBuckets[m].wins++;
    monthBuckets[m].pnl += t.pnlPct;
  }
  for (const m of Object.keys(monthBuckets).sort()) {
    const b = monthBuckets[m];
    const wr = (b.wins / b.total * 100).toFixed(0);
    console.log(`  ${m}  ${String(b.total).padStart(3)} trades  WR: ${wr.padStart(3)}%  PnL: ${b.pnl >= 0 ? "+" : ""}${b.pnl.toFixed(2).padStart(7)}%`);
  }

  // 5. ADX at Entry — winners vs losers
  console.log("\n  ─── ADX AT ENTRY ─────────────────────────────────────");
  const adxRanges = [[0, 20], [20, 30], [30, 40], [40, 60], [60, 100]];
  for (const [lo, hi] of adxRanges) {
    const group = trades.filter((t) => t.entryAdx >= lo && t.entryAdx < hi);
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  ADX ${lo}-${hi}:  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    }
  }

  // 6. Volume Ratio at Entry
  console.log("\n  ─── VOLUME RATIO AT ENTRY ────────────────────────────");
  const volRanges = [[1.0, 1.5], [1.5, 2.0], [2.0, 3.0], [3.0, 100]];
  for (const [lo, hi] of volRanges) {
    const group = trades.filter((t) => t.entryVolRatio >= lo && t.entryVolRatio < hi);
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  Vol ${lo.toFixed(1)}x-${hi.toFixed(1)}x:  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    }
  }

  // 7. MTF Trend Score at Entry
  console.log("\n  ─── MTF TREND SCORE AT ENTRY ─────────────────────────");
  for (const score of [-3, -2, 2, 3]) {
    const group = trades.filter((t) => t.entryMtfScore === score);
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  Score ${score >= 0 ? "+" : ""}${score}:  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%  (full: ${group.filter(t=>t.entryMtfFull).length})`);
    }
  }

  // 8. VWAP Distance at Entry
  console.log("\n  ─── VWAP DISTANCE AT ENTRY ───────────────────────────");
  const vwapRanges = [[0, 0.1], [0.1, 0.3], [0.3, 0.5], [0.5, 1.0], [1.0, 100]];
  for (const [lo, hi] of vwapRanges) {
    const group = trades.filter((t) => Math.abs(t.entryVwapDist) >= lo && Math.abs(t.entryVwapDist) < hi);
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  |VWAP| ${lo.toFixed(1)}-${hi.toFixed(1)}%:  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    }
  }

  // 9. DI Spread at Entry
  console.log("\n  ─── DI SPREAD AT ENTRY (|DI+ - DI-|) ────────────────");
  const diRanges = [[0, 5], [5, 10], [10, 20], [20, 100]];
  for (const [lo, hi] of diRanges) {
    const group = trades.filter((t) => {
      const spread = Math.abs(t.entryDiPlus - t.entryDiMinus);
      return spread >= lo && spread < hi;
    });
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  DI spread ${lo}-${hi}:  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    }
  }

  // 10. Loss streaks timeline
  console.log("\n  ─── LOSS STREAKS (3+ consecutive) ────────────────────");
  let streak = 0;
  let streakStart = null;
  for (let j = 0; j < trades.length; j++) {
    if (!trades[j].win) {
      if (streak === 0) streakStart = j;
      streak++;
    } else {
      if (streak >= 3) {
        const first = trades[streakStart];
        const last = trades[streakStart + streak - 1];
        const streakPnl = trades.slice(streakStart, streakStart + streak).reduce((s, t) => s + t.pnlPct, 0);
        console.log(`  ${streak} losses: ${first.entryTime.slice(0, 10)} → ${last.exitTime.slice(0, 10)} | PnL: ${streakPnl.toFixed(2)}% | sides: ${trades.slice(streakStart, streakStart + streak).map(t => t.side === "Buy" ? "L" : "S").join("")}`);
      }
      streak = 0;
    }
  }
  if (streak >= 3) {
    const first = trades[streakStart];
    const last = trades[streakStart + streak - 1];
    const streakPnl = trades.slice(streakStart, streakStart + streak).reduce((s, t) => s + t.pnlPct, 0);
    console.log(`  ${streak} losses: ${first.entryTime.slice(0, 10)} → ${last.exitTime.slice(0, 10)} | PnL: ${streakPnl.toFixed(2)}% | sides: ${trades.slice(streakStart, streakStart + streak).map(t => t.side === "Buy" ? "L" : "S").join("")}`);
  }

  // 11. Breakeven trades (partials saved but final exit at SL)
  console.log("\n  ─── PARTIAL TP EFFECT ─────────────────────────────────");
  const withPartials = trades.filter((t) => t.partialLevel > 0);
  const withoutPartials = trades.filter((t) => t.partialLevel === 0);
  const wpWins = withPartials.filter((t) => t.win);
  const woWins = withoutPartials.filter((t) => t.win);
  console.log(`  With partials:    ${withPartials.length} trades | WR: ${(wpWins.length/withPartials.length*100||0).toFixed(0)}% | avg PnL: ${(withPartials.reduce((s,t)=>s+t.pnlPct,0)/withPartials.length||0).toFixed(2)}%`);
  console.log(`  Without partials: ${withoutPartials.length} trades | WR: ${(woWins.length/withoutPartials.length*100||0).toFixed(0)}% | avg PnL: ${(withoutPartials.reduce((s,t)=>s+t.pnlPct,0)/withoutPartials.length||0).toFixed(2)}%`);

  // 12. Bars held — winners vs losers
  console.log("\n  ─── TRADE DURATION (BARS HELD) ───────────────────────");
  const durRanges = [[1, 3], [3, 6], [6, 12], [12, 20], [20, 40]];
  for (const [lo, hi] of durRanges) {
    const group = trades.filter((t) => t.barsHeld >= lo && t.barsHeld < hi);
    const gw = group.filter((t) => t.win);
    const avgPnl = group.length > 0 ? group.reduce((s, t) => s + t.pnlPct, 0) / group.length : 0;
    if (group.length > 0) {
      console.log(`  ${lo}-${hi} bars (${(lo*tfMinutes/60).toFixed(1)}-${(hi*tfMinutes/60).toFixed(1)}h):  ${String(group.length).padStart(3)} trades  WR: ${(gw.length/group.length*100).toFixed(0).padStart(3)}%  avg PnL: ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`);
    }
  }

  console.log("\n" + "=".repeat(70) + "\n");
}

const symbol = process.argv[2] || "DOGEUSDT";
const months = parseInt(process.argv[3] || "12");
const tf = parseInt(process.argv[4] || "15");

analyze(symbol, tf, months).catch((err) => {
  console.error("Analysis failed:", err.message);
  process.exit(1);
});
