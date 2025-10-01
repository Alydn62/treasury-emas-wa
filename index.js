import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys";
import fetch from "node-fetch";
import express from "express";

const app = express();
const PORT = process.env.PORT || 8000;

// 🔹 Fungsi ambil harga emas dari Treasury
async function getHargaEmas() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
      },
      body: "{}"
    });

    const data = await res.json();
    console.log("Response Treasury:", data);

    if (data?.data?.price) {
      return {
        buy: data.data.price.buy,
        sell: data.data.price.sell
      };
    } else {
      return { buy: "-", sell: "-" };
    }
  } catch (err) {
    console.error("❌ Gagal fetch API Treasury:", err);
    return { buy: "-", sell: "-" };
  }
}

// 🔹 Inisialisasi Baileys
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true, // QR tampil di terminal
  });

  // Event untuk simpan kredensial
  sock.ev.on("creds.update", saveCreds);

  // Event pesan masuk
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    console.log(`📩 Pesan masuk dari ${from}: ${text}`);

    if (text && text.toLowerCase() === "emas") {
      const harga = await getHargaEmas();
      await sock.sendMessage(from, {
        text: `📊 Harga Emas Treasury:\n💰 Buy: Rp ${harga.buy}/gram\n💸 Sell: Rp ${harga.sell}/gram`
      });
    }
  });

  console.log(`🌐 Healthcheck server listen on :${PORT}`);
  app.get("/", (req, res) => res.send("Instance is healthy. All health checks are passing."));
  app.listen(PORT, () => console.log("✅ Bot WhatsApp siap!"));
}

startBot();
