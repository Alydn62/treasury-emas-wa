// WhatsApp bot – Realtime Treasury + Healthcheck + QR viewer + Auto Reconnect (20s)

import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;

import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import dotenv from "dotenv";
import { Agent, setGlobalDispatcher } from "undici"; // keep-alive

dotenv.config();

/* ---------------- HTTP keep-alive & warm-up ---------------- */
const AGENT = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  pipelining: 1
});
setGlobalDispatcher(AGENT);

async function warmup() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { accept: "application/json" }
    });
    console.log("🔥 Warm-up Treasury:", res.status);
  } catch (e) {
    console.warn("⚠️ Warm-up gagal (abaikan):", e?.message || e);
  }
}
warmup().catch(() => {});

/* ---------------- Mini HTTP server (healthcheck & QR viewer) ---------------- */
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

/* ---------------- Utils ---------------- */
const rupiah = (n) => "Rp " + new Intl.NumberFormat("id-ID").format(Number(n || 0));

async function fetchWithTimeout(url, opts = {}, timeoutMs = Number(process.env.TREASURY_TIMEOUT_MS || 2000)) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function getRateRealtime() {
  const doOnce = async () => {
    const res = await fetchWithTimeout(
      "https://api.treasury.id/api/v1/antigrvty/gold/rate",
      { method: "POST", headers: { accept: "application/json" } }
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

/* ---------------- WhatsApp client ---------------- */
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

/* lifecycle & QR */
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

// Auto-reconnect: tunggu 20 detik lalu initialize lagi
client.on("disconnected", (reason) => {
  console.error("🔌 Disconnected:", reason);
  console.log("⏳ Akan coba reconnect dalam 20 detik...");
  setTimeout(() => {
    console.log("🔄 Reinitializing WhatsApp client...");
    client.initialize();
  }, 20_000);
});

/* helper reply + fallback */
async function safeReply(text, msg) {
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

/* handlers */
async function handleEmasRealtime(msg) {
  try {
    const chat = await msg.getChat();
    chat.sendStateTyping(); // typing indicator

    const rate = await getRateRealtime();
    await safeReply(buildRateMsg(rate), msg);

    chat.clearState();
  } catch (e) {
    console.error("🔴 Handler emas error:", e);
    try { (await msg.getChat()).clearState(); } catch {}
    await safeReply("⚠️ Terjadi error saat ambil harga.", msg);
  }
}

client.on("message", async (msg) => {
  const text = (msg.body || "").trim();
  const lower = text.toLowerCase();
  console.log(`📨 from=${msg.from} | fromMe=${msg.fromMe} | text="${text}"`);

  if (lower === "emas" || lower === "/emas") {
    await handleEmasRealtime(msg);
    return;
  }
  if (lower === "help" || lower === "/start") {
    await safeReply("Perintah:\n• emas — harga emas realtime Treasury", msg);
    return;
  }
  await safeReply("Halo! 👋 Ketik *emas* untuk cek harga emas realtime, atau *help* untuk daftar perintah.", msg);
});

client.on("message_create", async (msg) => {
  if (!msg.fromMe) return;
  const t = (msg.body || "").trim().toLowerCase();
  if (t === "emas" || t === "/emas") {
    await handleEmasRealtime(msg);
  }
});

client.initialize();
