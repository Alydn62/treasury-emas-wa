// index.js – WhatsApp bot + healthcheck server untuk Koyeb (tanpa executablePath)

import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

import qrcode from "qrcode-terminal";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

// ---------- Mini HTTP server untuk health check Koyeb ----------
const app = express();
app.get("/", (_req, res) => res.send("✅ WA Bot up"));
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`🌐 Healthcheck server listen on :${PORT}`));

// ---------- Util & API ----------
const rupiah = (n) => "Rp " + new Intl.NumberFormat("id-ID").format(Number(n || 0));

async function getRate() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { accept: "application/json" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const d = json.data || {};
    const buy = Number(d.buying_rate);
    const sell = Number(d.selling_rate);
    const updated = String(d.updated_at || "");
    const diff = Math.abs(buy - sell);
    const spreadPct = buy ? ((diff / buy) * 100).toFixed(2) : "0.00";
    return { buy, sell, updated, diff, spreadPct };
  } catch (e) {
    console.error("❌ Gagal ambil harga:", e);
    return null;
  }
}

function buildMessage(r) {
  if (!r) return "⚠️ Tidak bisa mengambil harga emas sekarang.";
  return [
    "💰 Harga Emas Treasury (per gram)",
    `• Beli : ${rupiah(r.buy)}`,
    `• Jual : ${rupiah(r.sell)}`,
    `• Selisih: ${rupiah(r.diff)} (Spread ${r.spreadPct}%)`,
    `• Update : ${r.updated} (WIB)`
  ].join("\n");
}

// ---------- WhatsApp client ----------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session-wa-emas" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
    // Tidak perlu executablePath karena base image Puppeteer sudah set Chromium
  }
});

client.on("qr", (qr) => {
  console.log("📱 Scan QR ini dengan WhatsApp kamu:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("✅ Bot WhatsApp siap!");
});

client.on("message", async (msg) => {
  const text = (msg.body || "").trim().toLowerCase();
  console.log(`📨 ${msg.from}: ${text}`);

  if (text === "emas" || text === "/emas") {
    const rate = await getRate();
    await msg.reply(buildMessage(rate));
    return;
  }

  if (text === "help" || text === "/start") {
    await msg.reply("Ketik *emas* untuk cek harga emas terbaru.");
    return;
  }

  // Balasan default
  await msg.reply("Halo! 👋 Ketik *emas* untuk cek harga emas.");
});

client.initialize();
