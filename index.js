import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8000;

let sock;
let latestQR = null;

// Fungsi buat koneksi ke WhatsApp
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // masih tampil QR di terminal
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  });

  // QR code handler
  sock.ev.on("connection.update", ({ qr, connection, lastDisconnect }) => {
    if (qr) {
      latestQR = qr; // simpan QR terbaru
      console.log("📱 Scan QR ini atau buka /qr di browser");
    }
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Koneksi terputus. Alasan:", reason);
      console.log("🔄 Mengulang koneksi dalam 20 detik...");
      setTimeout(() => connectToWhatsApp(), 20000);
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Listener pesan masuk
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    console.log("📨 Pesan dari", from, "| isi =", text);

    if (text.toLowerCase().includes("emas")) {
      try {
        // ambil harga emas realtime
        const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
          method: "POST",
        });
        const data = await res.json();

        if (data && data.data) {
          const buy = data.data.buy_price.toLocaleString("id-ID");
          const sell = data.data.sell_price.toLocaleString("id-ID");
          const reply = `💰 Harga Emas Treasury\n\n📥 Buy: Rp ${buy}/gram\n📤 Sell: Rp ${sell}/gram`;

          await sock.sendMessage(from, { text: reply });
          console.log("✅ Balasan terkirim:", reply);
        }
      } catch (err) {
        console.error("❌ Gagal ambil data emas:", err);
        await sock.sendMessage(from, { text: "⚠️ Gagal ambil harga emas, coba lagi." });
      }
    }
  });
}

// Jalankan koneksi WA
connectToWhatsApp();

// Endpoint untuk lihat QR di browser
app.get("/qr", async (req, res) => {
  if (!latestQR) return res.send("✅ Sudah login atau QR belum tersedia");
  try {
    const qrImage = await qrcode.toDataURL(latestQR, { scale: 8 });
    res.send(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
          <h2>Scan QR WhatsApp</h2>
          <img src="${qrImage}" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Gagal generate QR");
  }
});

// Healthcheck
app.get("/", (req, res) => {
  res.send("✅ WhatsApp Bot aktif");
});

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`);
});
