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

  // Strategy params (matching Pine Script v3 defaults)
  strategy: {
    // HTF Trend
    htfEmaFast: 21,
    htfEmaSlow: 50,
    htfMinAgree: 2,
    htfStrict: false,

    // Supertrend
    stAtrLen: 10,
    stFactor: 2.5,

    // StochRSI
    stochLen: 10,
    stochK: 3,
    stochD: 3,
    rsiLen: 14,
    osLevel: 40,

    // ADX
    useAdx: true,
    adxLen: 14,
    adxThresh: 20,
    useDi: true,

    // Volume
    useVol: true,
    volSmaLen: 20,
    volMult: 1.0,

    // Risk Management
    slMult: 2.0,
    tpMult: 4.0,

    // Partial TP + Trail
    usePartial: true,
    partialPct: 0.5,
    partialMult: 1.8,
    useTrailRest: true,
    trailAtrMult: 1.5,

    // Smart Exit
    cooldownBars: 5,
    maxBarsTrade: 40,
    beOnStFlip: true,
    minBarsReentry: 3,
  },
};
