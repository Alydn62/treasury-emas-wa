// index.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'

// ------ CONFIG ------
const PORT = process.env.PORT || 8000
const TREASURY_URL = process.env.TREASURY_URL ||
  'https://api.treasury.id/api/v1/antigrvty/gold/rate' // POST endpoint

// ------ STATE ------
let lastQr = null                              // untuk /qr
const logs = []                                // batasi log
const processedMsgIds = new Set()              // anti-duplikat
const lastReplyAtPerChat = new Map()           // cooldown per chat
let lastGlobalReplyAt = 0                      // throttle global

// batasi log max 100
function pushLog(s) {
  logs.push(`${new Date().toISOString()} ${s}`)
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

// ------ UTIL ------
function normalizeText(msg) {
  if (!msg) return ''
  return msg.replace(/\s+/g, ' ').trim().toLowerCase()
}

function shouldIgnoreMessage(m) {
  // abaikan status, pesan sendiri, dan pesan tanpa text
  if (!m || !m.key) return true
  if (m.key.remoteJid === 'status@broadcast') return true
  if (m.key.fromMe) return true
  const hasText =
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption
  if (!hasText) return true
  return false
}

function extractText(m) {
  return (
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.message?.imageMessage?.caption ||
    m.message?.videoMessage?.caption ||
    ''
  )
}

function formatTreasuryText(payload) {
  const buy = payload?.data?.buying_rate
  const sell = payload?.data?.selling_rate
  const updated = payload?.data?.updated_at || new Date().toISOString()
  const fmt = (n) =>
    typeof n === 'number'
      ? n.toLocaleString('id-ID')
      : (Number(n || 0) || 0).toLocaleString('id-ID')

  return `📊 Harga Treasury 🇮🇩 :
💰 Buy : Rp ${fmt(buy)}
💸 Sel : Rp ${fmt(sell)}
⏰ Jam : ${updated}`
}

async function fetchTreasury() {
  // 2x retry sederhana
  let lastErr
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(TREASURY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error(`Treasury HTTP ${res.status}`)
      const json = await res.json()
      if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
        throw new Error('Response tidak berisi harga')
      }
      return json
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw lastErr
}

// ------ EXPRESS ------
const app = express()
app.get('/', (_req, res) => {
  res.type('text/plain').send('Bot is running')
})

app.get('/qr', async (_req, res) => {
  // tampilkan QR sebagai <img> bila ada; jika tidak ada, info status
  if (!lastQr) {
    return res
      .status(200)
      .type('text/html')
      .send('<pre>QR belum siap atau sudah terscan.\nBot is running</pre>')
  }

  // coba render <img> pakai data:url (butuh qrcode untuk memperindah)
  try {
    // optional dep: qrcode
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.status(200).type('text/html').send(`<img src="${dataUrl}" />`)
    }
  } catch (_) {
    // abaikan, fallback teks
  }
  // fallback: tampilkan string QR apa adanya (masih bisa discan via layar lain)
  res.status(200).type('text/plain').send(lastQr)
})

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`)
})

// ------ WHATSAPP ------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const logger = pino({ level: 'info' })

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // deprecated; kita handle sendiri via /qr
    auth: state,
    browser: ['Ubuntu', 'Chrome', '22.04.4'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  })

  // connection.update: simpan QR (untuk /qr) & info koneksi
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      lastQr = qr
      console.log('📲 QR diterima, buka /qr untuk scan')
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      const isRestart =
        lastDisconnect?.error?.message?.includes('Stream Errored') ||
        reason === DisconnectReason.loggedOut
      console.log('❌ Koneksi terputus, mencoba reconnect...')
      if (isRestart) setTimeout(() => start(), 1500)
    } else if (connection === 'open') {
      lastQr = null
      console.log('✅ Bot WhatsApp siap!')
    }
  })

  // simpan creds
  sock.ev.on('creds.update', saveCreds)

  // handler pesan
  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return
    for (const msg of ev.messages) {
      try {
        // filter awal
        if (shouldIgnoreMessage(msg)) continue

        // anti-duplikat berdasar stanzaId
        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)
        if (processedMsgIds.size > 5000) {
          // ring buffer sederhana
          const first = processedMsgIds.values().next().value
          processedMsgIds.delete(first)
        }

        const text = normalizeText(extractText(msg))
        // trigger kata "emas" (case-insensitive), persis atau mengandung
        if (!text) continue
        if (!/\bemas\b/.test(text)) continue

        const sendTarget = msg.key.remoteJid // <<<<<< target yang benar (pengirim/grup)

        // anti-spam: cooldown per chat 3 detik + throttle global 300ms
        const now = Date.now()
        if (now - (lastReplyAtPerChat.get(sendTarget) || 0) < 3000) continue
        if (now - lastGlobalReplyAt < 300) continue

        // ambil harga
        let replyText
        try {
          const data = await fetchTreasury()
          replyText = formatTreasuryText(data)
        } catch (e) {
          replyText = '❌ Gagal ambil harga Treasury. Coba lagi sebentar.'
          pushLog(`ERR fetchTreasury: ${e?.message || e}`)
        }

        // kirim balasan (quote pesan pengguna)
        await sock.sendMessage(
          sendTarget,
          { text: replyText },
          { quoted: msg }
        )

        // update rate-limit
        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
      } catch (e) {
        pushLog(`ERR handler: ${e?.message || e}`)
      }
    }
  })
}

start().catch((e) => {
  console.error('Fatal start error:', e)
  process.exit(1)
})
