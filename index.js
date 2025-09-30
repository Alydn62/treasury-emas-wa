import 'dotenv/config';
import pkg from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';

const { Client, LocalAuth } = pkg;

// Format angka ke Rupiah
const rupiah = (n) => "Rp " + new Intl.NumberFormat("id-ID").format(n || 0);

// Ambil harga emas dari Treasury API
async function getRate() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const json = await res.json();
    const d = json.data || {};
    return {
      buy: d.buying_rate,
      sell: d.selling_rate,
      updated: d.updated_at
    };
  } catch (err) {
    console.error("❌ Gagal ambil harga:", err);
    return null;
  }
}

// Buat pesan harga emas
function buildMessage(r) {
  if (!r) return "❌ Tidak bisa mengambil harga emas.";
  return [
    "💰 Harga Emas Treasury",
    `• Beli : ${rupiah(r.buy)}`,
    `• Jual : ${rupiah(r.sell)}`,
    `• Update : ${r.updated} WIB`
  ].join("\n");
}

// Inisialisasi WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session-wa-emas' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote'
    ]
  }
});

// Event: QR code muncul di terminal
client.on('qr', qr => {
  console.log('📲 Scan QR ini untuk login WhatsApp:');
  qrcodeTerminal.generate(qr, { small: true });
});

// Event: Bot siap
client.on('ready', () => {
  console.log('✅ Bot WhatsApp sudah siap!');
});

// Event: Menerima pesan
client.on('message', async msg => {
  const text = msg.body?.trim().toLowerCase();
  console.log(`📩 Pesan dari ${msg.from}: ${text}`);

  if (text === 'emas') {
    const rate = await getRate();
    await msg.reply(buildMessage(rate));
  } else {
    await msg.reply("Halo! 👋 Ketik *emas* untuk cek harga emas terbaru.");
  }
});

// Start bot
client.initialize();
