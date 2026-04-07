const { RestClientV5 } = require("bybit-api");
const ind = require("./indicators");
const config = require("./config");

const s = { ...config.strategy };
// Use the best params from optimization
s.slMult = 2.2;
s.tpMult = 4.0;
s.partialMult = 2.0;

const client = new RestClientV5({ testnet: false });

// ─── TOP BYBIT FUTURES PAIRS ─────────────────────────────────────────────────

const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
  "1000PEPEUSDT", "WIFUSDT", "SUIUSDT", "AVAXUSDT", "LINKUSDT",
  "ADAUSDT", "NEARUSDT", "ARBUSDT", "OPUSDT", "APTUSDT",
  "DOTUSDT", "MATICUSDT", "LTCUSDT", "FILUSDT", "INJUSDT",
];

// ─── FETCH ───────────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, startTime, endTime) {
  const all = [];
  let cursor = startTime;

  while (cursor < endTime) {
    let result;
    try {
      const resp = await client.getKline({
        category: "linear", symbol, interval, start: cursor, limit: 1000,
      });
      result = resp.result;
    } catch { break; }

    if (!result?.list?.length) break;

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

    if (!candles.length) break;
    all.push(...candles);
    const lastTs = candles[candles.length - 1].timestamp;
    if (lastTs <= cursor) break;
    cursor = lastTs + 1;
    await new Promise((r) => setTimeout(r, 150));
  }

  const seen = new Set();
  return all.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
}

// ─── QUICK BACKTEST (simplified for speed) ───────────────────────────────────

function runBacktest(ltfCandles, dCandles, wCandles, mCandles) {
  if (ltfCandles.length < 100) return null;

  const closes = ltfCandles.map((c) => c.close);
  const highs = ltfCandles.map((c) => c.high);
  const lows = ltfCandles.map((c) => c.low);
  const volumes = ltfCandles.map((c) => c.volume);

  // HTF EMAs
  const dCloses = dCandles.map((c) => c.close);
  const wCloses = wCandles.map((c) => c.close);
  const mCloses = mCandles.map((c) => c.close);
  const dEmaF = ind.ema(dCloses, s.htfEmaFast);
  const dEmaS = ind.ema(dCloses, s.htfEmaSlow);
  const wEmaF = ind.ema(wCloses, s.htfEmaFast);
  const wEmaS = ind.ema(wCloses, s.htfEmaSlow);
  const mEmaF = ind.ema(mCloses, s.htfEmaFast);
  const mEmaS = ind.ema(mCloses, s.htfEmaSlow);

  function getMtf(ts) {
    const di = dCandles.findLastIndex((c) => c.timestamp < ts);
    const wi = wCandles.findLastIndex((c) => c.timestamp < ts);
    const mi = mCandles.findLastIndex((c) => c.timestamp < ts);
    const dT = di > 0 && dEmaF[di] && dEmaS[di] ? (dEmaF[di] > dEmaS[di] ? 1 : -1) : 0;
    const wT = wi > 0 && wEmaF[wi] && wEmaS[wi] ? (wEmaF[wi] > wEmaS[wi] ? 1 : -1) : 0;
    const mT = mi > 0 && mEmaF[mi] && mEmaS[mi] ? (mEmaF[mi] > mEmaS[mi] ? 1 : -1) : 0;
    const bc = [dT, wT, mT].filter((t) => t === 1).length;
    const brc = [dT, wT, mT].filter((t) => t === -1).length;
    return { htfBull: bc >= s.htfMinAgree, htfBear: brc >= s.htfMinAgree, score: dT + wT + mT };
  }

  // LTF indicators
  const vwapV = ind.vwap(ltfCandles);
  const st = ind.supertrend(highs, lows, closes, s.stAtrLen, s.stFactor);
  const srsi = ind.stochRsi(closes, s.rsiLen, s.stochLen, s.stochK, s.stochD);
  const atrV = ind.atr(highs, lows, closes, 14);
  const dmiR = ind.dmi(highs, lows, closes, s.adxLen);
  const volS = ind.sma(volumes, s.volSmaLen);

  const trades = [];
  let pos = null;
  let equity = 1000;
  let longTrig = false, shortTrig = false;
  let bSinceLoss = 999, bSinceClose = 999;
  const COMM = 0.0004;
  const warmup = 60;

  for (let i = warmup; i < ltfCandles.length; i++) {
    const price = closes[i];
    const hi = highs[i];
    const lo = lows[i];
    const ts = ltfCandles[i].timestamp;
    const mtf = getMtf(ts);

    const stBull = st.direction[i] === -1;
    const stBear = st.direction[i] === 1;
    const stFlipBear = i > 0 && st.direction[i] === 1 && st.direction[i - 1] === -1;
    const stFlipBull = i > 0 && st.direction[i] === -1 && st.direction[i - 1] === 1;

    if (stFlipBear) longTrig = false;
    if (stFlipBull) shortTrig = false;

    // Exits
    if (pos) {
      const isL = pos.side === "Buy";
      if (isL) pos.highest = Math.max(pos.highest, hi);
      else pos.lowest = Math.min(pos.lowest, lo);

      // Trailing after partial
      if (pos.partialDone && s.useTrailRest) {
        if (isL) pos.sl = Math.max(pos.sl, pos.highest - pos.entryAtr * s.trailAtrMult);
        else pos.sl = Math.min(pos.sl, pos.lowest + pos.entryAtr * s.trailAtrMult);
      }

      let closed = false;
      if (isL && lo <= pos.sl) { close(pos, Math.max(pos.sl, lo), i); closed = true; }
      else if (!isL && hi >= pos.sl) { close(pos, Math.min(pos.sl, hi), i); closed = true; }
      else if (isL && hi >= pos.tp) { close(pos, Math.min(pos.tp, hi), i); closed = true; }
      else if (!isL && lo <= pos.tp) { close(pos, Math.max(pos.tp, lo), i); closed = true; }
      else if (s.maxBarsTrade > 0 && (i - pos.bar) >= s.maxBarsTrade) { close(pos, price, i); closed = true; }
      else if (isL && stFlipBear) {
        const uR = (price - pos.ep) / pos.entryAtr;
        if (s.beOnStFlip && uR > 0) pos.sl = Math.max(pos.sl, pos.ep);
        else { close(pos, price, i); closed = true; }
      }
      else if (!isL && stFlipBull) {
        const uR = (pos.ep - price) / pos.entryAtr;
        if (s.beOnStFlip && uR > 0) pos.sl = Math.min(pos.sl, pos.ep);
        else { close(pos, price, i); closed = true; }
      }

      // Partial TP
      if (!closed && !pos.partialDone) {
        if (isL && hi >= pos.ptp) {
          equity += equity * ((pos.ptp - pos.ep) / pos.ep) * s.partialPct - equity * COMM * 2 * s.partialPct;
          pos.partialDone = true;
          pos.sl = pos.ep;
          pos.sizeMult = 1 - s.partialPct;
        } else if (!isL && lo <= pos.ptp) {
          equity += equity * ((pos.ep - pos.ptp) / pos.ep) * s.partialPct - equity * COMM * 2 * s.partialPct;
          pos.partialDone = true;
          pos.sl = pos.ep;
          pos.sizeMult = 1 - s.partialPct;
        }
      }
    }

    // Entries
    if (!pos) {
      bSinceClose++; bSinceLoss++;
      const atr = atrV[i];
      if (!atr) continue;
      const adxOk = !s.useAdx || (dmiR.adx[i] && dmiR.adx[i] > s.adxThresh);
      const diLOk = !s.useDi || dmiR.diPlus[i] > dmiR.diMinus[i];
      const diSOk = !s.useDi || dmiR.diMinus[i] > dmiR.diPlus[i];
      const vOk = !s.useVol || volumes[i] > volS[i] * s.volMult;
      const cdOk = s.cooldownBars === 0 || bSinceLoss > s.cooldownBars;
      const reOk = s.minBarsReentry === 0 || bSinceClose > s.minBarsReentry;
      const kUp = ind.crossover(srsi.k, srsi.d, i);
      const kDn = ind.crossunder(srsi.k, srsi.d, i);
      const sLOk = srsi.k[i-1] !== null && srsi.k[i-1] < s.osLevel;
      const sSOk = srsi.k[i-1] !== null && srsi.k[i-1] > (100 - s.osLevel);

      const longSig = price > vwapV[i] && stBull && kUp && sLOk && adxOk && diLOk && vOk && mtf.htfBull && cdOk && reOk && !longTrig;
      const shortSig = price < vwapV[i] && stBear && kDn && sSOk && adxOk && diSOk && vOk && mtf.htfBear && cdOk && reOk && !shortTrig;

      if (longSig) {
        pos = { side: "Buy", ep: price, entryAtr: atr, sl: price - atr * s.slMult, tp: price + atr * s.tpMult, ptp: price + atr * s.partialMult, partialDone: false, bar: i, highest: price, lowest: price, sizeMult: 1 };
        longTrig = true;
        equity -= equity * COMM;
      } else if (shortSig) {
        pos = { side: "Sell", ep: price, entryAtr: atr, sl: price + atr * s.slMult, tp: price - atr * s.tpMult, ptp: price - atr * s.partialMult, partialDone: false, bar: i, highest: price, lowest: price, sizeMult: 1 };
        shortTrig = true;
        equity -= equity * COMM;
      }
    }
  }

  function close(p, exitPrice, idx) {
    const isL = p.side === "Buy";
    const pnl = isL ? ((exitPrice - p.ep) / p.ep) * p.sizeMult : ((p.ep - exitPrice) / p.ep) * p.sizeMult;
    equity += equity * pnl - equity * COMM;
    trades.push({ pnl: pnl * 100, r: isL ? (exitPrice - p.ep) / p.entryAtr : (p.ep - exitPrice) / p.entryAtr, side: p.side });
    if (pnl < 0) bSinceLoss = 0;
    bSinceClose = 0;
    longTrig = false; shortTrig = false;
    pos = null;
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const longs = trades.filter((t) => t.side === "Buy");
  const pf = losses.length > 0 ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0)) / Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) : wins.length > 0 ? 99 : 0;

  let maxDD = 0, peak = 1000, eq = 1000;
  for (const t of trades) {
    eq += eq * (t.pnl / 100);
    if (eq > peak) peak = eq;
    const dd = ((peak - eq) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    longs: longs.length,
    shorts: trades.length - longs.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    netPnl: ((equity / 1000) - 1) * 100,
    profitFactor: pf,
    avgR: trades.length > 0 ? trades.reduce((s, t) => s + t.r, 0) / trades.length : 0,
    maxDD,
    equity,
  };
}

// ─── SCAN ────────────────────────────────────────────────────────────────────

async function scan() {
  const months = parseInt(process.argv[2] || "2");
  const tf = process.argv[3] || "15";
  const now = Date.now();
  const startTime = now - months * 30 * 86400000;

  console.log(`\nScanning ${PAIRS.length} pairs | ${tf}m | ${months} months\n`);

  const results = [];

  for (const symbol of PAIRS) {
    process.stdout.write(`  Testing ${symbol}...`);
    try {
      const [ltf, d, w, m] = await Promise.all([
        fetchCandles(symbol, tf, startTime, now),
        fetchCandles(symbol, "D", startTime - 120 * 86400000, now),
        fetchCandles(symbol, "W", startTime - 365 * 86400000, now),
        fetchCandles(symbol, "M", startTime - 730 * 86400000, now),
      ]);

      const r = runBacktest(ltf, d, w, m);
      if (r) {
        results.push({ symbol, ...r });
        const pnlStr = r.netPnl >= 0 ? `+${r.netPnl.toFixed(1)}%` : `${r.netPnl.toFixed(1)}%`;
        console.log(` ${r.trades} trades | ${pnlStr} | WR ${r.winRate.toFixed(0)}% | PF ${r.profitFactor.toFixed(2)}`);
      } else {
        console.log(" skipped (not enough data)");
      }
    } catch (err) {
      console.log(` error: ${err.message}`);
    }
  }

  // Sort by net P&L
  results.sort((a, b) => b.netPnl - a.netPnl);

  console.log("\n" + "=".repeat(85));
  console.log("  PAIR RANKING — sorted by Net Profit");
  console.log("=".repeat(85));
  console.log(
    `  ${"Pair".padEnd(16)} ${"Trades".padEnd(8)} ${"L/S".padEnd(8)} ${"WinRate".padEnd(9)} ${"Net P&L".padEnd(10)} ${"PF".padEnd(6)} ${"AvgR".padEnd(7)} ${"MaxDD".padEnd(7)}`
  );
  console.log("  " + "─".repeat(80));

  for (const r of results) {
    const pnl = r.netPnl >= 0 ? `+${r.netPnl.toFixed(1)}%` : `${r.netPnl.toFixed(1)}%`;
    const ls = `${r.longs}/${r.shorts}`;
    console.log(
      `  ${r.symbol.padEnd(16)} ${String(r.trades).padEnd(8)} ${ls.padEnd(8)} ${(r.winRate.toFixed(1) + "%").padEnd(9)} ${pnl.padEnd(10)} ${r.profitFactor.toFixed(2).padEnd(6)} ${r.avgR.toFixed(2).padEnd(7)} ${r.maxDD.toFixed(1)}%`
    );
  }

  console.log("\n" + "=".repeat(85));

  const profitable = results.filter((r) => r.netPnl > 0);
  const losing = results.filter((r) => r.netPnl <= 0);
  console.log(`  Profitable: ${profitable.length}/${results.length} pairs`);
  if (profitable.length > 0) {
    console.log(`  Best: ${profitable[0].symbol} (+${profitable[0].netPnl.toFixed(1)}%)`);
  }
  if (losing.length > 0) {
    console.log(`  Worst: ${losing[losing.length - 1].symbol} (${losing[losing.length - 1].netPnl.toFixed(1)}%)`);
  }
  console.log();
}

scan().catch((err) => {
  console.error("Scanner failed:", err.message);
  process.exit(1);
});
