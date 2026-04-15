const { RestClientV5 } = require("bybit-api");
const ind = require("./indicators");
const config = require("./config");

const s = config.strategy;

const client = new RestClientV5({ testnet: false }); // public endpoints, no key needed

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
    if (lastTs <= cursor) break; // no progress, avoid infinite loop
    cursor = lastTs + 1;

    process.stdout.write(`  ${interval}: ${all.length} candles\r`);
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  ${interval}: ${all.length} candles loaded`);

  // Deduplicate by timestamp
  const seen = new Set();
  return all.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
}

// ─── HTF TREND ───────────────────────────────────────────────────────────────

function htfTrend(candles) {
  const closes = candles.map((c) => c.close);
  const emaFast = ind.ema(closes, s.htfEmaFast);
  const emaSlow = ind.ema(closes, s.htfEmaSlow);
  const i = candles.length - 2; // confirmed bar
  if (i < 0 || emaFast[i] === null || emaSlow[i] === null) return 0;
  return emaFast[i] > emaSlow[i] ? 1 : emaFast[i] < emaSlow[i] ? -1 : 0;
}

// ─── BACKTEST ENGINE ─────────────────────────────────────────────────────────

async function backtest(symbol, tfMinutes, months) {
  const now = Date.now();
  const startTime = now - months * 30 * 24 * 60 * 60 * 1000;
  const interval = String(tfMinutes);

  console.log(`\nFetching ${symbol} data (${months} months, ${interval}m)...\n`);

  // Fetch all candle data (including 1m for intrabar position management)
  const [ltfCandles, oneMinCandles, dCandles, wCandles, mCandles] = await Promise.all([
    fetchAllCandles(symbol, interval, startTime, now),
    fetchAllCandles(symbol, "1", startTime, now),
    fetchAllCandles(symbol, "D", startTime - 120 * 86400000, now), // extra history for EMA warmup
    fetchAllCandles(symbol, "W", startTime - 365 * 86400000, now),
    fetchAllCandles(symbol, "M", startTime - 730 * 86400000, now),
  ]);

  // Build 1m candle lookup: 15m bar start timestamp → array of 1m candles within it
  const barMs = tfMinutes * 60000;
  const minutesByBar = new Map();
  for (const c of oneMinCandles) {
    const barTs = Math.floor(c.timestamp / barMs) * barMs;
    if (!minutesByBar.has(barTs)) minutesByBar.set(barTs, []);
    minutesByBar.get(barTs).push(c);
  }

  console.log(
    `Candles loaded — LTF: ${ltfCandles.length} | 1m: ${oneMinCandles.length} | D: ${dCandles.length} | W: ${wCandles.length} | M: ${mCandles.length}`
  );

  // Pre-compute HTF EMAs for the full period
  const dCloses = dCandles.map((c) => c.close);
  const wCloses = wCandles.map((c) => c.close);
  const mCloses = mCandles.map((c) => c.close);
  const dEmaFast = ind.ema(dCloses, s.htfEmaFast);
  const dEmaSlow = ind.ema(dCloses, s.htfEmaSlow);
  const wEmaFast = ind.ema(wCloses, s.htfEmaFast);
  const wEmaSlow = ind.ema(wCloses, s.htfEmaSlow);
  const mEmaFast = ind.ema(mCloses, s.htfEmaFast);
  const mEmaSlow = ind.ema(mCloses, s.htfEmaSlow);

  // Get HTF trend for a given timestamp
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
  const emaFast = ind.ema(closes, 21);
  const emaSlow = ind.ema(closes, 50);

  // ─── SIMULATION ──────────────────────────────────────────────────────────

  const trades = [];
  let position = null; // { side, entryPrice, entryAtr, sl, tp, partial1, partial2, partialLevel, entryBar, highest, lowest }
  let longTriggered = false;
  let shortTriggered = false;
  let barsSinceLoss = 999;
  let barsSinceClose = 999;
  let lastTradeWin = false;
  let equity = 1000;
  const equityCurve = [];
  const COMMISSION = 0.0004; // 0.04% taker

  // Session filter helper (dead zone + toxic hours)
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

  // Day-of-week filter helper
  function isDowOk(timestamp) {
    if (!s.useDowFilter) return true;
    const dow = new Date(timestamp).getUTCDay();
    return !s.skipDays || !s.skipDays.includes(dow);
  }

  // Start after warmup (need ~50 bars for indicators)
  const warmup = 60;

  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i];
    const high = highs[i];
    const low = lows[i];
    const ts = ltfCandles[i].timestamp;

    // MTF trend
    const mtf = getMtfTrend(ts);

    // LTF signals
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
    const adxOk = !s.useAdx || (dmiResult.adx[i] !== null && dmiResult.adx[i] > s.adxThresh);
    const diLongOk = !s.useDi || dmiResult.diPlus[i] > dmiResult.diMinus[i];
    const diShortOk = !s.useDi || dmiResult.diMinus[i] > dmiResult.diPlus[i];
    const volAboveMin = !s.useVol || volumes[i] > volSma[i] * s.volMult;
    const volBelowMax = !s.volMaxMult || volumes[i] <= volSma[i] * s.volMaxMult;
    const volOk = volAboveMin && volBelowMax;
    const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
    const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;

    // Reset triggers
    if (stFlipBear) longTriggered = false;
    if (stFlipBull) shortTriggered = false;

    // ─── EXITS (1m intrabar simulation) ─────────────────────────────

    if (position) {
      const isLong = position.side === "Buy";
      const barsHeld = i - position.entryBar;
      let exitReason = null;

      // Get 1m candles for this 15m bar
      const minuteCandles = minutesByBar.get(ts) || [];

      // Process each 1m candle for position management
      for (const mc of minuteCandles) {
        if (exitReason) break;

        const mPrice = mc.close;
        const mHigh = mc.high;
        const mLow = mc.low;

        // Update highest/lowest
        if (isLong) position.highest = Math.max(position.highest, mHigh);
        else position.lowest = Math.min(position.lowest, mLow);

        const unrealizedR = isLong
          ? (mPrice - position.entryPrice) / position.entryAtr
          : (position.entryPrice - mPrice) / position.entryAtr;

        // Check SL hit
        if (isLong && mLow <= position.sl) {
          exitReason = "Stop Loss";
          closeTrade(position, Math.max(position.sl, mLow), i, exitReason);
          break;
        } else if (!isLong && mHigh >= position.sl) {
          exitReason = "Stop Loss";
          closeTrade(position, Math.min(position.sl, mHigh), i, exitReason);
          break;
        }

        // Check TP hit
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
          }
        }
        if (s.usePartial && position.partialLevel === 1) {
          if ((isLong && mHigh >= position.partial2) || (!isLong && mLow <= position.partial2)) {
            const exitP = position.partial2;
            const partialPnl = isLong
              ? ((exitP - position.entryPrice) / position.entryPrice) * s.partial2Pct
              : ((position.entryPrice - exitP) / position.entryPrice) * s.partial2Pct;
            equity += equity * partialPnl - equity * COMMISSION * 2 * s.partial2Pct;
            position.partialLevel = 2;
            position.sizeMultiplier -= s.partial2Pct;
            position.partial2Time = mc.timestamp;
            position.sl = position.entryPrice; // move SL to BE after both partials
          }
        }

        // Progressive Trailing Stop
        if (s.useTrailRest && position.partialLevel >= 1) {
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

      // Fallback: if no 1m data for this bar, use 15m high/low (same as before)
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
        }
      }

      // Max duration (checked on 15m bar)
      if (!exitReason && s.maxBarsTrade > 0 && barsHeld >= s.maxBarsTrade) {
        exitReason = "Max Duration";
        closeTrade(position, price, i, exitReason);
      }
      // Supertrend flip (checked on 15m bar)
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
      if (!atrVal) continue;

      const sessionOk = isSessionOk(ts);
      const dowOk = isDowOk(ts);

      // Original StochRSI entry
      const longSig = aboveVwap && stBullish && kCrossUp && stochLongOk && adxOk && diLongOk && volOk
        && mtf.htfBullish && !mtf.htfConflict && cooldownOk && reentryOk && !longTriggered && sessionOk && dowOk;

      const shortSig = belowVwap && stBearish && kCrossDown && stochShortOk && adxOk && diShortOk && volOk
        && mtf.htfBearish && !mtf.htfConflict && cooldownOk && reentryOk && !shortTriggered && sessionOk && dowOk;

      // EMA pullback entry: price touches EMA21 in trend, bounces back + StochRSI in zone
      let emaPullbackLong = false;
      let emaPullbackShort = false;
      if (s.useEmaPullback && emaFast[i] !== null && emaSlow[i] !== null) {
        const stochInLongZone = stochRsi.k[i] !== null && stochRsi.k[i] < 50; // oversold-ish
        const touchedEma = low <= emaFast[i] && price > emaFast[i]; // wick touched EMA, closed above
        const trendUp = emaFast[i] > emaSlow[i];
        emaPullbackLong = touchedEma && trendUp && stochInLongZone && stBullish && aboveVwap && adxOk && diLongOk && volOk
          && mtf.htfBullish && !mtf.htfConflict && cooldownOk && reentryOk && !longTriggered && sessionOk && dowOk;

        const stochInShortZone = stochRsi.k[i] !== null && stochRsi.k[i] > 50; // overbought-ish
        const touchedEmaShort = high >= emaFast[i] && price < emaFast[i]; // wick touched EMA, closed below
        const trendDown = emaFast[i] < emaSlow[i];
        emaPullbackShort = touchedEmaShort && trendDown && stochInShortZone && stBearish && belowVwap && adxOk && diShortOk && volOk
          && mtf.htfBearish && !mtf.htfConflict && cooldownOk && reentryOk && !shortTriggered && sessionOk && dowOk;
      }

      const entryLong = longSig || emaPullbackLong;
      const entryShort = shortSig || emaPullbackShort;

      if (entryLong) {
        position = {
          side: "Buy",
          entryPrice: price,
          entryAtr: atrVal,
          sl: price - atrVal * s.slMult,
          tp: price + atrVal * s.tpMult,
          partial1: price + atrVal * s.partial1Mult,
          partial2: price + atrVal * s.partial2Mult,
          partialLevel: 0,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: 1,
          entryTimestamp: ts,
        };
        longTriggered = true;
        equity -= equity * COMMISSION; // entry commission
      } else if (entryShort) {
        position = {
          side: "Sell",
          entryPrice: price,
          entryAtr: atrVal,
          sl: price + atrVal * s.slMult,
          tp: price - atrVal * s.tpMult,
          partial1: price - atrVal * s.partial1Mult,
          partial2: price - atrVal * s.partial2Mult,
          partialLevel: 0,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: 1,
          entryTimestamp: ts,
        };
        shortTriggered = true;
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
    equity -= equity * COMMISSION; // exit commission

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
    lastTradeWin = pnlPct > 0;
    // Re-entry after win: reset trigger to allow same-direction re-entry
    if (s.reentryAfterWin && lastTradeWin) {
      longTriggered = false;
      shortTriggered = false;
    }
    // Normal: always reset triggers on close (default behavior)
    if (!s.reentryAfterWin) {
      longTriggered = false;
      shortTriggered = false;
    }
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
      : wins.length > 0
      ? Infinity
      : 0;

  const maxEquity = Math.max(...equityCurve.map((e) => e.equity));
  let maxDrawdown = 0;
  let peak = equityCurve[0]?.equity || 1000;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = ((peak - pt.equity) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const avgBarsHeld = totalTrades > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / totalTrades : 0;
  const minBarsHeld = totalTrades > 0 ? Math.min(...trades.map((t) => t.barsHeld)) : 0;
  const maxBarsHeld = totalTrades > 0 ? Math.max(...trades.map((t) => t.barsHeld)) : 0;
  const medianBarsHeld = totalTrades > 0
    ? [...trades].sort((a, b) => a.barsHeld - b.barsHeld)[Math.floor(totalTrades / 2)].barsHeld
    : 0;

  // Consecutive wins/losses
  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnlPct > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    maxConsecWins = Math.max(maxConsecWins, cw);
    maxConsecLosses = Math.max(maxConsecLosses, cl);
  }

  const partialCount = trades.filter((t) => t.partialClosed).length;

  console.log("\n" + "=".repeat(60));
  console.log(`  BACKTEST REPORT — ${symbol} ${tf}m — ${months} months`);
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
  console.log(`  Partial TPs Hit:     ${partialCount}`);
  console.log(`  Avg Win:             ${avgWin.toFixed(2)}%`);
  console.log(`  Avg Loss:            ${avgLoss.toFixed(2)}%`);
  console.log(`  Avg R-Multiple:      ${avgR.toFixed(2)}R`);
  console.log(`  Avg Bars Held:       ${avgBarsHeld.toFixed(1)} (${(avgBarsHeld * tf).toFixed(0)} min / ${(avgBarsHeld * tf / 60).toFixed(1)} hrs)`);
  console.log(`  Min Bars Held:       ${minBarsHeld} (${(minBarsHeld * tf)} min / ${(minBarsHeld * tf / 60).toFixed(1)} hrs)`);
  console.log(`  Max Bars Held:       ${maxBarsHeld} (${(maxBarsHeld * tf)} min / ${(maxBarsHeld * tf / 60).toFixed(1)} hrs)`);
  console.log(`  Median Bars Held:    ${medianBarsHeld} (${(medianBarsHeld * tf)} min / ${(medianBarsHeld * tf / 60).toFixed(1)} hrs)`);
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
    console.log(`  ${"#".padEnd(4)} ${"Side".padEnd(6)} ${"Entry".padEnd(12)} ${"Exit".padEnd(12)} ${"P&L%".padEnd(8)} ${"R".padEnd(6)} ${"Bars".padEnd(5)} ${"Opened".padEnd(18)} ${"TP1".padEnd(18)} ${"TP2".padEnd(18)} ${"Closed".padEnd(18)} Reason`);
    for (let ti = 0; ti < trades.length; ti++) { const t = trades[ti];
      const side = t.side === "Buy" ? "LONG" : "SHORT";
      const opened = t.entryTime ? t.entryTime.slice(0, 16).replace("T", " ") : "";
      const closed = t.exitTime ? t.exitTime.slice(0, 16).replace("T", " ") : "";
      const tp1 = t.partial1Time ? t.partial1Time.slice(0, 16).replace("T", " ") : "—";
      const tp2 = t.partial2Time ? t.partial2Time.slice(0, 16).replace("T", " ") : "—";
      console.log(
        `  ${String(ti + 1).padEnd(4)} ${side.padEnd(6)} ${t.entryPrice.toFixed(6).padEnd(12)} ${t.exitPrice.toFixed(6).padEnd(12)} ${t.pnlPct.toFixed(2).padEnd(8)} ${t.rMultiple.toFixed(1).padEnd(6)} ${String(t.barsHeld).padEnd(5)} ${opened.padEnd(18)} ${tp1.padEnd(18)} ${tp2.padEnd(18)} ${closed.padEnd(18)} ${t.reason}`
      );
    }
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

// ─── RUN ─────────────────────────────────────────────────────────────────────

const symbol = process.argv[2] || "1000PEPEUSDT";
const months = parseInt(process.argv[3] || "2");
const tf = parseInt(process.argv[4] || config.timeframe);

// Optional overrides via named args: --sl=2.0 --tp=4.0 --session=1 --p1=1.2 --p2=2.0
// New filters: --adx=25 --toxichours=8,9,13 --dow=2 --volmax=2.0 --maxbars=20
const args = {};
for (const a of process.argv.slice(5)) {
  const idx = a.indexOf("=");
  if (idx > 0) args[a.slice(0, idx).replace(/^--/, "")] = a.slice(idx + 1);
}
if (args.sl) s.slMult = parseFloat(args.sl);
if (args.tp) s.tpMult = parseFloat(args.tp);
if (args.session !== undefined) s.useSessionFilter = args.session === "1";
if (args.p1) s.partial1Mult = parseFloat(args.p1);
if (args.p2) s.partial2Mult = parseFloat(args.p2);
if (args.adx) s.adxThresh = parseFloat(args.adx);
if (args.toxichours !== undefined) s.sessionSkipHours = args.toxichours ? args.toxichours.split(",").map(Number) : [];
if (args.dow !== undefined) { s.useDowFilter = !!args.dow; s.skipDays = args.dow ? args.dow.split(",").map(Number) : []; }
if (args.volmax !== undefined) s.volMaxMult = parseFloat(args.volmax);
if (args.maxbars) s.maxBarsTrade = parseInt(args.maxbars);
if (args.reentry !== undefined) s.reentryAfterWin = args.reentry === "1";
if (args.emapb !== undefined) s.useEmaPullback = args.emapb === "1";
if (args.stfactor) s.stFactor = parseFloat(args.stfactor);
if (args.os) s.osLevel = parseInt(args.os);
if (args.cooldown) s.cooldownBars = parseInt(args.cooldown);

backtest(symbol, tf, months).catch((err) => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
