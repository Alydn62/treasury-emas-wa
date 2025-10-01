import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import P from "pino";
import fs from "fs";
import http from "http";

// ======= CONFIG LOG =======
// Semua log ditulis ke file logs.txt
const LOG_FILE = "logs.txt";
const logger = P({ level: "silent" });

// Fungsi tulis log ke file
function writeLog(message) {
  const time = new Date().toISOString();
  fs.appendFileSync(LOG_FILE, `[${time}] ${message}\n`);
}

// Auto hapus log setiap 1 jam (3600000 ms)
setInterval(() => {
  fs.writeFileSync(LOG_FILE, ""); // kosongkan file
  console.log("🧹 Log dihapus otomatis");
}, 60 * 60 * 1000);

// ======= WHATSAPP BOT =======
async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log("🔄 Reconnect dalam 20 detik...");
        setTimeout(startSock, 20000);
      } else {
        console.log("❌ Logout, hapus folder auth_info untuk scan ulang.");
      }
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap!");
      writeLog("Bot terhubung ke WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    writeLog(`📨 from=${from} | text="${text}"`);

    if (text.toLowerCase().includes("emas")) {
      try {
        const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" }
        });
        const data = await res.json();
        if (data?.data) {
          const buy = data.data[0].buy_price;
          const sell = data.data[0].sell_price;
          await sock.sendMessage(from, { text: `📊 Harga Emas:\n\n💰 Buy: Rp ${buy}\n💸 Sell: Rp ${sell}` });
          writeLog("Balasan harga emas terkirim.");
        }
      } catch (e) {
        writeLog("❌ Gagal ambil harga emas: " + e.message);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// ======= HEALTHCHECK SERVER =======
http.createServer((_, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running\n");
}).listen(8000, () => console.log("🌐 Healthcheck server listen on :8000"));

startSock();
