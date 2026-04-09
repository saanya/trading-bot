const config = require("./config");
const exchange = require("./exchange");
const strategy = require("./strategy");
const log = require("./logger");

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
  lastTradeCount: 0,
};

function trendLabel(t) {
  return t === 1 ? "BULL" : t === -1 ? "BEAR" : "FLAT";
}

/**
 * Main bot tick — runs once per candle close
 */
async function tick() {
  const { symbol, timeframe } = config;

  // Fetch candle data: LTF + HTF
  const [ltfCandles, dCandles, wCandles, mCandles] = await Promise.all([
    exchange.getCandles(symbol, timeframe, 200),
    exchange.getCandles(symbol, "D", 100),
    exchange.getCandles(symbol, "W", 100),
    exchange.getCandles(symbol, "M", 60),
  ]);

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
  } else {
    state.barsSinceClose++;
    state.barsSinceLoss++;
  }

  // Reset triggers when not in position
  if (!position && state.entryPrice !== null) {
    state.longTriggered = false;
    state.shortTriggered = false;
    state.entryPrice = null;
    state.barsInTrade = 0;
    state.partialLevel = 0;
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

      await exchange.setTradingStop(symbol, decision.sl, decision.tp);
      log.info(
        `LONG ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(2)} | TP: ${decision.tp.toFixed(2)} | P1: ${decision.partial1.toFixed(2)} | P2: ${decision.partial2.toFixed(2)}`
      );
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

      await exchange.setTradingStop(symbol, decision.sl, decision.tp);
      log.info(
        `SHORT ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(2)} | TP: ${decision.tp.toFixed(2)} | P1: ${decision.partial1.toFixed(2)} | P2: ${decision.partial2.toFixed(2)}`
      );
      break;
    }

    case "partial_close_1": {
      const closeQty = (position.size * config.strategy.partial1Pct).toFixed(4);
      const closeSide = position.side === "Buy" ? "Sell" : "Buy";
      await exchange.reduceOrder(symbol, closeSide, closeQty);
      state.partialLevel = 1;
      log.info(`Partial TP1: closed ${closeQty} (33%) — ${decision.reason}`);
      break;
    }

    case "partial_close_2": {
      const closeQty = (position.size * config.strategy.partial2Pct).toFixed(4);
      const closeSide = position.side === "Buy" ? "Sell" : "Buy";
      await exchange.reduceOrder(symbol, closeSide, closeQty);
      state.partialLevel = 2;
      state.activeSl = state.entryPrice; // move to breakeven after both partials
      await exchange.setTradingStop(symbol, state.entryPrice, state.activeTp);
      log.info(`Partial TP2: closed ${closeQty} (33%) — SL to BE — ${decision.reason}`);
      break;
    }

    case "move_sl_be": {
      state.activeSl = state.entryPrice;
      await exchange.setTradingStop(symbol, state.entryPrice, state.activeTp);
      log.info(`SL moved to breakeven: ${state.entryPrice}`);
      break;
    }

    case "close": {
      await exchange.closePosition(symbol);
      const pnl = position ? position.unrealisedPnl : 0;
      if (pnl < 0) state.barsSinceLoss = 0;
      state.barsSinceClose = 0;
      log.info(`Position closed — PnL: ${pnl} — ${decision.reason}`);
      break;
    }

    case "hold":
      log.debug(decision.reason);
      break;

    case "none":
      log.debug("No signal, waiting...");
      break;
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
  return next - now + 5000; // +5s buffer for candle to finalize
}

/**
 * Main loop
 */
async function main() {
  log.info("=".repeat(60));
  log.info(`MTF Trend Scalper Bot v3`);
  log.info(`Symbol: ${config.symbol} | TF: ${config.timeframe}m | Leverage: ${config.leverage}x`);
  log.info(`Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} | ${config.testnet ? "TESTNET" : "MAINNET"}`);
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
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
