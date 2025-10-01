// Baileys-based WA bot: super ringan & cepat (tanpa Chromium)
// Fitur: healthcheck di :8000, QR login di log & /qr, command "emas" (Treasury realtime)

import makeWASocket, { useMultiFileAuthState, Browsers } from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import QRCode from "qrcode";
import express from "express";
import dotenv from "dotenv";
import pino from "pino";
import { Agent, setGlobalDispatcher } from "undici";

dotenv.config();

/* ---------------- HTTP keep-alive (buat fetch Treasury) + warm-up ---------------- */
const AGENT = new Agent({ keepAliveTimeout: 30000, keepAliveMaxTimeout: 60000 });
setGlobalDispatcher(AGENT);

async function warmup() {
  try {
    const r = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { accept: "application/json" }
    });
    console.log("🔥 Warm-up Treasury:", r.status);
  } catch (e) {
    console.warn("⚠️ Warm-up gagal:", e?.message || e);
  }
}
warmup().catch(()=>{});

/* ---------------- Mini HTTP server: healthcheck & QR viewer ---------------- */
const app = express();
const PORT = process.env.PORT || 8000;

let lastQrDataUrl = ""; // simpan QR terkini sebagai dataURL PNG

app.get("/", (_req, res) => res.send("✅ WA (Baileys) up"));

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

app.get("/qr.png", (_req, res) => {
  if (!lastQrDataUrl) return res.status(404).send("QR belum tersedia.");
  const b64 = lastQrDataUrl.split(",")[1];
  res.setHeader("Content-Type", "image/png");
  res.send(Buffer.from(b64, "base64"));
});

app.listen(PORT, () => console.log(`🌐 Healthcheck :${PORT}`));

/* ---------------- Util ---------------- */
const rupiah = (n) => "Rp " + new Intl.NumberFormat("id-ID").format(Number(n || 0));
async function fetchWithTimeout(url, opts = {}, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
async function getRateRealtime() {
  const call = async () => {
    const res = await fetchWithTimeout(
      "https://api.treasury.id/api/v1/antigrvty/gold/rate",
      { method: "POST", headers: { accept: "application/json" } },
      Number(process.env.TREASURY_TIMEOUT_MS || 2000)
    );
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const d = json?.data || {};
    return { buy: Number(d.buying_rate), sell: Number(d.selling_rate), updated: String(d.updated_at || "") };
  };
  try { return await call(); }
  catch (e1) { try { return await call(); } catch (e2) { return null; } }
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

/* ---------------- Baileys setup ---------------- */
const logger = pino({ level: "silent" }); // biar log tidak berisik
const SESSION_DIR = "./baileys-session";
const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

const sock = makeWASocket({
  printQRInTerminal: false,                 // kita render sendiri
  auth: state,
  browser: Browsers.ubuntu("Chrome"),       // fingerprint yang wajar
  logger
});

sock.ev.on("connection.update", async (update) => {
  const { connection, qr, lastDisconnect } = update;

  if (qr) {
    // QR di log (ASCII)
    console.log("📱 Scan QR ini untuk login (Baileys):");
    qrcodeTerminal.generate(qr, { small: true });
    // QR sebagai gambar (endpoint /qr)
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    } catch {}
  }

  if (connection === "open")  console.log("✅ Bot WhatsApp siap (Baileys)!");
  if (connection === "close") console.log("🔌 Disconnected:", lastDisconnect?.error?.message);
});
sock.ev.on("creds.update", saveCreds);

/* ---------------- Handler pesan ---------------- */
sock.ev.on("messages.upsert", async ({ type, messages }) => {
  if (type !== "notify") return;

  for (const m of messages) {
    const msgText =
      m.message?.conversation ||
      m.message?.extendedTextMessage?.text ||
      m.message?.imageMessage?.caption ||
      "";

    const from = m.key.remoteJid || "";
    const me = m.key.fromMe === true;
    const text = (msgText || "").trim();
    const lower = text.toLowerCase();

    console.log(`📨 from=${from} | fromMe=${me} | "${text}"`);

    // abaikan status/broadcast dsb
    const isChat =
      from.endsWith("@s.whatsapp.net") || // private chat
      from.endsWith("@c.us") ||          // some clients map
      from.includes("@g.us");            // group

    if (!isChat) continue;

    if (lower === "emas" || lower === "/emas") {
      await sock.sendPresenceUpdate("composing", from);   // indikator mengetik
      const rate = await getRateRealtime();
      await sock.sendMessage(from, { text: buildRateMsg(rate) });
      await sock.sendPresenceUpdate("paused", from);
      continue;
    }

    if (lower === "help" || lower === "/start") {
      await sock.sendMessage(from, { text: "Perintah:\n• emas — harga emas realtime Treasury" });
      continue;
    }

    // default
    await sock.sendMessage(from, { text: "Halo! 👋 Ketik *emas* untuk cek harga emas realtime, atau *help*." });
  }
});
