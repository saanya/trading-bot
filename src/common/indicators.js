// Pure indicator calculations — no external dependencies
// All functions take arrays of candle data and return arrays of values

/**
 * Simple Moving Average
 */
function sma(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result[i] = sum / period;
  }
  return result;
}

/**
 * Exponential Moving Average
 */
function ema(values, period) {
  const result = new Array(values.length).fill(null);
  const k = 2 / (period + 1);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

/**
 * RSI (Relative Strength Index)
 */
function rsi(closes, period) {
  const result = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return result;

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

/**
 * Stochastic of any series (used for Stochastic RSI)
 * %K = (value - lowest) / (highest - lowest) * 100
 */
function stoch(values, period) {
  const result = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let high = -Infinity;
    let low = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (values[j] === null) continue;
      if (values[j] > high) high = values[j];
      if (values[j] < low) low = values[j];
    }
    result[i] = high === low ? 50 : ((values[i] - low) / (high - low)) * 100;
  }
  return result;
}

/**
 * Stochastic RSI — returns { k, d }
 */
function stochRsi(closes, rsiPeriod, stochPeriod, kSmooth, dSmooth) {
  const rsiValues = rsi(closes, rsiPeriod);
  const stochRaw = stoch(rsiValues, stochPeriod);
  const k = sma(stochRaw, kSmooth);
  const d = sma(k, dSmooth);
  return { k, d };
}

/**
 * ATR (Average True Range)
 */
function atr(highs, lows, closes, period) {
  const result = new Array(highs.length).fill(null);
  const tr = new Array(highs.length).fill(0);

  tr[0] = highs[0] - lows[0];
  for (let i = 1; i < highs.length; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  result[period - 1] = sum / period;

  // RMA (Wilder's smoothing)
  for (let i = period; i < highs.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
}

/**
 * Supertrend — returns { line[], direction[] }
 * direction: -1 = bullish (price above), +1 = bearish (price below)
 */
function supertrend(highs, lows, closes, atrPeriod, factor) {
  const atrValues = atr(highs, lows, closes, atrPeriod);
  const len = closes.length;
  const line = new Array(len).fill(null);
  const direction = new Array(len).fill(0);

  const upperBand = new Array(len).fill(null);
  const lowerBand = new Array(len).fill(null);

  for (let i = 0; i < len; i++) {
    if (atrValues[i] === null) continue;

    const hl2 = (highs[i] + lows[i]) / 2;
    const basicUpper = hl2 + factor * atrValues[i];
    const basicLower = hl2 - factor * atrValues[i];

    upperBand[i] =
      i > 0 && upperBand[i - 1] !== null
        ? basicUpper < upperBand[i - 1] || closes[i - 1] > upperBand[i - 1]
          ? basicUpper
          : upperBand[i - 1]
        : basicUpper;

    lowerBand[i] =
      i > 0 && lowerBand[i - 1] !== null
        ? basicLower > lowerBand[i - 1] || closes[i - 1] < lowerBand[i - 1]
          ? basicLower
          : lowerBand[i - 1]
        : basicLower;

    if (i === 0 || direction[i - 1] === 0) {
      direction[i] = closes[i] > upperBand[i] ? -1 : 1;
    } else if (direction[i - 1] === 1) {
      direction[i] = closes[i] > upperBand[i] ? -1 : 1;
    } else {
      direction[i] = closes[i] < lowerBand[i] ? 1 : -1;
    }

    line[i] = direction[i] === -1 ? lowerBand[i] : upperBand[i];
  }
  return { line, direction };
}

/**
 * VWAP (resets each day)
 * candles: [{ open, high, low, close, volume, timestamp }]
 */
function vwap(candles) {
  const result = new Array(candles.length).fill(null);
  let cumVol = 0;
  let cumTP = 0;
  let currentDay = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const day = new Date(c.timestamp).toISOString().slice(0, 10);

    if (day !== currentDay) {
      cumVol = 0;
      cumTP = 0;
      currentDay = day;
    }

    const tp = (c.high + c.low + c.close) / 3;
    cumTP += tp * c.volume;
    cumVol += c.volume;
    result[i] = cumVol > 0 ? cumTP / cumVol : tp;
  }
  return result;
}

/**
 * ADX + DI+ / DI- — returns { adx[], diPlus[], diMinus[] }
 */
function dmi(highs, lows, closes, period) {
  const len = highs.length;
  const diPlus = new Array(len).fill(null);
  const diMinus = new Array(len).fill(null);
  const adx = new Array(len).fill(null);

  const trArr = new Array(len).fill(0);
  const dmPlus = new Array(len).fill(0);
  const dmMinus = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    trArr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    dmPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    dmMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  // Smoothed with Wilder's method
  let smoothTR = 0;
  let smoothDMPlus = 0;
  let smoothDMMinus = 0;

  for (let i = 1; i <= period; i++) {
    smoothTR += trArr[i];
    smoothDMPlus += dmPlus[i];
    smoothDMMinus += dmMinus[i];
  }

  diPlus[period] = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
  diMinus[period] = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;

  let prevDX = null;
  const diSum = diPlus[period] + diMinus[period];
  if (diSum > 0) prevDX = (Math.abs(diPlus[period] - diMinus[period]) / diSum) * 100;

  for (let i = period + 1; i < len; i++) {
    smoothTR = smoothTR - smoothTR / period + trArr[i];
    smoothDMPlus = smoothDMPlus - smoothDMPlus / period + dmPlus[i];
    smoothDMMinus = smoothDMMinus - smoothDMMinus / period + dmMinus[i];

    diPlus[i] = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
    diMinus[i] = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;

    const sum = diPlus[i] + diMinus[i];
    const dx = sum > 0 ? (Math.abs(diPlus[i] - diMinus[i]) / sum) * 100 : 0;

    if (i === 2 * period && prevDX !== null) {
      // Seed ADX with SMA of DX
      adx[i] = (prevDX + dx) / 2; // simplified seed
    } else if (adx[i - 1] !== null) {
      adx[i] = (adx[i - 1] * (period - 1) + dx) / period;
    }
    prevDX = dx;
  }
  return { adx, diPlus, diMinus };
}

/**
 * Detect crossover: a crosses above b
 */
function crossover(a, b, index) {
  if (index < 1 || a[index] === null || b[index] === null || a[index - 1] === null || b[index - 1] === null)
    return false;
  return a[index - 1] <= b[index - 1] && a[index] > b[index];
}

/**
 * Detect crossunder: a crosses below b
 */
function crossunder(a, b, index) {
  if (index < 1 || a[index] === null || b[index] === null || a[index - 1] === null || b[index - 1] === null)
    return false;
  return a[index - 1] >= b[index - 1] && a[index] < b[index];
}

module.exports = {
  sma,
  ema,
  rsi,
  stoch,
  stochRsi,
  atr,
  supertrend,
  vwap,
  dmi,
  crossover,
  crossunder,
};
