const ind = require("../../common/indicators");
const config = require("./config");

const s = config.strategy;

/**
 * Compute 15m Supertrend direction for trend filtering
 */
function trendFilter(candles15m) {
  const highs = candles15m.map((c) => c.high);
  const lows = candles15m.map((c) => c.low);
  const closes = candles15m.map((c) => c.close);

  const st = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const i = candles15m.length - 2;

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
 * Compute the current session's opening range from 5m candles.
 * Supports multi-session: sessionStartHour can be a number or array of hours.
 * @param {Array} candles5m - 5m candle data
 * @param {number|number[]} sessionStartHour - UTC hour(s) for session open
 * @param {number} orbBars - number of bars forming the opening range
 * @returns {{ high, low, width, established, sessionId, barsIntoSession }}
 */
function getOpeningRange(candles5m, sessionStartHour, orbBars) {
  const i = candles5m.length - 1;
  const currentTs = candles5m[i].timestamp;
  const currentDate = new Date(currentTs);

  // Support array of session hours
  const hours = Array.isArray(sessionStartHour) ? sessionStartHour : [sessionStartHour];

  // Find the most recent session start from all session hours
  let bestStartTs = 0;
  for (const hour of hours) {
    const candidate = new Date(currentDate);
    candidate.setUTCHours(hour, 0, 0, 0);
    if (candidate.getTime() > currentTs) {
      candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    if (candidate.getTime() > bestStartTs) {
      bestStartTs = candidate.getTime();
    }
  }

  const sessionStartTs = bestStartTs;
  const sessionStartDate = new Date(sessionStartTs);
  const sessionId = `${sessionStartDate.toISOString().slice(0, 10)}-${sessionStartDate.getUTCHours()}`;

  // Collect bars that belong to this session's opening range
  const rangeBars = [];
  for (let j = 0; j <= i; j++) {
    if (candles5m[j].timestamp >= sessionStartTs) {
      rangeBars.push(candles5m[j]);
      if (rangeBars.length >= orbBars) break;
    }
  }

  const barsIntoSession = candles5m.filter((c) => c.timestamp >= sessionStartTs).length;

  if (rangeBars.length < orbBars) {
    return { high: null, low: null, width: 0, established: false, sessionId, barsIntoSession };
  }

  const high = Math.max(...rangeBars.map((c) => c.high));
  const low = Math.min(...rangeBars.map((c) => c.low));

  return {
    high,
    low,
    width: high - low,
    established: barsIntoSession > orbBars,
    sessionId,
    barsIntoSession,
  };
}

/**
 * Analyze 5m candles for ORB entry signals
 */
function analyze(candles5m, trend, range, state) {
  const closes = candles5m.map((c) => c.close);
  const highs = candles5m.map((c) => c.high);
  const lows = candles5m.map((c) => c.low);
  const volumes = candles5m.map((c) => c.volume);
  const i = candles5m.length - 1;
  const price = closes[i];
  const ts = candles5m[i].timestamp;

  // 5m Supertrend (for flip exit)
  const st5m = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const stBullish = st5m.direction[i] === -1;
  const stBearish = st5m.direction[i] === 1;
  const stFlippedBearish = i > 0 && st5m.direction[i] === 1 && st5m.direction[i - 1] === -1;
  const stFlippedBullish = i > 0 && st5m.direction[i] === -1 && st5m.direction[i - 1] === 1;

  // ATR
  const atrValues = ind.atr(highs, lows, closes, 14);
  const atrVal = atrValues[i];

  // ADX + DI
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const adxVal = dmiResult.adx[i];
  const adxOk = !s.useAdx || (adxVal !== null && adxVal > s.adxThresh);

  // Volume
  const volSmaArr = ind.sma(volumes, s.volSmaLen);
  const volVal = volumes[i];
  const volThresh = (volSmaArr[i] || 0) * s.volMult;
  const volOk = !s.useVol || (volVal > volThresh);

  // Session filter
  const sessionOk = !s.useSessionFilter || (() => {
    const hour = new Date(ts).getUTCHours();
    if (s.sessionSkipStart > s.sessionSkipEnd) {
      if (hour >= s.sessionSkipStart || hour < s.sessionSkipEnd) return false;
    } else {
      if (hour >= s.sessionSkipStart && hour < s.sessionSkipEnd) return false;
    }
    if (s.sessionSkipHours && s.sessionSkipHours.includes(hour)) return false;
    return true;
  })();

  // DOW filter
  const dowOk = !s.useDowFilter || (() => {
    const dow = new Date(ts).getUTCDay();
    return !s.skipDays || !s.skipDays.includes(dow);
  })();

  // Trend age filter
  const trendAgeOk = !s.minTrendAge || trend.age >= s.minTrendAge;

  // Range validation
  const rangeOk = range.established && atrVal > 0 &&
    range.width >= atrVal * s.minRangeAtr &&
    range.width <= atrVal * s.maxRangeAtr;

  // Breakout detection (close-based)
  const breakoutLong = rangeOk && price > range.high;
  const breakoutShort = rangeOk && price < range.low;

  // DI confirmation: require directional index aligned with breakout
  const diConfirmOk = !s.diConfirm || (
    breakoutLong ? (dmiResult.diPlus[i] > dmiResult.diMinus[i]) :
    breakoutShort ? (dmiResult.diMinus[i] > dmiResult.diPlus[i]) : true
  );

  // 5m Supertrend alignment: require ST direction matches breakout
  const stAlignOk = !s.stAlign || (
    breakoutLong ? stBullish :
    breakoutShort ? stBearish : true
  );

  // Entry signals
  const longSignal = breakoutLong && trend.bullish && trendAgeOk
    && adxOk && volOk && sessionOk && dowOk && diConfirmOk && stAlignOk;
  const shortSignal = breakoutShort && trend.bearish && trendAgeOk
    && adxOk && volOk && sessionOk && dowOk && diConfirmOk && stAlignOk;

  return {
    longSignal,
    shortSignal,
    stBullish,
    stBearish,
    stFlippedBearish,
    stFlippedBullish,
    atrVal,
    price,
    adx: adxVal,
    vol: volVal,
    volThresh,
    volOk,
    sessionOk,
    dowOk,
    trend,
    range,
    conditions: {
      breakoutLong, breakoutShort,
      rangeOk, trendAgeOk,
      adxOk, volOk, sessionOk, dowOk,
      diConfirmOk, stAlignOk,
    },
  };
}

/**
 * Determine action based on signal + current position
 */
function decide(signal, position, state) {
  const { price, atrVal, range } = signal;

  // No position — check entries
  if (!position) {
    if (signal.longSignal && !state.longTriggeredSession) {
      const rawSl = range.low - atrVal * s.slBuffer;
      const maxSl = price - atrVal * s.maxSlAtr;
      const sl = Math.max(rawSl, maxSl); // don't let SL be wider than maxSlAtr
      const tp = price + range.width * s.tpRangeMult;
      return { action: "open_long", sl, tp, reason: "ORB long breakout" };
    }
    if (signal.shortSignal && !state.shortTriggeredSession) {
      const rawSl = range.high + atrVal * s.slBuffer;
      const maxSl = price + atrVal * s.maxSlAtr;
      const sl = Math.min(rawSl, maxSl);
      const tp = price - range.width * s.tpRangeMult;
      return { action: "open_short", sl, tp, reason: "ORB short breakout" };
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
    if (price >= state.activeTp) return { action: "close", reason: `Take profit at ${unrealizedR.toFixed(1)}R` };
  } else {
    if (price >= state.activeSl) return { action: "close", reason: "Stop loss hit" };
    if (price <= state.activeTp) return { action: "close", reason: `Take profit at ${unrealizedR.toFixed(1)}R` };
  }

  // 5m Supertrend flip
  if (isLong && signal.stFlippedBearish) {
    if (s.beOnStFlip && inProfit) {
      return { action: "move_sl_be", reason: "ST flipped — SL to BE" };
    }
    return { action: "close", reason: "ST Flip (in loss)" };
  }
  if (!isLong && signal.stFlippedBullish) {
    if (s.beOnStFlip && inProfit) {
      return { action: "move_sl_be", reason: "ST flipped — SL to BE" };
    }
    return { action: "close", reason: "ST Flip (in loss)" };
  }

  return { action: "hold", reason: `Holding at ${unrealizedR.toFixed(1)}R` };
}

module.exports = { trendFilter, getOpeningRange, analyze, decide };
