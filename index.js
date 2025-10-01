// index.js – WhatsApp bot + healthcheck + QR image endpoint (Koyeb friendly)
// - QR login tampil di log (ASCII) & di /qr (gambar)
// - Healthcheck di /  (port 8000)
// - Command "emas" ambil harga dari Treasury

import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;

import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

// ---------------- Mini HTTP server (healthcheck & QR viewer) ----------------
const app = express();
const PORT = process.env.PORT || 8000;

// simpan QR terakhir (data URL PNG) untuk halaman /qr
let lastQrDataUrl = "";

app.get("/", (_req, res) => res.send("✅ WA Bot up"));

app.get("/qr", (_req, res) => {
  if (!lastQrDataUrl) return res.status(404).send("QR belum tersedia. Tunggu beberapa detik lalu refresh.");
  res.send(`<!doctype html>
  <html><head><meta charset="utf-8"><title>WhatsApp Login QR</title></head>
  <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif">
    <div style="text-align:center">
      <h3>Scan QR untuk login WhatsApp</h3>
      <img src="${lastQrDataUrl}" alt="QR" style="width:320px;height:320px"/>
      <p>QR WhatsApp cepat kadaluarsa. Jika gagal, refresh halaman ini.</p>
    </div>
  </body></html>`);
});

app.get("/qr.png", (_req, res) => {
  if (!lastQrDataUrl) return res.status(404).send("QR belum tersedia.");
  const b64 = lastQrDataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.send(Buffer.from(b64, "base64"));
});

app.listen(PORT, () => console.log(`🌐 Healthcheck server listen on :${PORT}`));

// ---------------- Util & API ----------------
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

function buildRateMsg(r) {
  if (!r) return "⚠️ Tidak bisa mengambil harga emas sekarang.";
  return [
    "💰 Harga Emas Treasury (per gram)",
    `• Beli : ${rupiah(r.buy)}`,
    `• Jual : ${rupiah(r.sell)}`,
    `• Selisih: ${rupiah(r.diff)} (Spread ${r.spreadPct}%)`,
    `• Update : ${r.updated} (WIB)`
  ].join("\n");
}

// ---------------- WhatsApp client ----------------
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
    // Tidak perlu executablePath karena kita pakai base image Puppeteer di Dockerfile
  }
});

// Lifecycle logs
client.on("qr", async (qr) => {
  console.log("📱 Scan QR ini dengan WhatsApp kamu (atau buka /qr):");
  qrcodeTerminal.generate(qr, { small: true });
  // simpan QR jadi dataURL untuk halaman /qr
  try {
    lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  } catch (e) {
    console.error("Gagal buat dataURL QR:", e);
  }
});

client.on("authenticated", () => console.log("🔐 Authenticated."));
client.on("auth_failure", (m) => console.error("🔴 Auth failure:", m));
client.on("ready", () => console.log("✅ Bot WhatsApp siap!"));
client.on("disconnected", (r) => console.error("🔌 Disconnected:", r));

// Pesan dari orang lain
client.on("message", async (msg) => {
  const textRaw = (msg.body || "");
  const text = textRaw.trim();
  const lower = text.toLowerCase();
  console.log(`📨 from=${msg.from} | fromMe=${msg.fromMe} | text="${text}"`);

  if (lower === "emas" || lower === "/emas") {
    const rate = await getRate();
    await msg.reply(buildRateMsg(rate));
    return;
  }

  if (lower === "help" || lower === "/start") {
    await msg.reply("Perintah:\n• emas — harga emas terbaru");
    return;
  }

  // default
  await msg.reply("Halo! 👋 Ketik *emas* untuk cek harga emas, atau *help* untuk daftar perintah.");
});

// Pesan yang kamu kirim sendiri (self-chat) — berguna untuk testing cepat
client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  const t = (msg.body || "").trim().toLowerCase();
  if (t === "emas" || t === "/emas") {
    const rate = await getRate();
    await msg.reply(buildRateMsg(rate));
  }
});

client.initialize();
