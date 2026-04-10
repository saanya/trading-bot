const https = require("https");
const config = require("./config");
const log = require("./logger");

const TOKEN = config.telegramToken;
const CHAT_ID = config.telegramChatId;

function send(text) {
  if (!TOKEN || !CHAT_ID) return;

  const data = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  });

  const req = https.request(
    {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    },
    (res) => {
      if (res.statusCode !== 200) {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => log.warn(`Telegram API error ${res.statusCode}: ${body}`));
      }
    }
  );

  req.on("error", (err) => log.warn(`Telegram send failed: ${err.message}`));
  req.write(data);
  req.end();
}

function notifyOpen(symbol, side, price, sl, tp, partial1, partial2) {
  const arrow = side === "Buy" ? "🟢 LONG" : "🔴 SHORT";
  send(
    `${arrow} *${symbol}*\n` +
    `Entry: \`${price.toFixed(4)}\`\n` +
    `SL: \`${sl.toFixed(4)}\` | TP: \`${tp.toFixed(4)}\`\n` +
    `P1: \`${partial1.toFixed(4)}\` | P2: \`${partial2.toFixed(4)}\``
  );
}

function notifyPartial(symbol, level, qty, reason) {
  send(`🟡 *${symbol}* Partial TP${level}: closed ${qty} — ${reason}`);
}

function notifyClose(symbol, side, entryPrice, exitPrice, pnl, reason, barsHeld) {
  const icon = pnl >= 0 ? "✅" : "❌";
  const dir = side === "Buy" ? "LONG" : "SHORT";
  send(
    `${icon} *${symbol}* ${dir} closed\n` +
    `Entry: \`${entryPrice.toFixed(4)}\` → Exit: \`${exitPrice.toFixed(4)}\`\n` +
    `PnL: \`${pnl}\` | Reason: ${reason}\n` +
    `Duration: ${barsHeld} bars`
  );
}

module.exports = { send, notifyOpen, notifyPartial, notifyClose };
