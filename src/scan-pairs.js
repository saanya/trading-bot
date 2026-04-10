const { execSync } = require("child_process");

// Top 50 USDT perpetual pairs on Bybit by volume
const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT",
  "BNBUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
  "MATICUSDT", "LTCUSDT", "UNIUSDT", "APTUSDT", "ARBUSDT",
  "OPUSDT", "NEARUSDT", "FILUSDT", "ATOMUSDT", "TRXUSDT",
  "SUIUSDT", "SEIUSDT", "TIAUSDT", "INJUSDT", "FETUSDT",
  "WIFUSDT", "PEPEUSDT", "SHIBUSDT", "ONDOUSDT", "RENDERUSDT",
  "FTMUSDT", "AAVEUSDT", "GRTUSDT", "IMXUSDT", "ALGOUSDT",
  "RNDRUSDT", "STXUSDT", "MKRUSDT", "SANDUSDT", "MANAUSDT",
  "LDOUSDT", "RUNEUSDT", "CFXUSDT", "ICPUSDT", "EGLDUSDT",
  "XLMUSDT", "ETCUSDT", "HBARUSDT", "VETUSDT", "THETAUSDT",
];

const months = parseInt(process.argv[2] || "12");
const tf = parseInt(process.argv[3] || "15");

const results = [];

console.log(`\nScanning ${PAIRS.length} pairs | ${months} months | ${tf}m timeframe\n`);
console.log("This will take a while (API rate limits)...\n");

for (let i = 0; i < PAIRS.length; i++) {
  const pair = PAIRS[i];
  process.stdout.write(`[${i + 1}/${PAIRS.length}] ${pair.padEnd(14)} ... `);

  try {
    const out = execSync(
      `node src/backtest.js ${pair} ${months} ${tf}`,
      { cwd: __dirname + "/..", timeout: 300000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );

    // Parse key metrics from output
    const profitMatch = out.match(/Net Profit:.*?\(([-\d.]+)%\)/);
    const ddMatch = out.match(/Max Drawdown:\s+([\d.]+)%/);
    const tradesMatch = out.match(/Total Trades:\s+(\d+)/);
    const winRateMatch = out.match(/Win Rate:\s+([\d.]+)%/);
    const pfMatch = out.match(/Profit Factor:\s+([\d.∞]+)/);
    const equityMatch = out.match(/Final Equity:\s+\$([\d.]+)/);

    const profit = profitMatch ? parseFloat(profitMatch[1]) : 0;
    const dd = ddMatch ? parseFloat(ddMatch[1]) : 0;
    const trades = tradesMatch ? parseInt(tradesMatch[1]) : 0;
    const winRate = winRateMatch ? parseFloat(winRateMatch[1]) : 0;
    const pf = pfMatch ? (pfMatch[1] === "∞" ? 999 : parseFloat(pfMatch[1])) : 0;
    const equity = equityMatch ? parseFloat(equityMatch[1]) : 1000;

    results.push({ pair, profit, dd, trades, winRate, pf, equity });
    console.log(`${profit >= 0 ? "+" : ""}${profit.toFixed(1)}% | DD ${dd.toFixed(1)}% | ${trades} trades | WR ${winRate.toFixed(0)}% | PF ${pf.toFixed(2)}`);
  } catch (err) {
    console.log("FAILED (no data or timeout)");
    results.push({ pair, profit: 0, dd: 0, trades: 0, winRate: 0, pf: 0, equity: 1000, failed: true });
  }

  // Small delay between pairs to avoid rate limits
  if (i < PAIRS.length - 1) {
    execSync("sleep 2");
  }
}

// Sort by profit descending
results.sort((a, b) => b.profit - a.profit);

// Print ranked table
console.log("\n" + "=".repeat(90));
console.log("  PAIR RANKING — Top performers (12 months, 15m)");
console.log("=".repeat(90));
console.log(`  ${"#".padEnd(4)} ${"Pair".padEnd(14)} ${"Profit".padEnd(10)} ${"MaxDD".padEnd(8)} ${"Trades".padEnd(8)} ${"WinRate".padEnd(9)} ${"PF".padEnd(7)} ${"Score".padEnd(8)}`);
console.log(`  ${"─".repeat(80)}`);

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  if (r.failed) continue;
  // Score = profit / max(dd, 1) * sqrt(trades) — rewards profit, penalizes DD, values trade count
  const score = r.dd > 0 ? (r.profit / r.dd) * Math.sqrt(Math.max(r.trades, 1)) : 0;
  console.log(
    `  ${String(i + 1).padEnd(4)} ${r.pair.padEnd(14)} ${(r.profit >= 0 ? "+" : "") + r.profit.toFixed(1) + "%"}${" ".repeat(Math.max(0, 7 - (r.profit.toFixed(1).length + 1)))} ${(r.dd.toFixed(1) + "%").padEnd(8)} ${String(r.trades).padEnd(8)} ${(r.winRate.toFixed(1) + "%").padEnd(9)} ${r.pf.toFixed(2).padEnd(7)} ${score.toFixed(1)}`
  );
}

// Top 5 summary
console.log("\n" + "=".repeat(90));
console.log("  TOP 5 RECOMMENDATIONS:");
console.log("=".repeat(90));
const top5 = results.filter(r => !r.failed && r.trades >= 10).slice(0, 5);
for (let i = 0; i < top5.length; i++) {
  const r = top5[i];
  console.log(`  ${i + 1}. ${r.pair} — +${r.profit.toFixed(1)}% profit, ${r.dd.toFixed(1)}% DD, ${r.trades} trades, PF ${r.pf.toFixed(2)}`);
}
console.log("\n");
