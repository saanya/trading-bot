module.exports = {
  apps: [
    {
      name: "bot-SUI",
      script: "src/index.js",
      env: { SYMBOL: "SUIUSDT" },
    },
    {
      name: "bot-APT",
      script: "src/index.js",
      env: { SYMBOL: "APTUSDT" },
    },
    {
      name: "bot-TIA",
      script: "src/index.js",
      env: { SYMBOL: "TIAUSDT" },
    },
  ],
};
