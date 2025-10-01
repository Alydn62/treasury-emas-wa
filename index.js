import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import express from "express";
import { fetch } from "undici";

const app = express();
const PORT = process.env.PORT || 8000;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session-baileys");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      qrcode.generate(qr, { small: true });
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log("connection closed. reconnect:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 20_000); // reconnect 20 detik
      }
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    console.log("📨", from, text);

    if (text?.toLowerCase().includes("emas")) {
      try {
        const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
          method: "POST"
        });
        const data = await res.json();

        const buy = data?.data?.price?.buy ?? "-";
        const sell = data?.data?.price?.sell ?? "-";

        await sock.sendMessage(from, {
          text: `📊 Harga Emas Treasury:\n\n💰 Buy: Rp ${buy}/gram\n💸 Sell: Rp ${sell}/gram`
        });
      } catch (e) {
        await sock.sendMessage(from, { text: "⚠️ Gagal ambil data emas." });
      }
    }
  });
}

// healthcheck server (agar Koyeb/Vercel tidak matikan container)
app.get("/", (req, res) => {
  res.send("Bot WhatsApp Baileys aktif 🚀");
});

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`);
  startBot();
});
