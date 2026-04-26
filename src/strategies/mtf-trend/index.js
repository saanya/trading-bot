const config = require("./config");
const exchange = require("../../common/exchange");
const strategy = require("./strategy");
const log = require("../../common/logger");
const tg = require("../../common/telegram");
const s = config.strategy;

let tickRunning = false;

// Persistent state across ticks
const state = {
  entryPrice: null,
  entryAtr: null,
  activeSl: null,
  activeTp: null,
  partial1: null,
  partial2: null,
  partialLevel: 0,   // 0 = none, 1 = first partial done, 2 = both done
  highestSince: null,
  lowestSince: null,
  barsInTrade: 0,
  barsSinceLoss: 999,
  barsSinceClose: 999,
  longTriggered: false,
  shortTriggered: false,
};

function resetTradeState() {
  state.entryPrice = null;
  state.entryAtr = null;
  state.activeSl = null;
  state.activeTp = null;
  state.partial1 = null;
  state.partial2 = null;
  state.partialLevel = 0;
  state.highestSince = null;
  state.lowestSince = null;
  state.barsInTrade = 0;
  state.longTriggered = false;
  state.shortTriggered = false;
}

function trendLabel(t) {
  return t === 1 ? "BULL" : t === -1 ? "BEAR" : "FLAT";
}

/**
 * Main bot tick — runs once per candle close
 */
async function tick() {
  tickRunning = true;
  try {
  const { symbol, timeframe } = config;

  // Fetch candle data: LTF + HTF
  const [rawLtf, dCandles, wCandles, mCandles] = await Promise.all([
    exchange.getCandles(symbol, timeframe, 200),
    exchange.getCandles(symbol, "D", 100),
    exchange.getCandles(symbol, "W", 100),
    exchange.getCandles(symbol, "M", 60),
  ]);
  // Strip in-progress candle so analyze() sees only completed bars (fixes volume filter)
  const ltfCandles = exchange.stripCurrentBar(rawLtf, timeframe);

  // Analyze MTF trend
  const mtf = strategy.analyzeMtfTrend({ D: dCandles, W: wCandles, M: mCandles });

  log.info(
    `HTF Trend — Monthly: ${trendLabel(mtf.monthly)} | Weekly: ${trendLabel(mtf.weekly)} | Daily: ${trendLabel(mtf.daily)} | Score: ${mtf.trendScore}`
  );

  // Analyze current TF
  const signal = strategy.analyze(ltfCandles, mtf, state);

  log.debug(
    `LTF — Price: ${signal.price} | VWAP: ${signal.vwap?.toFixed(2)} | ST: ${signal.stBullish ? "BULL" : "BEAR"} | StochK: ${signal.stochK?.toFixed(1)} | ADX: ${signal.adx?.toFixed(1)} | Vol: ${signal.volOk ? "OK" : "LOW"}`
  );

  // Get current position
  const position = await exchange.getPosition(symbol);

  // Update state tracking
  if (position) {
    state.barsInTrade++;
    if (position.side === "Buy") {
      state.highestSince = Math.max(state.highestSince || 0, signal.price);
    } else {
      state.lowestSince = Math.min(state.lowestSince || Infinity, signal.price);
    }
  } else if (state.entryPrice !== null) {
    // Exchange closed position (server-side SL/TP)
    const isLong = state.activeSl < state.entryPrice;
    const pnlPositive = isLong ? signal.price >= state.entryPrice : signal.price <= state.entryPrice;
    const reason = pnlPositive ? "Exchange TP hit" : "Exchange SL hit";
    const estimatedExit = pnlPositive ? state.activeTp : state.activeSl;
    const pnlPct = isLong
      ? (estimatedExit - state.entryPrice) / state.entryPrice
      : (state.entryPrice - estimatedExit) / state.entryPrice;
    const pnl = pnlPct * config.positionSize;
    log.info(`${reason} — ${isLong ? "LONG" : "SHORT"} ${symbol} — est. PnL: ${pnl.toFixed(4)}`);
    tg.notifyClose(symbol, isLong ? "Buy" : "Sell", state.entryPrice, estimatedExit, pnl, reason, state.barsInTrade);
    if (!pnlPositive) state.barsSinceLoss = 0;
    state.barsSinceClose = 0;
    const savedTriggers = { long: state.longTriggered, short: state.shortTriggered };
    resetTradeState();
    state.longTriggered = savedTriggers.long;
    state.shortTriggered = savedTriggers.short;
  } else {
    state.barsSinceClose++;
    state.barsSinceLoss++;
  }

  // Reset triggers on Supertrend flip
  if (signal.stFlippedBearish) state.longTriggered = false;
  if (signal.stFlippedBullish) state.shortTriggered = false;

  // Decide action
  const decision = strategy.decide(signal, position, state);

  log.info(`Decision: ${decision.action} — ${decision.reason}`);

  // Execute
  switch (decision.action) {
    case "open_long": {
      const qty = (config.positionSize / signal.price).toFixed(4);
      await exchange.marketOrder(symbol, "Buy", qty);
      state.entryPrice = signal.price;
      state.entryAtr = signal.atrVal;
      state.activeSl = decision.sl;
      state.activeTp = decision.tp;
      state.partial1 = decision.partial1;
      state.partial2 = decision.partial2;
      state.partialLevel = 0;
      state.highestSince = signal.price;
      state.lowestSince = signal.price;
      state.barsInTrade = 0;
      state.longTriggered = true;

      try {
        await exchange.setTradingStop(symbol, decision.sl, decision.tp);
      } catch (err) {
        log.error(`CRITICAL: Failed to set SL/TP on LONG entry: ${err.message}`);
        tg.notifyError?.(`Failed to set SL/TP on LONG ${symbol}: ${err.message}`);
      }
      log.info(
        `LONG ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(2)} | TP: ${decision.tp.toFixed(2)}`
      );
      tg.notifyOpen(symbol, "Buy", signal.price, decision.sl, decision.tp, decision.partial1, decision.partial2);
      break;
    }

    case "open_short": {
      const qty = (config.positionSize / signal.price).toFixed(4);
      await exchange.marketOrder(symbol, "Sell", qty);
      state.entryPrice = signal.price;
      state.entryAtr = signal.atrVal;
      state.activeSl = decision.sl;
      state.activeTp = decision.tp;
      state.partial1 = decision.partial1;
      state.partial2 = decision.partial2;
      state.partialLevel = 0;
      state.highestSince = signal.price;
      state.lowestSince = signal.price;
      state.barsInTrade = 0;
      state.shortTriggered = true;

      try {
        await exchange.setTradingStop(symbol, decision.sl, decision.tp);
      } catch (err) {
        log.error(`CRITICAL: Failed to set SL/TP on SHORT entry: ${err.message}`);
        tg.notifyError?.(`Failed to set SL/TP on SHORT ${symbol}: ${err.message}`);
      }
      log.info(
        `SHORT ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(2)} | TP: ${decision.tp.toFixed(2)}`
      );
      tg.notifyOpen(symbol, "Sell", signal.price, decision.sl, decision.tp, decision.partial1, decision.partial2);
      break;
    }

    case "partial_close_1": {
      const closeQty = (position.size * config.strategy.partial1Pct).toFixed(4);
      const closeSide = position.side === "Buy" ? "Sell" : "Buy";
      await exchange.reduceOrder(symbol, closeSide, closeQty);
      state.partialLevel = 1;
      log.info(`Partial TP1: closed ${closeQty} (33%) — ${decision.reason}`);
      tg.notifyPartial(symbol, 1, closeQty, decision.reason);
      break;
    }

    case "partial_close_2": {
      const closeQty = (position.size * config.strategy.partial2Pct).toFixed(4);
      const closeSide = position.side === "Buy" ? "Sell" : "Buy";
      await exchange.reduceOrder(symbol, closeSide, closeQty);
      state.partialLevel = 2;
      try {
        await exchange.setTradingStop(symbol, state.entryPrice, state.activeTp);
        state.activeSl = state.entryPrice; // only update state after successful API call
      } catch (err) {
        log.warn(`Failed to move SL to BE after TP2: ${err.message}`);
      }
      log.info(`Partial TP2: closed ${closeQty} (33%) — SL to BE — ${decision.reason}`);
      tg.notifyPartial(symbol, 2, closeQty, decision.reason);
      break;
    }

    case "move_sl_be": {
      try {
        await exchange.setTradingStop(symbol, state.entryPrice, state.activeTp);
        state.activeSl = state.entryPrice;
        log.info(`SL moved to breakeven: ${state.entryPrice}`);
      } catch (err) {
        log.warn(`Failed to move SL to BE: ${err.message}`);
      }
      break;
    }

    case "close": {
      await exchange.closePosition(symbol);
      const pnl = position ? position.unrealisedPnl : 0;
      if (pnl < 0) state.barsSinceLoss = 0;
      state.barsSinceClose = 0;
      log.info(`Position closed — PnL: ${pnl} — ${decision.reason}`);
      tg.notifyClose(symbol, position?.side || "Buy", state.entryPrice || 0, signal.price, pnl, decision.reason, state.barsInTrade);
      resetTradeState();
      break;
    }

    case "hold":
      log.debug(decision.reason);
      break;

    case "none": {
      const c = signal.conditions;
      const m = signal.mtf;
      const p = (v) => v ? "✓" : "✗";
      log.info(
        `No signal | VWAP: ${p(c.aboveVwap)}↑${p(c.belowVwap)}↓ | ST: ${signal.stBullish ? "BULL" : "BEAR"} | ` +
        `StochK: ${p(c.kCrossUp)}↑${p(c.kCrossDown)}↓ zone:${p(c.stochLongOk)}L${p(c.stochShortOk)}S | ` +
        `ADX: ${p(c.adxOk)}(${signal.adx?.toFixed(0)}) DI: ${p(c.diLongOk)}L${p(c.diShortOk)}S | ` +
        `Vol: ${p(c.volOk)} | HTF: D=${m.daily} W=${m.weekly} M=${m.monthly} bull:${p(m.htfBullish)} bear:${p(m.htfBearish)} | ` +
        `CD: ${p(c.cooldownOk)} RE: ${p(c.reentryOk)} Ses: ${p(c.sessionOk)} DoW: ${p(c.dowOk)} | ` +
        `Triggered: L=${state.longTriggered} S=${state.shortTriggered}`
      );
      break;
    }
  }
  } finally {
    tickRunning = false;
  }
}

/**
 * Lightweight 1-minute position management tick
 * Checks partials, trailing stop, and exchange-side closures
 */
async function manageTick() {
  if (tickRunning) return;

  const { symbol } = config;

  try {
    const [price, position] = await Promise.all([
      exchange.getTicker(symbol),
      exchange.getPosition(symbol),
    ]);

    // Exchange-side closure detection
    if (!position && state.entryPrice !== null) {
      const isLong = state.activeSl < state.entryPrice;
      const pnlPositive = isLong ? price >= state.entryPrice : price <= state.entryPrice;
      const reason = pnlPositive ? "Exchange TP hit" : "Exchange SL hit";
      const estimatedExit = pnlPositive ? state.activeTp : state.activeSl;
      const pnlPct = isLong
        ? (estimatedExit - state.entryPrice) / state.entryPrice
        : (state.entryPrice - estimatedExit) / state.entryPrice;
      const pnl = pnlPct * config.positionSize;

      log.info(`[manageTick] ${reason} — ${isLong ? "LONG" : "SHORT"} ${symbol} — est. PnL: ${pnl.toFixed(4)}`);
      tg.notifyClose(symbol, isLong ? "Buy" : "Sell", state.entryPrice, estimatedExit, pnl, reason, state.barsInTrade);

      if (!pnlPositive) state.barsSinceLoss = 0;
      state.barsSinceClose = 0;
      const savedTriggers = { long: state.longTriggered, short: state.shortTriggered };
      resetTradeState();
      state.longTriggered = savedTriggers.long;
      state.shortTriggered = savedTriggers.short;
      return;
    }

    // Nothing to manage
    if (!position || !state.entryAtr) return;

    const isLong = position.side === "Buy";
    const entryPrice = state.entryPrice || position.entryPrice;
    const entryAtr = state.entryAtr;

    // Update highest/lowest with live price
    if (isLong) {
      state.highestSince = Math.max(state.highestSince || 0, price);
    } else {
      state.lowestSince = Math.min(state.lowestSince || Infinity, price);
    }

    const unrealizedR = isLong
      ? (price - entryPrice) / entryAtr
      : (entryPrice - price) / entryAtr;

    // Partial TP1
    if (s.usePartial && state.partialLevel < 1) {
      if ((isLong && price >= state.partial1) || (!isLong && price <= state.partial1)) {
        const closeQty = (position.size * s.partial1Pct).toFixed(4);
        const closeSide = isLong ? "Sell" : "Buy";
        await exchange.reduceOrder(symbol, closeSide, closeQty);
        state.partialLevel = 1;
        const reason = `Partial TP1 at ${unrealizedR.toFixed(1)}R`;
        log.info(`[manageTick] ${reason} — closed ${closeQty}`);
        tg.notifyPartial(symbol, 1, closeQty, reason);
        return;
      }
    }

    // Partial TP2
    if (s.usePartial && state.partialLevel === 1) {
      if ((isLong && price >= state.partial2) || (!isLong && price <= state.partial2)) {
        const closeQty = (position.size * s.partial2Pct).toFixed(4);
        const closeSide = isLong ? "Sell" : "Buy";
        await exchange.reduceOrder(symbol, closeSide, closeQty);
        state.partialLevel = 2;
        try {
          await exchange.setTradingStop(symbol, entryPrice, state.activeTp);
          state.activeSl = entryPrice; // only update state after successful API call
        } catch (err) {
          log.warn(`[manageTick] Failed to move SL to BE after TP2: ${err.message}`);
        }
        const reason = `Partial TP2 at ${unrealizedR.toFixed(1)}R`;
        log.info(`[manageTick] ${reason} — closed ${closeQty} — SL to BE`);
        tg.notifyPartial(symbol, 2, closeQty, reason);
        return;
      }
    }

    // Progressive trailing stop (activate after TP1 or when partials disabled)
    if (s.useTrailRest && (state.partialLevel >= 1 || !s.usePartial)) {
      // Move SL to breakeven at +1R
      if (unrealizedR >= s.trailBeR && state.activeSl !== entryPrice) {
        try {
          await exchange.setTradingStop(symbol, entryPrice, state.activeTp);
          state.activeSl = entryPrice; // only update state after successful API call
          log.info(`[manageTick] SL → BE at ${unrealizedR.toFixed(1)}R`);
        } catch (err) {
          log.warn(`[manageTick] Failed to move SL to BE: ${err.message}`);
        }
        return;
      }

      // Active trailing at +2R
      if (unrealizedR >= s.trailStartR) {
        let trailSl, trailHit;

        if (isLong) {
          trailSl = Math.max(entryPrice, state.highestSince - entryAtr * s.trailAtrMult);
          trailHit = price <= trailSl;
        } else {
          trailSl = Math.min(entryPrice, state.lowestSince + entryAtr * s.trailAtrMult);
          trailHit = price >= trailSl;
        }

        if (trailHit) {
          await exchange.closePosition(symbol);
          const pnl = position.unrealisedPnl;
          const reason = `Trailing stop at ${unrealizedR.toFixed(1)}R`;
          log.info(`[manageTick] ${reason}`);
          tg.notifyClose(symbol, position.side, entryPrice, price, pnl, reason, state.barsInTrade);
          if (pnl < 0) state.barsSinceLoss = 0;
          state.barsSinceClose = 0;
          resetTradeState();
          return;
        }

        // Update exchange-side SL if trail improved
        const slImproved = isLong ? trailSl > state.activeSl : trailSl < state.activeSl;
        // Safety: don't set SL past current price (would trigger immediately with slippage)
        const slSafe = isLong ? trailSl < price : trailSl > price;
        if (slImproved && slSafe) {
          try {
            await exchange.setTradingStop(symbol, trailSl, state.activeTp);
            state.activeSl = trailSl; // only update state AFTER successful API call
            log.debug(`[manageTick] Trail SL → ${trailSl.toFixed(4)}`);
          } catch (err) {
            log.warn(`[manageTick] Failed to update trail SL: ${err.message}`);
          }
        } else if (slImproved && !slSafe) {
          // Trail SL is past current price — close at market instead
          log.info(`[manageTick] Trail SL ${trailSl.toFixed(4)} past price ${price.toFixed(4)} — closing`);
          await exchange.closePosition(symbol);
          const pnl = position ? position.unrealisedPnl : 0;
          const reason = `Trailing stop (market close at ${unrealizedR.toFixed(1)}R)`;
          tg.notifyClose(symbol, position.side, entryPrice, price, pnl, reason, state.barsInTrade);
          if (pnl < 0) state.barsSinceLoss = 0;
          state.barsSinceClose = 0;
          resetTradeState();
          return;
        }
      }
    }

    log.debug(`[manageTick] ${symbol} @ ${price} | ${unrealizedR.toFixed(1)}R`);
  } catch (err) {
    log.warn(`[manageTick] Error: ${err.message}`);
  }
}

/**
 * Calculate ms until next candle close
 */
function msUntilNextCandle() {
  const tf = config.timeframe;
  let intervalMs;

  if (tf === "D") intervalMs = 86400000;
  else if (tf === "W") intervalMs = 604800000;
  else if (tf === "M") intervalMs = 2592000000;
  else intervalMs = parseInt(tf) * 60000;

  const now = Date.now();
  const next = Math.ceil(now / intervalMs) * intervalMs;
  return next - now + 8000; // +8s buffer for candle to finalize
}

/**
 * Main loop
 */
async function main() {
  log.info("=".repeat(60));
  log.info(`MTF Trend Scalper Bot v3`);
  log.info(`Symbol: ${config.symbol} | TF: ${config.timeframe}m | Leverage: ${config.leverage}x`);
  log.info(`Position: $${config.positionSize} | Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} | ${config.testnet ? "TESTNET" : "MAINNET"}`);
  log.info("-".repeat(60));
  log.info(`HTF EMA: ${s.htfEmaFast}/${s.htfEmaSlow} | MinAgree: ${s.htfMinAgree} | Strict: ${s.htfStrict}`);
  log.info(`Supertrend: ATR ${s.stAtrLen}, Factor ${s.stFactor}`);
  log.info(`StochRSI: len=${s.stochLen} K=${s.stochK} D=${s.stochD} RSI=${s.rsiLen} OS=${s.osLevel}`);
  log.info(`ADX: ${s.useAdx ? `>${s.adxThresh}` : "OFF"} | DI: ${s.useDi ? "ON" : "OFF"} | Vol: ${s.useVol ? `SMA${s.volSmaLen} x${s.volMult}` : "OFF"}`);
  log.info(`Risk: SL=${s.slMult}x ATR | TP=${s.tpMult}x ATR`);
  log.info(`Partial: ${s.usePartial ? `ON (${s.partial1Mult}R/${s.partial2Mult}R)` : "OFF"} | Trail: BE@${s.trailBeR}R Start@${s.trailStartR}R ATR*${s.trailAtrMult}`);
  log.info(`Session: ${s.useSessionFilter ? `skip ${s.sessionSkipStart}:00-${s.sessionSkipEnd}:00 + hours [${s.sessionSkipHours}]` : "OFF"}`);
  log.info(`DOW: ${s.useDowFilter ? `skip days [${s.skipDays}]` : "OFF"} | MaxBars: ${s.maxBarsTrade} | Cooldown: ${s.cooldownBars} | STFlip→BE: ${s.beOnStFlip}`);
  log.info("=".repeat(60));

  await exchange.setLeverage(config.symbol, config.leverage);

  // Run first tick immediately
  try {
    await tick();
  } catch (err) {
    log.error(`Tick error: ${err.message}`);
  }

  // Schedule ticks aligned to candle close
  function scheduleNext() {
    const wait = msUntilNextCandle();
    const nextTime = new Date(Date.now() + wait).toISOString();
    log.info(`Next tick at ${nextTime} (in ${Math.round(wait / 1000)}s)`);

    setTimeout(async () => {
      try {
        await tick();
      } catch (err) {
        log.error(`Tick error: ${err.message}`);
      }
      scheduleNext();
    }, wait);
  }

  scheduleNext();

  // 1-minute position management (partials, trailing, closure detection)
  setInterval(() => manageTick().catch(err => log.error(`[manageTick] Fatal: ${err.message}`)), 60000);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
