require("dotenv").config();

module.exports = {
  // Bybit
  apiKey: process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
  testnet: process.env.BYBIT_TESTNET === "true",

  // Trading
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "15",
  positionSize: parseFloat(process.env.POSITION_SIZE || "100"),
  leverage: parseInt(process.env.LEVERAGE || "10"),
  dryRun: process.env.DRY_RUN === "true",
  logLevel: process.env.LOG_LEVEL || "info",

  // Telegram
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
};
