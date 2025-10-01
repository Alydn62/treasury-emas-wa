// Bot WhatsApp harga emas (whatsapp-web.js) – Opsi A (Puppeteer base image)

import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

// ---------- util ----------
const rupiah = n => 'Rp ' + new Intl.NumberFormat('id-ID').format(Number(n || 0));

async function getRate() {
  try {
    const res = await fetch('https://api.treasury.id/api/v1/antigrvty/gold/rate', {
      method: 'POST',
      headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const d = json.data || {};
    return {
      buy: Number(d.buying_rate),
      sell: Number(d.selling_rate),
      updated: String(d.updated_at || '')
    };
  } catch (e) {
    console.error('Gagal ambil harga:', e);
    return null;
  }
}

function buildMessage(r) {
  if (!r) return '⚠️ Tidak bisa mengambil harga emas sekarang.';
  const diff = Math.abs((r.buy || 0) - (r.sell || 0));
  const spreadPct = r.buy ? ((diff / r.buy) * 100).toFixed(2) : '0.00';
  return [
    '💰 Harga Emas Treasury (per gram)',
    `• Beli : ${rupiah(r.buy)}`,
    `• Jual : ${rupiah(r.sell)}`,
    `• Selisih: ${rupiah(diff)} (Spread ${spreadPct}%)`,
    `• Update : ${r.updated} (WIB)`
  ].join('\n');
}

// ---------- client ----------
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session-wa-emas' }),
  // Base image Puppeteer sudah set executablePath → tidak perlu set manual
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote'
    ]
  }
});

client.on('qr', qr => {
  console.log('📲 Scan QR ini untuk login WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Bot WhatsApp siap!');
});

client.on('message', async msg => {
  const text = (msg.body || '').trim().toLowerCase();
  console.log(`📨 ${msg.from}: ${text}`);

  if (text === 'emas' || text === '/emas') {
    const rate = await getRate();
    await msg.reply(buildMessage(rate));
    return;
  }

  if (text === 'help' || text === '/start') {
    await msg.reply('Ketik *emas* untuk cek harga emas terbaru.');
    return;
  }

  // Balasan default
  await msg.reply('Halo! 👋 Ketik *emas* untuk cek harga emas.');
});

client.initialize();
