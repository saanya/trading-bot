const ind = require("../../common/indicators");
const config = require("./config");

const s = config.strategy;

/**
 * Compute 15m Supertrend direction for trend filtering
 * @param {Array} candles15m - 15m candle data
 * @returns {{ bullish: boolean, bearish: boolean, flippedBearish: boolean, flippedBullish: boolean, age: number }}
 */
function trendFilter(candles15m) {
  const highs = candles15m.map((c) => c.high);
  const lows = candles15m.map((c) => c.low);
  const closes = candles15m.map((c) => c.close);

  const st = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const i = candles15m.length - 2; // confirmed bar (not current forming)

  // Count how many consecutive bars the trend has been in this direction
  const dir = st.direction[i];
  let age = 0;
  for (let j = i; j >= 0; j--) {
    if (st.direction[j] === dir) age++;
    else break;
  }

  return {
    bullish: dir === -1,
    bearish: dir === 1,
    flippedBearish: i > 0 && st.direction[i] === 1 && st.direction[i - 1] === -1,
    flippedBullish: i > 0 && st.direction[i] === -1 && st.direction[i - 1] === 1,
    age,
  };
}

/**
 * Analyze 5m candles for EMA pullback entry signals
 * @param {Array} candles5m - 5m candle data
 * @param {object} trend - result from trendFilter()
 * @param {object} state - persistent bot state
 * @returns {object} signal analysis
 */
function analyze(candles5m, trend, state) {
  const closes = candles5m.map((c) => c.close);
  const highs = candles5m.map((c) => c.high);
  const lows = candles5m.map((c) => c.low);
  const volumes = candles5m.map((c) => c.volume);
  const i = candles5m.length - 1;

  // EMA
  const ema21 = ind.ema(closes, s.emaLen);

  // VWAP
  const vwapValues = ind.vwap(candles5m);
  const aboveVwap = vwapValues[i] !== null && closes[i] > vwapValues[i];
  const belowVwap = vwapValues[i] !== null && closes[i] < vwapValues[i];

  // EMA Pullback detection: price touched EMA within last N bars, then bounced
  let touchedEmaLong = false;
  let touchedEmaShort = false;
  for (let b = 1; b <= s.pullbackBars && (i - b) >= 0; b++) {
    if (lows[i - b] <= ema21[i - b] && ema21[i - b] !== null) touchedEmaLong = true;
    if (highs[i - b] >= ema21[i - b] && ema21[i - b] !== null) touchedEmaShort = true;
  }
  const pullbackLong = touchedEmaLong && closes[i] > ema21[i] && ema21[i] !== null;
  const pullbackShort = touchedEmaShort && closes[i] < ema21[i] && ema21[i] !== null;

  // 5m Supertrend (for flip exit + entry alignment)
  const st5m = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const stBullish = st5m.direction[i] === -1;
  const stBearish = st5m.direction[i] === 1;
  const stFlippedBearish = i > 0 && st5m.direction[i] === 1 && st5m.direction[i - 1] === -1;
  const stFlippedBullish = i > 0 && st5m.direction[i] === -1 && st5m.direction[i - 1] === 1;

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

  // Session filter
  const sessionOk = !s.useSessionFilter || (() => {
    const hour = new Date(candles5m[i].timestamp).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) {
      if (hour >= s.sessionSkipStart || hour < s.sessionSkipEnd) return false;
    } else {
      if (hour >= s.sessionSkipStart && hour < s.sessionSkipEnd) return false;
    }
    if (s.sessionSkipHours && s.sessionSkipHours.includes(hour)) return false;
    return true;
  })();

  // Day-of-week filter
  const dowOk = !s.useDowFilter || (() => {
    const dow = new Date(candles5m[i].timestamp).getUTCDay();
    return !s.skipDays || !s.skipDays.includes(dow);
  })();

  // Trend age filter
  const trendAgeOk = !s.minTrendAge || trend.age >= s.minTrendAge;

  // Entry signals: pullback + trend + 5m ST + VWAP + momentum + filters
  const longSignal = pullbackLong && trend.bullish && stBullish && aboveVwap
    && kCrossUp && stochLongOk && trendAgeOk
    && adxOk && diLongOk && volOk && cooldownOk && reentryOk && sessionOk && dowOk;
  const shortSignal = pullbackShort && trend.bearish && stBearish && belowVwap
    && kCrossDown && stochShortOk && trendAgeOk
    && adxOk && diShortOk && volOk && cooldownOk && reentryOk && sessionOk && dowOk;

  return {
    longSignal,
    shortSignal,
    stBullish,
    stBearish,
    stFlippedBearish,
    stFlippedBullish,
    atrVal,
    price: closes[i],
    ema: ema21[i],
    vwap: vwapValues[i],
    adx: adxVal,
    stochK: stochRsi.k[i],
    stochD: stochRsi.d[i],
    volOk,
    cooldownOk,
    reentryOk,
    sessionOk,
    dowOk,
    trend,
    conditions: {
      pullbackLong, pullbackShort,
      aboveVwap, belowVwap,
      kCrossUp, kCrossDown,
      stochLongOk, stochShortOk,
      adxOk, diLongOk, diShortOk,
      volOk, cooldownOk, reentryOk, sessionOk, dowOk, trendAgeOk,
    },
  };
}

/**
 * Determine action based on signal + current position
 */
function decide(signal, position, state) {
  const { price, atrVal } = signal;

  // No position — check entries
  if (!position) {
    if (signal.longSignal && !state.longTriggered) {
      const sl = price - atrVal * s.slMult;
      const tp = price + atrVal * s.tpMult;
      return { action: "open_long", sl, tp, reason: "EMA pullback long" };
    }
    if (signal.shortSignal && !state.shortTriggered) {
      const sl = price + atrVal * s.slMult;
      const tp = price - atrVal * s.tpMult;
      return { action: "open_short", sl, tp, reason: "EMA pullback short" };
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

  // Max duration
  if (s.maxBarsTrade > 0 && state.barsInTrade >= s.maxBarsTrade) {
    return { action: "close", reason: "Max duration reached" };
  }

  // Progressive trailing stop
  if (s.useTrailRest) {
    if (unrealizedR >= s.trailBeR && state.activeSl !== entryPrice) {
      return { action: "move_sl_be", reason: `Moving SL to BE at ${unrealizedR.toFixed(1)}R` };
    }
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

  // 5m Supertrend flip
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

module.exports = { trendFilter, analyze, decide };
