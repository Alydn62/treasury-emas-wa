// index.js
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 8000;

// ====== Healthcheck & QR ======
let latestQR = null;
app.get("/", (_, res) => res.send("Bot is running"));
app.get("/qr", (_, res) => {
  if (!latestQR) return res.send("QR belum tersedia, cek terminal.");
  // tampilkan QR sebagai gambar agar mudah di-scan
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=270x270&data=${encodeURIComponent(
    latestQR
  )}`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<img alt="QR" src="${url}" />`);
});
app.listen(PORT, () => console.log(`🌐 Healthcheck server listen on :${PORT}`));

// ====== Util: Ambil text dari berbagai tipe pesan ======
function extractText(msg) {
  const m = msg.message || {};
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return "";
}

// ====== Fetch harga Treasury ======
async function getHargaEmas() {
  try {
    const r = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST"
    });
    const json = await r.json();
    if (json?.meta?.code === 200 && json?.data) {
      const { buying_rate, selling_rate, updated_at } = json.data;
      const fmt = (n) =>
        Number(n).toLocaleString("id-ID", { maximumFractionDigits: 0 });
      return `Harga Treasury 📊 :
Buy : Rp ${fmt(buying_rate)}
Sel : Rp ${fmt(selling_rate)}
Jam : ${updated_at}`;
    }
    return "❌ Gagal ambil harga emas";
  } catch (e) {
    return "❌ Error fetch harga emas";
  }
}

// ====== Start bot ======
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true // tetap cetak di terminal
  });

  // cache untuk cegah balasan ganda
  const handledIds = new Set(); // berdasarkan message ID
  const lastReplyPerChat = new Map(); // throttle per chat

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      latestQR = qr;
      console.log("📲 QR diterima, buka /qr untuk scan");
    }
    if (connection === "open") {
      console.log("✅ Bot WhatsApp siap!");
    }
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log("❌ Koneksi terputus, mencoba reconnect...");
        start();
      } else {
        console.log("🔒 Logged out. Scan ulang QR di /qr.");
      }
    }
  });

  sock.ev.on("messages.upsert", async (packet) => {
    for (const msg of packet.messages) {
      // abaikan jika tidak ada isi atau sudah pernah diproses
      if (!msg?.message) continue;
      if (handledIds.has(msg.key.id)) continue;
      handledIds.add(msg.key.id);

      const chatId = msg.key.remoteJid; // tujuan balas (private/grup)
      const isMe = msg.key.fromMe === true; // pesan dari diri sendiri?
      const text = extractText(msg).trim().toLowerCase();

      console.log("📨 Pesan masuk dari", chatId, ":", text || "(kosong)");

      // hanya proses pesan BUKAN dari diri sendiri
      if (isMe) continue;

      // throttle ringan: minimal jeda 2 detik per chat
      const now = Date.now();
      const last = lastReplyPerChat.get(chatId) || 0;
      if (now - last < 2000) continue;
      lastReplyPerChat.set(chatId, now);

      // trigger kata 'emas'
      if (text.includes("emas")) {
        const replyText = await getHargaEmas();

        // kirim sebagai balasan (quoted reply) ke pesan pengirim
        await sock.sendMessage(
          chatId,
          { text: replyText },
          { quoted: msg } // <<— ini yang bikin tampil sebagai reply
        );
      }
    }

    // jaga memori: bersihkan cache jika terlalu banyak
    if (handledIds.size > 500) {
      // hapus 300 id terlama secara sederhana
      let n = 0;
      for (const id of handledIds) {
        handledIds.delete(id);
        if (++n >= 300) break;
      }
    }
  });
}

start();
