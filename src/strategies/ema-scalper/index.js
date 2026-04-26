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
  state.highestSince = null;
  state.lowestSince = null;
  state.barsInTrade = 0;
  state.longTriggered = false;
  state.shortTriggered = false;
}

/**
 * Main bot tick — runs once per 5m candle close
 */
async function tick() {
  tickRunning = true;
  try {
    const { symbol, timeframe } = config;
    const trendTf = s.trendTf || "15";

    // Fetch candle data: 5m (entry) + 15m (trend)
    const [rawLtf, trendCandles] = await Promise.all([
      exchange.getCandles(symbol, timeframe, 200),
      exchange.getCandles(symbol, trendTf, 200),
    ]);
    // Strip in-progress candle so analyze() sees only completed bars (fixes volume filter)
    const ltfCandles = exchange.stripCurrentBar(rawLtf, timeframe);

    // 15m trend filter
    const trend = strategy.trendFilter(trendCandles);

    log.info(
      `15m Trend — ${trend.bullish ? "BULL" : "BEAR"} (age: ${trend.age}) | Flipped: ${trend.flippedBullish ? "→BULL" : trend.flippedBearish ? "→BEAR" : "no"}`
    );

    // Analyze 5m candles
    const signal = strategy.analyze(ltfCandles, trend, state);

    log.debug(
      `5m — Price: ${signal.price} | EMA: ${signal.ema?.toFixed(4)} | VWAP: ${signal.vwap?.toFixed(4)} | ST: ${signal.stBullish ? "BULL" : "BEAR"} | StochK: ${signal.stochK?.toFixed(1)} | ADX: ${signal.adx?.toFixed(1)} | Vol: ${signal.volOk ? "OK" : "LOW"}`
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
          `LONG ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(4)} | TP: ${decision.tp.toFixed(4)}`
        );
        tg.notifyOpen(symbol, "Buy", signal.price, decision.sl, decision.tp);
        break;
      }

      case "open_short": {
        const qty = (config.positionSize / signal.price).toFixed(4);
        await exchange.marketOrder(symbol, "Sell", qty);
        state.entryPrice = signal.price;
        state.entryAtr = signal.atrVal;
        state.activeSl = decision.sl;
        state.activeTp = decision.tp;
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
          `SHORT ${qty} ${symbol} @ ${signal.price} | SL: ${decision.sl.toFixed(4)} | TP: ${decision.tp.toFixed(4)}`
        );
        tg.notifyOpen(symbol, "Sell", signal.price, decision.sl, decision.tp);
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
        const p = (v) => v ? "+" : "-";
        log.info(
          `No signal | PB: ${p(c.pullbackLong)}L${p(c.pullbackShort)}S | VWAP: ${p(c.aboveVwap)}↑${p(c.belowVwap)}↓ | ` +
          `ST5m: ${signal.stBullish ? "BULL" : "BEAR"} | StochK: ${p(c.kCrossUp)}↑${p(c.kCrossDown)}↓ zone:${p(c.stochLongOk)}L${p(c.stochShortOk)}S | ` +
          `ADX: ${p(c.adxOk)}(${signal.adx?.toFixed(0)}) DI: ${p(c.diLongOk)}L${p(c.diShortOk)}S | ` +
          `Vol: ${p(c.volOk)} | TrendAge: ${p(c.trendAgeOk)}(${signal.trend.age}) | ` +
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
 * Checks trailing stop and exchange-side closures
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

    // Progressive trailing stop
    if (s.useTrailRest) {
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

      // Active trailing at trailStartR
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
        // Safety: don't set SL past current price
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
  const intervalMs = parseInt(config.timeframe) * 60000;
  const now = Date.now();
  const next = Math.ceil(now / intervalMs) * intervalMs;
  return next - now + 8000; // +8s buffer for candle to finalize
}

/**
 * Main loop
 */
async function main() {
  log.info("=".repeat(60));
  log.info(`EMA Scalper Bot v1`);
  log.info(`Symbol: ${config.symbol} | TF: ${config.timeframe}m | Trend: ${s.trendTf}m | Leverage: ${config.leverage}x`);
  log.info(`Position: $${config.positionSize} | Mode: ${config.dryRun ? "DRY RUN" : "LIVE"} | ${config.testnet ? "TESTNET" : "MAINNET"}`);
  log.info("-".repeat(60));
  log.info(`EMA: ${s.emaLen} | Pullback: ${s.pullbackBars} bars | TrendAge: >=${s.minTrendAge}`);
  log.info(`Supertrend: ATR ${s.stAtrLen}, Factor ${s.stFactor}`);
  log.info(`StochRSI: len=${s.stochLen} K=${s.stochK} D=${s.stochD} RSI=${s.rsiLen} OS=${s.osLevel}`);
  log.info(`ADX: ${s.useAdx ? `>${s.adxThresh}` : "OFF"} | DI: ${s.useDi ? "ON" : "OFF"} | Vol: ${s.useVol ? `SMA${s.volSmaLen} x${s.volMult}` : "OFF"}`);
  log.info(`Risk: SL=${s.slMult}x ATR | TP=${s.tpMult}x ATR`);
  log.info(`Trail: BE@${s.trailBeR}R Start@${s.trailStartR}R ATR*${s.trailAtrMult}`);
  log.info(`Session: ${s.useSessionFilter ? `skip ${s.sessionSkipStart}:00-${s.sessionSkipEnd}:00` : "OFF"}`);
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

  // 1-minute position management (trailing, closure detection)
  setInterval(() => manageTick().catch(err => log.error(`[manageTick] Fatal: ${err.message}`)), 60000);
}

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  process.exit(1);
});
