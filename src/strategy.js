const ind = require("./indicators");
const config = require("./config");
const log = require("./logger");

const s = config.strategy;

/**
 * Analyze HTF trend for a single timeframe
 * @param {Array} candles - candle data
 * @returns {number} +1 bull, -1 bear, 0 neutral
 */
function htfTrend(candles) {
  const closes = candles.map((c) => c.close);
  const emaFast = ind.ema(closes, s.htfEmaFast);
  const emaSlow = ind.ema(closes, s.htfEmaSlow);

  // Use second-to-last (confirmed candle, not current forming one)
  const i = candles.length - 2;
  if (emaFast[i] === null || emaSlow[i] === null) return 0;
  return emaFast[i] > emaSlow[i] ? 1 : emaFast[i] < emaSlow[i] ? -1 : 0;
}

/**
 * Compute all MTF trends
 * @param {object} htfCandles - { D: [...], W: [...], M: [...] }
 * @returns {{ bullCount, bearCount, trendScore, htfBullish, htfBearish, trends }}
 */
function analyzeMtfTrend(htfCandles) {
  const dTrend = htfTrend(htfCandles.D);
  const wTrend = htfTrend(htfCandles.W);
  const mTrend = htfTrend(htfCandles.M);

  const trendScore = dTrend + wTrend + mTrend;
  const bullCount = [dTrend, wTrend, mTrend].filter((t) => t === 1).length;
  const bearCount = [dTrend, wTrend, mTrend].filter((t) => t === -1).length;

  const htfBullish = bullCount >= s.htfMinAgree;
  const htfBearish = bearCount >= s.htfMinAgree;
  const htfConflict = s.htfStrict && bullCount > 0 && bearCount > 0;
  const fullConfluence = bullCount === 3 || bearCount === 3;

  return {
    daily: dTrend,
    weekly: wTrend,
    monthly: mTrend,
    trendScore,
    bullCount,
    bearCount,
    htfBullish,
    htfBearish,
    htfConflict,
    fullConfluence,
  };
}

/**
 * Analyze current timeframe candles and generate signals
 * @param {Array} candles - LTF candle data
 * @param {object} mtf - result from analyzeMtfTrend
 * @param {object} state - persistent bot state
 * @returns {object} signal analysis
 */
function analyze(candles, mtf, state) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const volumes = candles.map((c) => c.volume);
  const i = candles.length - 1; // current bar

  // VWAP
  const vwapValues = ind.vwap(candles);
  const vwapVal = vwapValues[i];
  const aboveVwap = closes[i] > vwapVal;
  const belowVwap = closes[i] < vwapVal;

  // Supertrend
  const st = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const stBullish = st.direction[i] === -1;
  const stBearish = st.direction[i] === 1;

  // Stochastic RSI
  const stochRsi = ind.stochRsi(closes, s.rsiLen, s.stochLen, s.stochK, s.stochD);
  const kCrossUp = ind.crossover(stochRsi.k, stochRsi.d, i);
  const kCrossDown = ind.crossunder(stochRsi.k, stochRsi.d, i);
  const stochLongOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] < s.osLevel;
  const stochShortOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] > (100 - s.osLevel);

  // ATR
  const atrValues = ind.atr(highs, lows, closes, 14);
  const atrVal = atrValues[i];

  // ADX + DI
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const adxVal = dmiResult.adx[i];
  const adxOk = !s.useAdx || (adxVal !== null && adxVal > s.adxThresh);
  const diLongOk = !s.useDi || (dmiResult.diPlus[i] > dmiResult.diMinus[i]);
  const diShortOk = !s.useDi || (dmiResult.diMinus[i] > dmiResult.diPlus[i]);

  // Volume
  const volSma = ind.sma(volumes, s.volSmaLen);
  const volOk = !s.useVol || (volumes[i] > volSma[i] * s.volMult);

  // Cooldown & re-entry
  const cooldownOk = s.cooldownBars === 0 || state.barsSinceLoss > s.cooldownBars;
  const reentryOk = s.minBarsReentry === 0 || state.barsSinceClose > s.minBarsReentry;

  // LTF signals
  const ltfLong = aboveVwap && stBullish && kCrossUp && stochLongOk && adxOk && diLongOk && volOk;
  const ltfShort = belowVwap && stBearish && kCrossDown && stochShortOk && adxOk && diShortOk && volOk;

  // Combined
  const longSignal = ltfLong && mtf.htfBullish && !mtf.htfConflict && cooldownOk && reentryOk;
  const shortSignal = ltfShort && mtf.htfBearish && !mtf.htfConflict && cooldownOk && reentryOk;

  // Supertrend flip detection
  const stFlippedBearish = i > 0 && st.direction[i] === 1 && st.direction[i - 1] === -1;
  const stFlippedBullish = i > 0 && st.direction[i] === -1 && st.direction[i - 1] === 1;

  // Session filter
  const sessionOk = !s.useSessionFilter || (() => {
    const hour = new Date(candles[i].timestamp).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) {
      // Wraps midnight: e.g. 20-02 means skip 20,21,22,23,0,1
      return !(hour >= s.sessionSkipStart || hour < s.sessionSkipEnd);
    }
    return !(hour >= s.sessionSkipStart && hour < s.sessionSkipEnd);
  })();

  // Apply session filter to signals
  const longSignalFiltered = longSignal && sessionOk;
  const shortSignalFiltered = shortSignal && sessionOk;

  return {
    longSignal: longSignalFiltered,
    shortSignal: shortSignalFiltered,
    stBullish,
    stBearish,
    stFlippedBearish,
    stFlippedBullish,
    atrVal,
    price: closes[i],
    vwap: vwapVal,
    adx: adxVal,
    diPlus: dmiResult.diPlus[i],
    diMinus: dmiResult.diMinus[i],
    stochK: stochRsi.k[i],
    volOk,
    cooldownOk,
    reentryOk,
    sessionOk,
    mtf,
  };
}

/**
 * Determine action based on signal + current position
 * @returns {{ action, sl, tp, partialTp, reason }}
 */
function decide(signal, position, state) {
  const { price, atrVal } = signal;

  // No position — check for entries
  if (!position) {
    if (signal.longSignal && !state.longTriggered) {
      const sl = price - atrVal * s.slMult;
      const tp = price + atrVal * s.tpMult;
      const partial1 = price + atrVal * s.partial1Mult;
      const partial2 = price + atrVal * s.partial2Mult;
      return { action: "open_long", sl, tp, partial1, partial2, reason: "Long signal" };
    }
    if (signal.shortSignal && !state.shortTriggered) {
      const sl = price + atrVal * s.slMult;
      const tp = price - atrVal * s.tpMult;
      const partial1 = price - atrVal * s.partial1Mult;
      const partial2 = price - atrVal * s.partial2Mult;
      return { action: "open_short", sl, tp, partial1, partial2, reason: "Short signal" };
    }
    return { action: "none", reason: "No signal" };
  }

  // Have position — check exits
  const isLong = position.side === "Buy";
  const entryPrice = state.entryPrice || position.entryPrice;
  const entryAtr = state.entryAtr || atrVal;
  const unrealizedR = isLong
    ? (price - entryPrice) / entryAtr
    : (entryPrice - price) / entryAtr;
  const inProfit = unrealizedR > 0;

  // Max duration exit
  if (s.maxBarsTrade > 0 && state.barsInTrade >= s.maxBarsTrade) {
    return { action: "close", reason: "Max duration reached" };
  }

  // Multi-level partial TP
  if (s.usePartial && state.partialLevel < 1) {
    if ((isLong && price >= state.partial1) || (!isLong && price <= state.partial1)) {
      return { action: "partial_close_1", reason: `Partial TP1 hit at ${unrealizedR.toFixed(1)}R` };
    }
  }
  if (s.usePartial && state.partialLevel === 1) {
    if ((isLong && price >= state.partial2) || (!isLong && price <= state.partial2)) {
      return { action: "partial_close_2", reason: `Partial TP2 hit at ${unrealizedR.toFixed(1)}R` };
    }
  }

  // Progressive trailing stop
  if (s.useTrailRest && state.partialLevel >= 1) {
    // Move SL to breakeven at +1R (trailBeR)
    if (unrealizedR >= s.trailBeR && state.activeSl !== entryPrice) {
      return { action: "move_sl_be", reason: `Moving SL to BE at ${unrealizedR.toFixed(1)}R` };
    }
    // Active trailing at +2R (trailStartR)
    if (unrealizedR >= s.trailStartR) {
      if (isLong) {
        const trailSl = Math.max(entryPrice, state.highestSince - entryAtr * s.trailAtrMult);
        if (price <= trailSl) {
          return { action: "close", reason: `Trailing stop hit at ${unrealizedR.toFixed(1)}R` };
        }
      } else {
        const trailSl = Math.min(entryPrice, state.lowestSince + entryAtr * s.trailAtrMult);
        if (price >= trailSl) {
          return { action: "close", reason: `Trailing stop hit at ${unrealizedR.toFixed(1)}R` };
        }
      }
    }
  }

  // SL/TP check
  if (isLong) {
    if (price <= state.activeSl) return { action: "close", reason: "Stop loss hit" };
    if (price >= state.activeTp) return { action: "close", reason: `Take profit hit at ${unrealizedR.toFixed(1)}R` };
  } else {
    if (price >= state.activeSl) return { action: "close", reason: "Stop loss hit" };
    if (price <= state.activeTp) return { action: "close", reason: `Take profit hit at ${unrealizedR.toFixed(1)}R` };
  }

  // Supertrend flip
  if (isLong && signal.stFlippedBearish) {
    if (s.beOnStFlip && inProfit) {
      return { action: "move_sl_be", reason: "ST flipped — moving SL to breakeven" };
    }
    return { action: "close", reason: "ST Flip (in loss)" };
  }
  if (!isLong && signal.stFlippedBullish) {
    if (s.beOnStFlip && inProfit) {
      return { action: "move_sl_be", reason: "ST flipped — moving SL to breakeven" };
    }
    return { action: "close", reason: "ST Flip (in loss)" };
  }

  return { action: "hold", reason: `Holding at ${unrealizedR.toFixed(1)}R` };
}

module.exports = { analyzeMtfTrend, analyze, decide };
