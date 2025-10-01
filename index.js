// index.js – WhatsApp bot (realtime Treasury) + healthcheck + QR viewer
// Optimasi cepat: Undici keep-alive, warm-up, timeout pendek, retry, typing indicator

import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import dotenv from "dotenv";
// 👇 Undici (fetch bawaan Node) untuk set Agent keep-alive
import { Agent, setGlobalDispatcher } from "undici";

dotenv.config();

// ---------------- HTTP keep-alive & warm-up ----------------
const AGENT = new Agent({
  keepAliveTimeout: 30_000,     // idle socket lifetime
  keepAliveMaxTimeout: 60_000,  // safety cap
  pipelining: 1                 // aman untuk API biasa
});
setGlobalDispatcher(AGENT);

// preconnect warm-up ke host Treasury saat boot
async function warmup() {
  try {
    // ping ringan dulu ke endpoint yang sama (POST tanpa body)
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { accept: "application/json" }
    });
    // buang hasil; tujuan hanya inisiasi koneksi/DNS/TLS
    console.log("🔥 Warm-up Treasury:", res.status);
  } catch (e) {
    console.warn("⚠️ Warm-up gagal (abaikan):", e?.message || e);
  }
}
warmup().catch(()=>{});

// ---------------- Mini HTTP server (healthcheck & QR viewer) ----------------
const app = express();
const PORT = process.env.PORT || 8000;

let lastQrDataUrl = "";

app.get("/", (_req, res) => res.send("✅ WA Bot up"));

app.get("/qr", (_req, res) => {
  if (!lastQrDataUrl) return res.status(404).send("QR belum tersedia. Refresh jika kadaluarsa.");
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
app.listen(PORT, () => console.log(`🌐 Healthcheck server listen on :${PORT}`));

// ---------------- Utils ----------------
const rupiah = (n) => "Rp " + new Intl.NumberFormat("id-ID").format(Number(n || 0));

// fetch with timeout
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Ambil harga realtime + retry cepat
async function getRateRealtime() {
  const doOnce = async () => {
    const res = await fetchWithTimeout(
      "https://api.treasury.id/api/v1/antigrvty/gold/rate",
      { method: "POST", headers: { accept: "application/json" } },
      // timeout ketat supaya respons terasa cepat; sesuaikan kalau perlu
      Number(process.env.TREASURY_TIMEOUT_MS || 2000)
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const d = json?.data || {};
    const buy = Number(d.buying_rate);
    const sell = Number(d.selling_rate);
    const updated = String(d.updated_at || "");
    return { buy, sell, updated };
  };

  try {
    return await doOnce();
  } catch (e1) {
    console.warn("⚠️ Treasury attempt #1 gagal:", e1?.message || e1);
    // retry cepat sekali lagi (cadangan)
    try {
      return await doOnce();
    } catch (e2) {
      console.error("❌ Treasury attempt #2 gagal:", e2?.message || e2);
      return null;
    }
  }
}

function buildRateMsg(r) {
  if (!r) return "⚠️ Gagal ambil harga realtime. Coba lagi sebentar ya.";
  const diff = Math.abs((r.buy || 0) - (r.sell || 0));
  const spreadPct = r.buy ? ((diff / r.buy) * 100).toFixed(2) : "0.00";
  return [
    "💰 Harga Emas Treasury (per gram)",
    `• Beli   : ${rupiah(r.buy)}`,
    `• Jual   : ${rupiah(r.sell)}`,
    `• Selisih: ${rupiah(diff)} (Spread ${spreadPct}%)`,
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
  }
});

// lifecycle & QR
client.on("qr", async (qr) => {
  console.log("📱 Scan QR ini (atau buka /qr):");
  qrcodeTerminal.generate(qr, { small: true });
  try {
    lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
  } catch {}
});
client.on("authenticated", () => console.log("🔐 Authenticated."));
client.on("auth_failure", (m) => console.error("🔴 Auth failure:", m));
client.on("ready", () => console.log("✅ Bot WhatsApp siap!"));
client.on("disconnected", (r) => console.error("🔌 Disconnected:", r));

// helper balas dengan fallback + typing indicator
async function safeReplyRealtime(text, msg) {
  try {
    await msg.reply(text);
  } catch (e) {
    console.warn("reply() gagal, fallback sendMessage:", e?.message);
    try {
      await client.sendMessage(msg.from, text);
    } catch (ee) {
      console.error("sendMessage() gagal:", ee);
    }
  }
}

async function handleEmasRealtime(msg) {
  try {
    // tampilkan indicator mengetik supaya user tahu bot sedang ambil data
    const chat = await msg.getChat();
    chat.sendStateTyping();

    const rate = await getRateRealtime();
    await safeReplyRealtime(buildRateMsg(rate), msg);

    // selesai mengetik
    chat.clearState();
  } catch (e) {
    console.error("🔴 Handler emas error:", e);
    try { (await msg.getChat()).clearState(); } catch {}
    await safeReplyRealtime("⚠️ Terjadi error saat ambil harga.", msg);
  }
}

// handlers
client.on("message", async (msg) => {
  const text = (msg.body || "").trim();
  const lower = text.toLowerCase();
  console.log(`📨 from=${msg.from} | fromMe=${msg.fromMe} | text="${text}"`);

  if (lower === "emas" || lower === "/emas") {
    await handleEmasRealtime(msg);
    return;
  }
  if (lower === "help" || lower === "/start") {
    await safeReplyRealtime("Perintah:\n• emas — harga emas realtime Treasury", msg);
    return;
  }
  await safeReplyRealtime("Halo! 👋 Ketik *emas* untuk cek harga emas realtime, atau *help* untuk daftar perintah.", msg);
});

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  const t = (msg.body || "").trim().toLowerCase();
  if (t === "emas" || t === "/emas") {
    await handleEmasRealtime(msg);
  }
});

client.initialize();
