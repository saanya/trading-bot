// Separate Bybit accounts per strategy group
require("dotenv").config();

const MTF_API_KEY = process.env.BYBIT_API_KEY_MTF || "";
const MTF_API_SECRET = process.env.BYBIT_API_SECRET_MTF || "";
const SCALP_API_KEY = process.env.BYBIT_API_KEY_SCALP || "";
const SCALP_API_SECRET = process.env.BYBIT_API_SECRET_SCALP || "";
const ORB_API_KEY = process.env.BYBIT_API_KEY_ORB || "";
const ORB_API_SECRET = process.env.BYBIT_API_SECRET_ORB || "";

module.exports = {
  apps: [
    // MTF Trend Scalper (15m) — Account #1
    {
      name: "mtf-SUI",
      script: "src/strategies/mtf-trend/index.js",
      env: { SYMBOL: "SUIUSDT", BYBIT_API_KEY: MTF_API_KEY, BYBIT_API_SECRET: MTF_API_SECRET },
    },
    {
      name: "mtf-APT",
      script: "src/strategies/mtf-trend/index.js",
      env: { SYMBOL: "APTUSDT", BYBIT_API_KEY: MTF_API_KEY, BYBIT_API_SECRET: MTF_API_SECRET },
    },
    {
      name: "mtf-DOGE",
      script: "src/strategies/mtf-trend/index.js",
      env: { SYMBOL: "DOGEUSDT", BYBIT_API_KEY: MTF_API_KEY, BYBIT_API_SECRET: MTF_API_SECRET },
    },

    // // EMA Pullback Scalper (5m) — Account #2
    // {
    //   name: "scalp-SUI",
    //   script: "src/strategies/ema-scalper/index.js",
    //   env: { SYMBOL: "SUIUSDT", BYBIT_API_KEY: SCALP_API_KEY, BYBIT_API_SECRET: SCALP_API_SECRET },
    // },
    // {
    //   name: "scalp-APT",
    //   script: "src/strategies/ema-scalper/index.js",
    //   env: { SYMBOL: "APTUSDT", EMA_LEN: "30", ADX_THRESH: "20", BYBIT_API_KEY: SCALP_API_KEY, BYBIT_API_SECRET: SCALP_API_SECRET },
    // },

    // ORB Breakout (5m, 1hr opening range) — Account #3
    {
      name: "orb-SUI",
      script: "src/strategies/orb/index.js",
      env: { SYMBOL: "SUIUSDT", BYBIT_API_KEY: ORB_API_KEY, BYBIT_API_SECRET: ORB_API_SECRET },
    },
    {
      name: "orb-M",
      script: "src/strategies/orb/index.js",
      env: { SYMBOL: "MUSDT", BYBIT_API_KEY: ORB_API_KEY, BYBIT_API_SECRET: ORB_API_SECRET },
    },
  ],
};
