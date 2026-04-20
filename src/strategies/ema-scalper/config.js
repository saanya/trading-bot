const common = require("../../common/config");

module.exports = {
  ...common,
  timeframe: "5",

  strategy: {
    // Trend filter (15m Supertrend for direction)
    trendTf: "15",
    stAtrLen: 10,
    stFactor: 2.5,
    minTrendAge: 3,            // 15m ST must be in direction for 3+ bars

    // EMA Pullback
    emaLen: parseInt(process.env.EMA_LEN || "21"),
    pullbackBars: 5,           // look back N bars for EMA touch

    // StochRSI
    stochLen: 10,
    stochK: 3,
    stochD: 3,
    rsiLen: 14,
    osLevel: 40,

    // ADX + DI
    useAdx: true,
    adxLen: 14,
    adxThresh: parseInt(process.env.ADX_THRESH || "25"),
    useDi: true,

    // Volume
    useVol: true,
    volSmaLen: 20,
    volMult: 1.0,

    // Risk Management
    slMult: 2.0,
    tpMult: parseFloat(process.env.TP_MULT || "4.0"),

    // Trailing (no partials)
    usePartial: false,
    useTrailRest: true,
    trailBeR: 1.0,           // move SL to BE at +1R
    trailStartR: 1.5,        // start trailing at +1.5R
    trailAtrMult: 0.75,      // trail distance

    // Session Filter (UTC hours)
    useSessionFilter: true,
    sessionSkipStart: 20,
    sessionSkipEnd: 2,
    sessionSkipHours: [],

    // Day-of-Week Filter
    useDowFilter: true,
    skipDays: [1, 2],

    // Smart Exit
    cooldownBars: 2,
    maxBarsTrade: 24,        // 2 hours max on 5m
    beOnStFlip: true,
    minBarsReentry: 2,
  },
};
