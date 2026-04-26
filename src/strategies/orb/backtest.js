const { RestClientV5 } = require("bybit-api");
const ind = require("../../common/indicators");
const config = require("./config");

const s = config.strategy;

const client = new RestClientV5({ testnet: false });

// ─── FETCH HISTORICAL DATA ──────────────────────────────────────────────────

async function fetchAllCandles(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;

  while (cursor < endTime) {
    let result;
    try {
      const resp = await client.getKline({
        category: "linear",
        symbol,
        interval,
        start: cursor,
        limit: 1000,
      });
      result = resp.result;
    } catch (err) {
      console.error(`  API error for ${interval}: ${err.message}`);
      break;
    }

    if (!result || !result.list || result.list.length === 0) break;

    const candles = result.list
      .map((c) => ({
        timestamp: parseInt(c[0]),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5]),
      }))
      .reverse();

    if (candles.length === 0) break;
    all.push(...candles);

    const lastTs = candles[candles.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;

    process.stdout.write(`  ${interval}: ${all.length} candles\r`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  ${interval}: ${all.length} candles loaded`);

  const seen = new Set();
  return all.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
}

// ─── BACKTEST ENGINE ─────────────────────────────────────────────────────────

async function backtest(symbol, tfMinutes, months, riskMult = 1, qf = {}) {
  const now = Date.now();
  const startTime = now - months * 30 * 24 * 60 * 60 * 1000;
  const interval = String(tfMinutes);
  const trendTf = s.trendTf || "15";

  console.log(`\nFetching ${symbol} data (${months} months, ${interval}m + ${trendTf}m trend)...\n`);

  const [ltfCandles, oneMinCandles, trendCandles] = await Promise.all([
    fetchAllCandles(symbol, interval, startTime, now),
    fetchAllCandles(symbol, "1", startTime, now),
    fetchAllCandles(symbol, trendTf, startTime - 30 * 86400000, now),
  ]);

  // Build 1m candle lookup
  const barMs = tfMinutes * 60000;
  const minutesByBar = new Map();
  for (const c of oneMinCandles) {
    const barTs = Math.floor(c.timestamp / barMs) * barMs;
    if (!minutesByBar.has(barTs)) minutesByBar.set(barTs, []);
    minutesByBar.get(barTs).push(c);
  }

  console.log(
    `Candles loaded — LTF: ${ltfCandles.length} | 1m: ${oneMinCandles.length} | ${trendTf}m: ${trendCandles.length}`
  );

  // Pre-compute 15m Supertrend
  const trendHighs = trendCandles.map((c) => c.high);
  const trendLows = trendCandles.map((c) => c.low);
  const trendCloses = trendCandles.map((c) => c.close);
  const trendSt = ind.supertrend(trendHighs, trendLows, trendCloses, s.stAtrLen, s.stFactor);

  function getTrend(ts) {
    const idx = trendCandles.findLastIndex((c) => c.timestamp < ts);
    if (idx < 1) return { bullish: false, bearish: false, age: 0 };
    const dir = trendSt.direction[idx];
    let age = 0;
    for (let j = idx; j >= 0; j--) {
      if (trendSt.direction[j] === dir) age++;
      else break;
    }
    return { bullish: dir === -1, bearish: dir === 1, age };
  }

  // Pre-compute 5m indicators
  const closes = ltfCandles.map((c) => c.close);
  const highs = ltfCandles.map((c) => c.high);
  const lows = ltfCandles.map((c) => c.low);
  const volumes = ltfCandles.map((c) => c.volume);

  const st5m = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const atrValues = ind.atr(highs, lows, closes, 14);
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const volSma = ind.sma(volumes, s.volSmaLen);

  // ─── SESSION & RANGE TRACKING ──────────────────────────────────────────

  // Support multi-session: sessionStartHour can be a number or array
  const sessionHours = Array.isArray(s.sessionStartHour) ? s.sessionStartHour : [s.sessionStartHour];

  function getSessionId(ts) {
    const d = new Date(ts);
    let bestStartTs = 0;
    let bestHour = sessionHours[0];

    for (const hour of sessionHours) {
      const candidate = new Date(d);
      candidate.setUTCHours(hour, 0, 0, 0);
      if (candidate.getTime() > ts) {
        candidate.setUTCDate(candidate.getUTCDate() - 1);
      }
      if (candidate.getTime() > bestStartTs) {
        bestStartTs = candidate.getTime();
        bestHour = hour;
      }
    }

    const startDate = new Date(bestStartTs);
    return startDate.toISOString().slice(0, 10) + "T" + String(bestHour).padStart(2, "0");
  }

  // Pre-compute session info and opening ranges
  // For each bar, determine: which session it belongs to, and what the opening range is
  const sessionRanges = new Map(); // sessionId → { high, low, barsCollected }

  function getRange(barIndex) {
    const ts = ltfCandles[barIndex].timestamp;
    const sid = getSessionId(ts);

    if (!sessionRanges.has(sid)) {
      sessionRanges.set(sid, { high: -Infinity, low: Infinity, barsCollected: 0, firstBarIdx: barIndex });
    }

    const range = sessionRanges.get(sid);

    // Check if this bar is within the first orbBars of the session
    const barsInSession = barIndex - range.firstBarIdx;

    if (barsInSession < s.orbBars) {
      // Still building the range
      range.high = Math.max(range.high, highs[barIndex]);
      range.low = Math.min(range.low, lows[barIndex]);
      range.barsCollected = barsInSession + 1;
      return { high: range.high, low: range.low, width: range.high - range.low, established: false, sessionId: sid, barsInSession };
    }

    return {
      high: range.high,
      low: range.low,
      width: range.high - range.low,
      established: true,
      sessionId: sid,
      barsInSession,
    };
  }

  // ─── SIMULATION ──────────────────────────────────────────────────────────

  const trades = [];
  let position = null;
  let longTriggeredSession = "";
  let shortTriggeredSession = "";
  let barsSinceLoss = 999;
  let barsSinceClose = 999;
  let equity = 1000;
  const equityCurve = [];
  const COMMISSION = 0.0004;

  function isSessionOk(timestamp) {
    if (!s.useSessionFilter) return true;
    const hour = new Date(timestamp).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) {
      if (hour >= s.sessionSkipStart || hour < s.sessionSkipEnd) return false;
    } else {
      if (hour >= s.sessionSkipStart && hour < s.sessionSkipEnd) return false;
    }
    if (s.sessionSkipHours && s.sessionSkipHours.includes(hour)) return false;
    return true;
  }

  function isDowOk(timestamp) {
    if (!s.useDowFilter) return true;
    const dow = new Date(timestamp).getUTCDay();
    return !s.skipDays || !s.skipDays.includes(dow);
  }

  const showDebug = process.argv.includes("--debug");
  const warmup = 60;

  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i];
    const high = highs[i];
    const low = lows[i];
    const ts = ltfCandles[i].timestamp;

    const trend = getTrend(ts);
    const range = getRange(i);

    // 5m ST flip detection
    const stFlipBear = i > 0 && st5m.direction[i] === 1 && st5m.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st5m.direction[i] === -1 && st5m.direction[i - 1] === 1;

    // ─── EXITS (1m intrabar simulation) ─────────────────────────────

    if (position) {
      const isLong = position.side === "Buy";
      const barsHeld = i - position.entryBar;
      let exitReason = null;

      const minuteCandles = minutesByBar.get(ts) || [];

      for (const mc of minuteCandles) {
        if (exitReason) break;

        const mHigh = mc.high;
        const mLow = mc.low;
        const mPrice = mc.close;

        if (isLong) position.highest = Math.max(position.highest, mHigh);
        else position.lowest = Math.min(position.lowest, mLow);

        const unrealizedR = isLong
          ? (mPrice - position.entryPrice) / position.entryAtr
          : (position.entryPrice - mPrice) / position.entryAtr;

        // SL
        if (isLong && mLow <= position.sl) {
          exitReason = "Stop Loss";
          closeTrade(position, Math.max(position.sl, mLow), i, exitReason);
          break;
        } else if (!isLong && mHigh >= position.sl) {
          exitReason = "Stop Loss";
          closeTrade(position, Math.min(position.sl, mHigh), i, exitReason);
          break;
        }

        // TP
        if (isLong && mHigh >= position.tp) {
          exitReason = "Take Profit";
          closeTrade(position, Math.min(position.tp, mHigh), i, exitReason);
          break;
        } else if (!isLong && mLow <= position.tp) {
          exitReason = "Take Profit";
          closeTrade(position, Math.max(position.tp, mLow), i, exitReason);
          break;
        }

        // Multi-level Partial TP
        if (s.usePartial && position.partialLevel < 1) {
          if ((isLong && mHigh >= position.partial1) || (!isLong && mLow <= position.partial1)) {
            const exitP = position.partial1;
            const partialPnl = isLong
              ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial1Pct
              : ((position.entryPrice - exitP) / position.entryPrice) * s.partial1Pct;
            equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial1Pct;
            position.partialLevel = 1;
            position.sizeMultiplier -= s.partial1Pct;
            position.partial1Time = mc.timestamp;
            if (s.beOnPartial1) {
              if (isLong) position.sl = Math.max(position.sl, position.entryPrice);
              else position.sl = Math.min(position.sl, position.entryPrice);
            }
          }
        }
        if (s.usePartial && position.partialLevel === 1 && s.partial2Pct > 0) {
          if ((isLong && mHigh >= position.partial2) || (!isLong && mLow <= position.partial2)) {
            const exitP = position.partial2;
            const partialPnl = isLong
              ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial2Pct
              : ((position.entryPrice - exitP) / position.entryPrice) * s.partial2Pct;
            equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial2Pct;
            position.partialLevel = 2;
            position.sizeMultiplier -= s.partial2Pct;
            position.partial2Time = mc.timestamp;
            position.sl = position.entryPrice;
          }
        }

        // Progressive Trailing Stop (activate after TP1 or when partials disabled)
        if (s.useTrailRest && (position.partialLevel >= 1 || !s.usePartial)) {
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
      }

      // Fallback: no 1m data
      if (minuteCandles.length === 0 && !exitReason) {
        if (isLong) position.highest = Math.max(position.highest, high);
        else position.lowest = Math.min(position.lowest, low);

        if (isLong && low <= position.sl) { exitReason = "Stop Loss"; closeTrade(position, Math.max(position.sl, low), i, exitReason); }
        else if (!isLong && high >= position.sl) { exitReason = "Stop Loss"; closeTrade(position, Math.min(position.sl, high), i, exitReason); }
        else if (isLong && high >= position.tp) { exitReason = "Take Profit"; closeTrade(position, Math.min(position.tp, high), i, exitReason); }
        else if (!isLong && low <= position.tp) { exitReason = "Take Profit"; closeTrade(position, Math.max(position.tp, low), i, exitReason); }
        else if (s.usePartial && position.partialLevel < 1 && ((isLong && high >= position.partial1) || (!isLong && low <= position.partial1))) {
          const exitP = position.partial1;
          const partialPnl = isLong ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial1Pct : ((position.entryPrice - exitP) / position.entryPrice) * s.partial1Pct;
          equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial1Pct;
          position.partialLevel = 1; position.sizeMultiplier -= s.partial1Pct; position.partial1Time = ts;
          if (s.beOnPartial1) {
            if (isLong) position.sl = Math.max(position.sl, position.entryPrice);
            else position.sl = Math.min(position.sl, position.entryPrice);
          }
        }
      }

      // Max duration
      if (!exitReason && s.maxBarsTrade > 0 && barsHeld >= s.maxBarsTrade) {
        exitReason = "Max Duration";
        closeTrade(position, price, i, exitReason);
      }

      // 5m Supertrend flip
      if (!exitReason && isLong && stFlipBear) {
        const unrealizedR = (price - position.entryPrice) / position.entryAtr;
        if (s.beOnStFlip && unrealizedR > 0) {
          position.sl = Math.max(position.sl, position.entryPrice);
        } else if (unrealizedR <= 0) {
          exitReason = "ST Flip";
          closeTrade(position, price, i, exitReason);
        }
      }
      if (!exitReason && !isLong && stFlipBull) {
        const unrealizedR = (position.entryPrice - price) / position.entryAtr;
        if (s.beOnStFlip && unrealizedR > 0) {
          position.sl = Math.min(position.sl, position.entryPrice);
        } else if (unrealizedR <= 0) {
          exitReason = "ST Flip";
          closeTrade(position, price, i, exitReason);
        }
      }
    }

    // ─── ENTRIES ──────────────────────────────────────────────────

    if (!position) {
      barsSinceClose++;
      barsSinceLoss++;

      const atrVal = atrValues[i];
      if (!atrVal || !range.established) continue;

      const sessionOk = isSessionOk(ts);
      const dowOk = isDowOk(ts);
      const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
      const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;
      const adxOk = !s.useAdx || (dmiResult.adx[i] !== null && dmiResult.adx[i] > s.adxThresh);
      const volOk = !s.useVol || volumes[i] > volSma[i] * s.volMult;
      const trendAgeOk = !s.minTrendAge || trend.age >= s.minTrendAge;

      // Range validation
      const rangeOk = range.width >= atrVal * s.minRangeAtr &&
                      range.width <= atrVal * s.maxRangeAtr;

      // Breakout detection (close-based)
      const breakoutLong = rangeOk && price > range.high;
      const breakoutShort = rangeOk && price < range.low;

      // Quality filters
      const barRange = high - low;
      const closeQualityOk = !qf.closeQuality || barRange === 0 || (
        breakoutLong ? (price - low) / barRange >= qf.closeQuality :
        breakoutShort ? (high - price) / barRange >= qf.closeQuality : true
      );
      const minBreakoutOk = !qf.minBreakout || (
        breakoutLong ? (price - range.high) >= atrVal * qf.minBreakout :
        breakoutShort ? (range.low - price) >= atrVal * qf.minBreakout : true
      );
      const diConfirmOk = !qf.diConfirm || (
        breakoutLong ? (dmiResult.diPlus[i] > dmiResult.diMinus[i]) :
        breakoutShort ? (dmiResult.diMinus[i] > dmiResult.diPlus[i]) : true
      );
      const volSpikeOk = !qf.volSpike || volumes[i] > volSma[i] * qf.volSpike;
      const prevBarOk = !qf.prevBarDir || i === 0 || (
        breakoutLong ? closes[i - 1] > ltfCandles[i - 1].open :
        breakoutShort ? closes[i - 1] < ltfCandles[i - 1].open : true
      );
      const atrExpandOk = !qf.atrExpand || i === 0 || atrValues[i] > atrValues[i - 1];
      const rangeNarrowOk = !qf.rangeNarrow || range.width <= atrVal * qf.rangeNarrow;
      const stAlignOk = !qf.stAlign || (
        breakoutLong ? st5m.direction[i] === -1 :
        breakoutShort ? st5m.direction[i] === 1 : true
      );

      const longSig = breakoutLong && trend.bullish && trendAgeOk
        && adxOk && volOk && cooldownOk && reentryOk
        && longTriggeredSession !== range.sessionId && sessionOk && dowOk
        && closeQualityOk && minBreakoutOk && diConfirmOk && volSpikeOk
        && prevBarOk && atrExpandOk && rangeNarrowOk && stAlignOk;

      const shortSig = breakoutShort && trend.bearish && trendAgeOk
        && adxOk && volOk && cooldownOk && reentryOk
        && shortTriggeredSession !== range.sessionId && sessionOk && dowOk
        && closeQualityOk && minBreakoutOk && diConfirmOk && volSpikeOk
        && prevBarOk && atrExpandOk && rangeNarrowOk && stAlignOk;

      if (showDebug && !longSig && !shortSig && (breakoutLong || breakoutShort)) {
        const p = (v) => v ? "+" : "-";
        const time = new Date(ts).toISOString().slice(0, 16).replace("T", " ");
        console.log(
          `  ${time} | BO: ${p(breakoutLong)}L${p(breakoutShort)}S | Range: ${range.high?.toFixed(4)}-${range.low?.toFixed(4)} w=${range.width?.toFixed(4)} | ` +
          `15mST: ${trend.bullish ? "BULL" : "BEAR"}(${trend.age}) | ADX: ${p(adxOk)} Vol: ${p(volOk)} | ` +
          `Ses: ${p(sessionOk)} DoW: ${p(dowOk)} RangeOk: ${p(rangeOk)} TrendAge: ${p(trendAgeOk)}`
        );
      }

      if (longSig) {
        const rawSl = range.low - atrVal * s.slBuffer;
        const maxSl = price - atrVal * s.maxSlAtr;
        const sl = Math.max(rawSl, maxSl);
        const tp = price + range.width * s.tpRangeMult;

        position = {
          side: "Buy",
          entryPrice: price,
          entryAtr: atrVal,
          sl,
          tp,
          partial1: price + atrVal * s.partial1Mult,
          partial2: price + atrVal * s.partial2Mult,
          partialLevel: 0,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: riskMult,
          entryTimestamp: ts,
        };
        longTriggeredSession = range.sessionId;
        equity -= equity * COMMISSION;
      } else if (shortSig) {
        const rawSl = range.high + atrVal * s.slBuffer;
        const maxSl = price + atrVal * s.maxSlAtr;
        const sl = Math.min(rawSl, maxSl);
        const tp = price - range.width * s.tpRangeMult;

        position = {
          side: "Sell",
          entryPrice: price,
          entryAtr: atrVal,
          sl,
          tp,
          partial1: price - atrVal * s.partial1Mult,
          partial2: price - atrVal * s.partial2Mult,
          partialLevel: 0,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: riskMult,
          entryTimestamp: ts,
        };
        shortTriggeredSession = range.sessionId;
        equity -= equity * COMMISSION;
      }
    }

    equityCurve.push({ timestamp: ts, equity });
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

    trades.push({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnlPct: pnlPct * 100,
      rMultiple,
      barsHeld: barIdx - pos.entryBar,
      reason,
      partialClosed: pos.partialLevel > 0,
      partialLevel: pos.partialLevel,
      partial1Time: pos.partial1Time ? new Date(pos.partial1Time).toISOString() : null,
      partial2Time: pos.partial2Time ? new Date(pos.partial2Time).toISOString() : null,
      entryTime: new Date(pos.entryTimestamp).toISOString(),
      exitTime: new Date(ltfCandles[barIdx].timestamp).toISOString(),
    });

    if (pnlPct < 0) barsSinceLoss = 0;
    barsSinceClose = 0;
    position = null;
  }

  // ─── REPORT ────────────────────────────────────────────────────────────

  printReport(trades, equity, equityCurve, symbol, tfMinutes, months);
}

function printReport(trades, finalEquity, equityCurve, symbol, tf, months) {
  const totalTrades = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const longs = trades.filter((t) => t.side === "Buy");
  const shorts = trades.filter((t) => t.side === "Sell");

  const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const avgR = totalTrades > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / totalTrades : 0;
  const profitFactor =
    losses.length > 0
      ? Math.abs(wins.reduce((s, t) => s + t.pnlPct, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
      : wins.length > 0 ? Infinity : 0;

  let maxDrawdown = 0;
  let peak = equityCurve[0]?.equity || 1000;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = ((peak - pt.equity) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const avgBarsHeld = totalTrades > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / totalTrades : 0;

  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnlPct > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    maxConsecWins = Math.max(maxConsecWins, cw);
    maxConsecLosses = Math.max(maxConsecLosses, cl);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  ORB BACKTEST — ${symbol} ${tf}m — ${months} months`);
  console.log("=".repeat(60));

  console.log(`\n  PERFORMANCE`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Initial Capital:     $1,000.00`);
  console.log(`  Final Equity:        $${finalEquity.toFixed(2)}`);
  console.log(`  Net Profit:          $${(finalEquity - 1000).toFixed(2)} (${((finalEquity / 1000 - 1) * 100).toFixed(1)}%)`);
  console.log(`  Max Drawdown:        ${maxDrawdown.toFixed(1)}%`);
  console.log(`  Profit Factor:       ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);

  console.log(`\n  TRADES`);
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  Total Trades:        ${totalTrades}`);
  console.log(`  Wins / Losses:       ${wins.length} / ${losses.length}`);
  console.log(`  Win Rate:            ${winRate.toFixed(1)}%`);
  console.log(`  Longs / Shorts:      ${longs.length} / ${shorts.length}`);
  const partialCount = trades.filter((t) => t.partialClosed).length;
  if (partialCount > 0) console.log(`  Partial TPs Hit:     ${partialCount}`);
  console.log(`  Avg Win:             ${avgWin.toFixed(2)}%`);
  console.log(`  Avg Loss:            ${avgLoss.toFixed(2)}%`);
  console.log(`  Avg R-Multiple:      ${avgR.toFixed(2)}R`);
  console.log(`  Avg Bars Held:       ${avgBarsHeld.toFixed(1)} (${(avgBarsHeld * tf).toFixed(0)} min / ${(avgBarsHeld * tf / 60).toFixed(1)} hrs)`);
  console.log(`  Max Consec Wins:     ${maxConsecWins}`);
  console.log(`  Max Consec Losses:   ${maxConsecLosses}`);

  // Exit reasons
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  console.log(`\n  EXIT REASONS`);
  console.log(`  ${"─".repeat(40)}`);
  for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(22)} ${count}`);
  }

  // All trades
  if (trades.length > 0) {
    console.log(`\n  ALL TRADES (${trades.length})`);
    console.log(`  ${"─".repeat(85)}`);
    console.log(`  ${"#".padEnd(4)} ${"Side".padEnd(6)} ${"Entry".padEnd(12)} ${"Exit".padEnd(12)} ${"P&L%".padEnd(8)} ${"R".padEnd(6)} ${"Bars".padEnd(5)} ${"Opened".padEnd(18)} ${"TP1".padEnd(18)} ${"Closed".padEnd(18)} Reason`);
    for (let ti = 0; ti < trades.length; ti++) {
      const t = trades[ti];
      const side = t.side === "Buy" ? "LONG" : "SHORT";
      const opened = t.entryTime.slice(0, 16).replace("T", " ");
      const closed = t.exitTime.slice(0, 16).replace("T", " ");
      const tp1 = t.partial1Time ? t.partial1Time.slice(0, 16).replace("T", " ") : "—";
      console.log(
        `  ${String(ti + 1).padEnd(4)} ${side.padEnd(6)} ${t.entryPrice.toFixed(6).padEnd(12)} ${t.exitPrice.toFixed(6).padEnd(12)} ${t.pnlPct.toFixed(2).padEnd(8)} ${t.rMultiple.toFixed(1).padEnd(6)} ${String(t.barsHeld).padEnd(5)} ${opened.padEnd(18)} ${tp1.padEnd(18)} ${closed.padEnd(18)} ${t.reason}`
      );
    }
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

const symbol = process.argv[2] || "SUIUSDT";
const months = parseInt(process.argv[3] || "2");
const tf = parseInt(process.argv[4] || config.timeframe);

const args = {};
for (const a of process.argv.slice(5)) {
  const idx = a.indexOf("=");
  if (idx > 0) args[a.slice(0, idx).replace(/^--/, "")] = a.slice(idx + 1);
}
if (args.orbbars) s.orbBars = parseInt(args.orbbars);
if (args.sessionstart) s.sessionStartHour = parseInt(args.sessionstart);
if (args.sessions) s.sessionStartHour = args.sessions.split(",").map(Number);
if (args.tpmult) s.tpRangeMult = parseFloat(args.tpmult);
if (args.slbuffer) s.slBuffer = parseFloat(args.slbuffer);
if (args.maxsl) s.maxSlAtr = parseFloat(args.maxsl);
if (args.minrange) s.minRangeAtr = parseFloat(args.minrange);
if (args.maxrange) s.maxRangeAtr = parseFloat(args.maxrange);
if (args.adx) s.adxThresh = parseFloat(args.adx);
if (args.trendage) s.minTrendAge = parseInt(args.trendage);
if (args.maxbars) s.maxBarsTrade = parseInt(args.maxbars);
if (args.trailbe) s.trailBeR = parseFloat(args.trailbe);
if (args.trailstart) s.trailStartR = parseFloat(args.trailstart);
if (args.trailatr) s.trailAtrMult = parseFloat(args.trailatr);
if (args.stfactor) s.stFactor = parseFloat(args.stfactor);
if (args.partial !== undefined) s.usePartial = args.partial === "1";
if (args.p1) s.partial1Mult = parseFloat(args.p1);
if (args.p2) s.partial2Mult = parseFloat(args.p2);
if (args.p1pct) s.partial1Pct = parseFloat(args.p1pct);
if (args.p2pct) s.partial2Pct = parseFloat(args.p2pct);
if (args.beontp1 !== undefined) s.beOnPartial1 = args.beontp1 === "1";
if (args.session !== undefined) s.useSessionFilter = args.session === "1";
if (args.vol !== undefined) s.useVol = args.vol === "1";
if (args.dow !== undefined) { s.useDowFilter = !!args.dow; s.skipDays = args.dow ? args.dow.split(",").map(Number) : []; }
const riskMult = args.risk ? parseFloat(args.risk) : 1;

// Quality filters — inherit from config, CLI can override
const qualityFilters = {
  closeQuality: args.closeq ? parseFloat(args.closeq) : 0,
  minBreakout: args.minbo ? parseFloat(args.minbo) : 0,
  diConfirm: args.diconf !== undefined ? args.diconf === "1" : !!s.diConfirm,
  volSpike: args.volspike ? parseFloat(args.volspike) : 0,
  prevBarDir: args.prevbar === "1",
  atrExpand: args.atrexp === "1",
  rangeNarrow: args.rangenarrow ? parseFloat(args.rangenarrow) : 0,
  stAlign: args.stalign !== undefined ? args.stalign === "1" : !!s.stAlign,
};

backtest(symbol, tf, months, riskMult, qualityFilters).catch((err) => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
