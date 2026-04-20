const common = require("../../common/config");

module.exports = {
  ...common,
  timeframe: "5",

  strategy: {
    // Session & Opening Range
    sessionStartHour: parseInt(process.env.ORB_SESSION_START || "0"), // UTC hour
    orbBars: 12,               // first 12 x 5m = 60min opening range
    closeAtSessionEnd: false,

    // Trend filter (15m Supertrend)
    trendTf: "15",
    stAtrLen: 10,
    stFactor: 2.5,
    minTrendAge: 3,

    // Range validation
    minRangeAtr: 0.5,          // skip if range < 0.5 ATR (too narrow)
    maxRangeAtr: 3.0,          // skip if range > 3 ATR (too wide)

    // ADX
    useAdx: true,
    adxLen: 14,
    adxThresh: 20,

    // Volume
    useVol: true,
    volSmaLen: 20,
    volMult: 1.0,

    // Risk
    slBuffer: 0.3,             // ATR fraction added beyond OR boundary
    maxSlAtr: 3.0,             // cap SL at this many ATR from entry
    tpRangeMult: 2.5,          // TP = rangeWidth * mult

    // Trailing (no partials)
    usePartial: false,
    useTrailRest: true,
    trailBeR: 1.0,
    trailStartR: 1.5,
    trailAtrMult: 1.0,

    // Session filter (dead hours)
    useSessionFilter: true,
    sessionSkipStart: 20,
    sessionSkipEnd: 2,
    sessionSkipHours: [],

    // DOW filter
    useDowFilter: true,
    skipDays: [1, 2],

    // Quality filters
    diConfirm: true,            // require DI+ > DI- for long, DI- > DI+ for short
    stAlign: true,              // require 5m Supertrend aligned with breakout direction

    // Smart exit
    cooldownBars: 0,
    maxBarsTrade: 48,           // 4 hours on 5m
    beOnStFlip: true,
    minBarsReentry: 0,
  },
};
