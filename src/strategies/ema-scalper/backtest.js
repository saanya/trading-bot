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

async function backtest(symbol, tfMinutes, months) {
  const now = Date.now();
  const startTime = now - months * 30 * 24 * 60 * 60 * 1000;
  const interval = String(tfMinutes);
  const trendTf = s.trendTf || "15";

  console.log(`\nFetching ${symbol} data (${months} months, ${interval}m + ${trendTf}m trend)...\n`);

  // Fetch 5m + 15m (trend) + 1m (intrabar) candles
  const [ltfCandles, oneMinCandles, trendCandles] = await Promise.all([
    fetchAllCandles(symbol, interval, startTime, now),
    fetchAllCandles(symbol, "1", startTime, now),
    fetchAllCandles(symbol, trendTf, startTime - 30 * 86400000, now), // extra for warmup
  ]);

  // Build 1m candle lookup: 5m bar start timestamp → array of 1m candles
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

  // Pre-compute 15m Supertrend for trend filter
  const trendHighs = trendCandles.map((c) => c.high);
  const trendLows = trendCandles.map((c) => c.low);
  const trendCloses = trendCandles.map((c) => c.close);
  const trendSt = ind.supertrend(trendHighs, trendLows, trendCloses, s.stAtrLen, s.stFactor);

  // Get 15m trend at a given timestamp (with optional age filter)
  function getTrend(ts) {
    const idx = trendCandles.findLastIndex((c) => c.timestamp < ts);
    if (idx < 1) return { bullish: false, bearish: false, age: 0 };
    const dir = trendSt.direction[idx];
    // Count how many consecutive bars the trend has been in this direction
    let age = 0;
    for (let j = idx; j >= 0; j--) {
      if (trendSt.direction[j] === dir) age++;
      else break;
    }
    return {
      bullish: dir === -1,
      bearish: dir === 1,
      age,
    };
  }

  // Pre-compute 5m indicators
  const closes = ltfCandles.map((c) => c.close);
  const highs = ltfCandles.map((c) => c.high);
  const lows = ltfCandles.map((c) => c.low);
  const volumes = ltfCandles.map((c) => c.volume);

  const ema21 = ind.ema(closes, s.emaLen);
  const vwapValues = ind.vwap(ltfCandles);
  const st5m = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const stochRsi = ind.stochRsi(closes, s.rsiLen, s.stochLen, s.stochK, s.stochD);
  const atrValues = ind.atr(highs, lows, closes, 14);
  const dmiResult = ind.dmi(highs, lows, closes, s.adxLen);
  const volSma = ind.sma(volumes, s.volSmaLen);

  // ─── SIMULATION ──────────────────────────────────────────────────────────

  const trades = [];
  let position = null;
  let longTriggered = false;
  let shortTriggered = false;
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

    // 15m trend filter
    const trend = getTrend(ts);

    // 5m Supertrend flip detection (for exits)
    const stFlipBear = i > 0 && st5m.direction[i] === 1 && st5m.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st5m.direction[i] === -1 && st5m.direction[i - 1] === 1;

    // Reset triggers on ST flip
    if (stFlipBear) longTriggered = false;
    if (stFlipBull) shortTriggered = false;

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

        // Progressive Trailing Stop
        if (s.useTrailRest) {
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

      // Fallback: no 1m data for this bar
      if (minuteCandles.length === 0 && !exitReason) {
        if (isLong) position.highest = Math.max(position.highest, high);
        else position.lowest = Math.min(position.lowest, low);

        if (isLong && low <= position.sl) { exitReason = "Stop Loss"; closeTrade(position, Math.max(position.sl, low), i, exitReason); }
        else if (!isLong && high >= position.sl) { exitReason = "Stop Loss"; closeTrade(position, Math.min(position.sl, high), i, exitReason); }
        else if (isLong && high >= position.tp) { exitReason = "Take Profit"; closeTrade(position, Math.min(position.tp, high), i, exitReason); }
        else if (!isLong && low <= position.tp) { exitReason = "Take Profit"; closeTrade(position, Math.max(position.tp, low), i, exitReason); }
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
      if (!atrVal || ema21[i] === null) continue;

      const sessionOk = isSessionOk(ts);
      const dowOk = isDowOk(ts);
      const cooldownOk = s.cooldownBars === 0 || barsSinceLoss > s.cooldownBars;
      const reentryOk = s.minBarsReentry === 0 || barsSinceClose > s.minBarsReentry;
      const adxOk = !s.useAdx || (dmiResult.adx[i] !== null && dmiResult.adx[i] > s.adxThresh);
      const diLongOk = !s.useDi || dmiResult.diPlus[i] > dmiResult.diMinus[i];
      const diShortOk = !s.useDi || dmiResult.diMinus[i] > dmiResult.diPlus[i];
      const volOk = !s.useVol || volumes[i] > volSma[i] * s.volMult;

      const kCrossUp = ind.crossover(stochRsi.k, stochRsi.d, i);
      const kCrossDown = ind.crossunder(stochRsi.k, stochRsi.d, i);
      const stochLongOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] < s.osLevel;
      const stochShortOk = stochRsi.k[i - 1] !== null && stochRsi.k[i - 1] > (100 - s.osLevel);

      // EMA pullback detection
      let touchedEmaLong = false;
      let touchedEmaShort = false;
      for (let b = 1; b <= s.pullbackBars && (i - b) >= 0; b++) {
        if (ema21[i - b] !== null && lows[i - b] <= ema21[i - b]) touchedEmaLong = true;
        if (ema21[i - b] !== null && highs[i - b] >= ema21[i - b]) touchedEmaShort = true;
      }
      const pullbackLong = touchedEmaLong && price > ema21[i];
      const pullbackShort = touchedEmaShort && price < ema21[i];

      // VWAP filter (price above for longs, below for shorts)
      const aboveVwap = vwapValues[i] !== null && price > vwapValues[i];
      const belowVwap = vwapValues[i] !== null && price < vwapValues[i];

      // 5m Supertrend alignment
      const st5mBull = st5m.direction[i] === -1;
      const st5mBear = st5m.direction[i] === 1;

      // Trend age filter (15m ST must be in direction for at least N bars)
      const trendAgeOk = !s.minTrendAge || trend.age >= s.minTrendAge;

      const longSig = pullbackLong && trend.bullish && st5mBull && aboveVwap && kCrossUp && stochLongOk && trendAgeOk
        && adxOk && diLongOk && volOk && cooldownOk && reentryOk
        && !longTriggered && sessionOk && dowOk;

      const shortSig = pullbackShort && trend.bearish && st5mBear && belowVwap && kCrossDown && stochShortOk && trendAgeOk
        && adxOk && diShortOk && volOk && cooldownOk && reentryOk
        && !shortTriggered && sessionOk && dowOk;

      if (showDebug && !longSig && !shortSig) {
        const p = (v) => v ? "+" : "-";
        const time = new Date(ts).toISOString().slice(0, 16).replace("T", " ");
        console.log(
          `  ${time} | PB: ${p(pullbackLong)}L${p(pullbackShort)}S | 15mST: ${trend.bullish ? "BULL" : "BEAR"} | ` +
          `StochK: ${p(kCrossUp)}U${p(kCrossDown)}D zone:${p(stochLongOk)}L${p(stochShortOk)}S | ` +
          `ADX: ${p(adxOk)} DI: ${p(diLongOk)}L${p(diShortOk)}S | Vol: ${p(volOk)} | ` +
          `CD: ${p(cooldownOk)} RE: ${p(reentryOk)} Ses: ${p(sessionOk)} DoW: ${p(dowOk)} | Trig: L=${longTriggered} S=${shortTriggered}`
        );
      }

      if (longSig) {
        position = {
          side: "Buy",
          entryPrice: price,
          entryAtr: atrVal,
          sl: price - atrVal * s.slMult,
          tp: price + atrVal * s.tpMult,
          entryBar: i,
          highest: price,
          lowest: price,
          sizeMultiplier: 1,
          entryTimestamp: ts,
        };
        longTriggered = true;
        equity -= equity * COMMISSION;
      } else if (shortSig) {
        position = {
          side: "Sell",
          entryPrice: price,
          entryAtr: atrVal,
          sl: price + atrVal * s.slMult,
          tp: price - atrVal * s.tpMult,
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
    equity -= equity * COMMISSION;

    trades.push({
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      pnlPct: pnlPct * 100,
      rMultiple,
      barsHeld: barIdx - pos.entryBar,
      reason,
      entryTime: new Date(pos.entryTimestamp).toISOString(),
      exitTime: new Date(ltfCandles[barIdx].timestamp).toISOString(),
    });

    if (pnlPct < 0) barsSinceLoss = 0;
    barsSinceClose = 0;
    longTriggered = false;
    shortTriggered = false;
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
  const minBarsHeld = totalTrades > 0 ? Math.min(...trades.map((t) => t.barsHeld)) : 0;
  const maxBarsHeld = totalTrades > 0 ? Math.max(...trades.map((t) => t.barsHeld)) : 0;

  let maxConsecWins = 0, maxConsecLosses = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pnlPct > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    maxConsecWins = Math.max(maxConsecWins, cw);
    maxConsecLosses = Math.max(maxConsecLosses, cl);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  EMA SCALPER BACKTEST — ${symbol} ${tf}m — ${months} months`);
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
  console.log(`  Avg Win:             ${avgWin.toFixed(2)}%`);
  console.log(`  Avg Loss:            ${avgLoss.toFixed(2)}%`);
  console.log(`  Avg R-Multiple:      ${avgR.toFixed(2)}R`);
  console.log(`  Avg Bars Held:       ${avgBarsHeld.toFixed(1)} (${(avgBarsHeld * tf).toFixed(0)} min / ${(avgBarsHeld * tf / 60).toFixed(1)} hrs)`);
  console.log(`  Min / Max Bars:      ${minBarsHeld} / ${maxBarsHeld}`);
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
    console.log(`  ${"#".padEnd(4)} ${"Side".padEnd(6)} ${"Entry".padEnd(12)} ${"Exit".padEnd(12)} ${"P&L%".padEnd(8)} ${"R".padEnd(6)} ${"Bars".padEnd(5)} ${"Opened".padEnd(18)} ${"Closed".padEnd(18)} Reason`);
    for (let ti = 0; ti < trades.length; ti++) {
      const t = trades[ti];
      const side = t.side === "Buy" ? "LONG" : "SHORT";
      const opened = t.entryTime.slice(0, 16).replace("T", " ");
      const closed = t.exitTime.slice(0, 16).replace("T", " ");
      console.log(
        `  ${String(ti + 1).padEnd(4)} ${side.padEnd(6)} ${t.entryPrice.toFixed(6).padEnd(12)} ${t.exitPrice.toFixed(6).padEnd(12)} ${t.pnlPct.toFixed(2).padEnd(8)} ${t.rMultiple.toFixed(1).padEnd(6)} ${String(t.barsHeld).padEnd(5)} ${opened.padEnd(18)} ${closed.padEnd(18)} ${t.reason}`
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
if (args.sl) s.slMult = parseFloat(args.sl);
if (args.tp) s.tpMult = parseFloat(args.tp);
if (args.session !== undefined) s.useSessionFilter = args.session === "1";
if (args.adx) s.adxThresh = parseFloat(args.adx);
if (args.ema) s.emaLen = parseInt(args.ema);
if (args.pullback) s.pullbackBars = parseInt(args.pullback);
if (args.os) s.osLevel = parseInt(args.os);
if (args.cooldown) s.cooldownBars = parseInt(args.cooldown);
if (args.maxbars) s.maxBarsTrade = parseInt(args.maxbars);
if (args.trailbe) s.trailBeR = parseFloat(args.trailbe);
if (args.trailstart) s.trailStartR = parseFloat(args.trailstart);
if (args.trailatr) s.trailAtrMult = parseFloat(args.trailatr);
if (args.stfactor) s.stFactor = parseFloat(args.stfactor);
if (args.dow !== undefined) { s.useDowFilter = !!args.dow; s.skipDays = args.dow ? args.dow.split(",").map(Number) : []; }
if (args.toxichours !== undefined) s.sessionSkipHours = args.toxichours ? args.toxichours.split(",").map(Number) : [];
if (args.trendage) s.minTrendAge = parseInt(args.trendage);

backtest(symbol, tf, months).catch((err) => {
  console.error("Backtest failed:", err.message);
  process.exit(1);
});
