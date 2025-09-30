// index.js - Bot WhatsApp harga emas Treasury (fix jam WIB & hapus perintah)

import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

const API_URL = 'https://api.treasury.id/api/v1/antigrvty/gold/rate';

// ---------- Utils ----------
const rupiah = n => 'Rp ' + new Intl.NumberFormat('id-ID').format(n || 0);

// API sudah kirim dalam WIB, jadi tampilkan langsung
function toJakartaString(yyyyMMddHHmmss) {
  if (!yyyyMMddHHmmss) return '';
  return yyyyMMddHHmmss; // langsung tampilkan sesuai API
}

async function getRate() {
  const res = await fetch(API_URL, { method: 'POST', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  const d = json.data || {};
  const buy = Number(d.buying_rate);
  const sell = Number(d.selling_rate);
  const updated = String(d.updated_at || '');
  const diff = Math.abs(buy - sell);
  const spreadPct = buy ? ((diff / buy) * 100).toFixed(2) : 0;
  return { buy, sell, updated, diff, spreadPct };
}

function buildMessage(r) {
  return [
    '💰 Harga Emas Treasury (per gram)',
    `• Beli : ${rupiah(r.buy)}`,
    `• Jual : ${rupiah(r.sell)}`,
    `• Selisih: ${rupiah(r.diff)} (Spread ${r.spreadPct}%)`,
    `• Update : ${toJakartaString(r.updated)} (WIB)`
  ].join('\n');
}

// ---------- Init WhatsApp Client ----------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session-wa-emas' }),
  puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

client.on('qr', qr => {
  console.log('⚡ Scan QR ini dengan WhatsApp HP kamu:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => console.log('✅ WhatsApp Bot Emas siap!'));

const subscribers = new Set();

// ---------- Handler Pesan ----------
client.on('message', async msg => {
  const text = msg.body.trim().toLowerCase();
  try {
    if (text === 'emas') {
      const rate = await getRate();
      await msg.reply(buildMessage(rate));
    } else if (text === 'subscribe') {
      subscribers.add(msg.from);
      await msg.reply('✅ Berhasil langganan update tiap 10 menit. Kirim "stop" untuk berhenti.');
    } else if (text === 'stop') {
      subscribers.delete(msg.from);
      await msg.reply('🛑 Langganan dihentikan.');
    } else if (text === 'help') {
      await msg.reply('Ketik "emas" untuk cek harga, "subscribe" untuk langganan, "stop" untuk berhenti.');
    }
  } catch (e) {
    console.error(e);
    await msg.reply('⚠️ Gagal ambil data. Coba lagi.');
  }
});

// ---------- Broadcast tiap 10 menit ----------
setInterval(async () => {
  if (!subscribers.size) return;
  try {
    const rate = await getRate();
    const message = '⏱️ Update otomatis\n\n' + buildMessage(rate);
    for (const chatId of subscribers) {
      await client.sendMessage(chatId, message);
    }
  } catch (e) {
    console.error('Gagal broadcast:', e);
  }
}, 10 * 60 * 1000);

client.initialize();
