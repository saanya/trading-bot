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

    // Multi-Level Partial TP
    usePartial: true,
    partial1Pct: 0.33,   // close 33% at level 1
    partial1Mult: 1.2,   // level 1 = 1.2R
    partial2Pct: 0.33,   // close 33% at level 2
    partial2Mult: 2.0,   // level 2 = 2.0R
    // remaining 34% rides with trailing stop

    // Progressive Trailing Stop
    useTrailRest: true,
    trailBeR: 1.0,        // move SL to breakeven at +1R
    trailStartR: 2.0,     // start trailing at +2R
    trailAtrMult: 1.0,    // trail distance = 1.0 ATR

    // Session Filter (UTC hours)
    useSessionFilter: true,
    sessionSkipStart: 20,  // skip entries from 20:00 UTC
    sessionSkipEnd: 2,     // to 02:00 UTC (low volume dead zone)

    // Smart Exit
    cooldownBars: 5,
    maxBarsTrade: 40,
    beOnStFlip: true,
    minBarsReentry: 3,
  },
};
