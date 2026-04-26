const { RestClientV5 } = require("bybit-api");
const config = require("./config");
const log = require("./logger");

const client = new RestClientV5({
  key: config.apiKey,
  secret: config.apiSecret,
  testnet: config.testnet,
});

/**
 * Fetch kline/candle data
 * @param {string} symbol
 * @param {string} interval - 1, 3, 5, 15, 30, 60, 120, 240, 360, 720, D, W, M
 * @param {number} limit - max 1000
 * @returns {Array<{timestamp, open, high, low, close, volume}>}
 */
async function getCandles(symbol, interval, limit = 200, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { result } = await client.getKline({
      category: "linear",
      symbol,
      interval,
      limit,
    });

    if (result?.list?.length) {
      return result.list
        .map((c) => ({
          timestamp: parseInt(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
        }))
        .reverse();
    }

    if (attempt < retries) {
      log.warn(`No candle data for ${symbol} ${interval}, retry ${attempt}/${retries}...`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  throw new Error(`No candle data returned for ${symbol} ${interval} after ${retries} retries`);
}

/**
 * Get current position for symbol
 */
async function getPosition(symbol) {
  const { result } = await client.getPositionInfo({
    category: "linear",
    symbol,
  });

  const pos = result?.list?.find((p) => parseFloat(p.size) > 0);
  if (!pos) return null;

  return {
    side: pos.side, // "Buy" or "Sell"
    size: parseFloat(pos.size),
    entryPrice: parseFloat(pos.avgPrice),
    unrealisedPnl: parseFloat(pos.unrealisedPnl),
    leverage: pos.leverage,
  };
}

/**
 * Set leverage for symbol
 */
async function setLeverage(symbol, leverage) {
  try {
    await client.setLeverage({
      category: "linear",
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    log.info(`Leverage set to ${leverage}x`);
  } catch (err) {
    if (err?.retCode === 110043) return; // already set
    log.warn(`Leverage warning: ${err.message || err}`);
  }
}

/**
 * Place market order
 */
async function marketOrder(symbol, side, qty) {
  if (config.dryRun) {
    log.info(`[DRY RUN] ${side} ${qty} ${symbol} @ Market`);
    return { orderId: "dry-run", side, qty };
  }

  const { result } = await client.submitOrder({
    category: "linear",
    symbol,
    side,
    orderType: "Market",
    qty: String(qty),
    timeInForce: "GTC",
  });

  log.info(`Order placed: ${side} ${qty} ${symbol} — ID: ${result.orderId}`);
  return result;
}

/**
 * Place market order to reduce position
 */
async function reduceOrder(symbol, side, qty) {
  if (config.dryRun) {
    log.info(`[DRY RUN] Reduce ${side} ${qty} ${symbol}`);
    return { orderId: "dry-run-reduce" };
  }

  const { result } = await client.submitOrder({
    category: "linear",
    symbol,
    side,
    orderType: "Market",
    qty: String(qty),
    reduceOnly: true,
    timeInForce: "GTC",
  });

  log.info(`Reduce order: ${side} ${qty} ${symbol} — ID: ${result.orderId}`);
  return result;
}

/**
 * Set stop loss and take profit for open position
 */
async function setTradingStop(symbol, stopLoss, takeProfit) {
  if (config.dryRun) {
    log.info(`[DRY RUN] SL: ${stopLoss}, TP: ${takeProfit}`);
    return;
  }

  await client.setTradingStop({
    category: "linear",
    symbol,
    stopLoss: stopLoss ? String(stopLoss.toFixed(2)) : undefined,
    takeProfit: takeProfit ? String(takeProfit.toFixed(2)) : undefined,
    slTriggerBy: "MarkPrice",
    tpTriggerBy: "LastPrice",
  });

  log.info(`Trading stop set — SL: ${stopLoss?.toFixed(2)}, TP: ${takeProfit?.toFixed(2)}`);
}

/**
 * Close entire position
 */
async function closePosition(symbol) {
  const pos = await getPosition(symbol);
  if (!pos) {
    log.info("No position to close");
    return null;
  }

  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  return reduceOrder(symbol, closeSide, pos.size);
}

/**
 * Get symbol ticker (last price)
 */
async function getTicker(symbol) {
  const { result } = await client.getTickers({
    category: "linear",
    symbol,
  });
  if (!result?.list?.[0]?.lastPrice) {
    throw new Error(`No ticker data for ${symbol}`);
  }
  return parseFloat(result.list[0].lastPrice);
}

/**
 * Remove the in-progress (still forming) candle from the array.
 * Bybit kline API includes the current candle; after .reverse() it's the last element.
 * @param {Array} candles - sorted oldest→newest
 * @param {string} interval - "1","5","15","60","D","W","M"
 * @returns {Array} candles with in-progress bar removed (if present)
 */
function stripCurrentBar(candles, interval) {
  if (!candles.length) return candles;
  const intervalMs =
    interval === "D" ? 86400000 :
    interval === "W" ? 604800000 :
    interval === "M" ? 2592000000 :
    parseInt(interval) * 60000;
  const last = candles[candles.length - 1];
  if (last.timestamp + intervalMs > Date.now()) {
    return candles.slice(0, -1);
  }
  return candles;
}

module.exports = {
  getCandles,
  stripCurrentBar,
  getPosition,
  setLeverage,
  marketOrder,
  reduceOrder,
  setTradingStop,
  closePosition,
  getTicker,
};
