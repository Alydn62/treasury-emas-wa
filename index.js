// index.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'

// ------ CONFIG ------
const PORT = process.env.PORT || 8000
const TREASURY_URL = process.env.TREASURY_URL ||
  'https://api.treasury.id/api/v1/antigrvty/gold/rate'

// Anti-spam settings (lebih ketat untuk menghindari block)
const COOLDOWN_PER_CHAT = 60000 // 60 detik (1 menit) per chat
const GLOBAL_THROTTLE = 2000 // 2 detik antar pesan global
const MAX_MESSAGES_PER_HOUR = 20 // Maksimal 20 pesan per jam
const MAX_MESSAGES_PER_DAY = 100 // Maksimal 100 pesan per hari

// ------ STATE ------
let lastQr = null
const logs = []
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0

// Tracking untuk rate limiting
const messageCountPerHour = new Map()
const messageCountPerDay = new Map()

// Batasi log max 100
function pushLog(s) {
  logs.push(`${new Date().toISOString()} ${s}`)
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

// Reset counter setiap jam
setInterval(() => {
  messageCountPerHour.clear()
  pushLog('Hourly message counter reset')
}, 60 * 60 * 1000)

// Reset counter setiap hari
setInterval(() => {
  messageCountPerDay.clear()
  pushLog('Daily message counter reset')
}, 24 * 60 * 60 * 1000)

// ------ UTIL ------
function normalizeText(msg) {
  if (!msg) return ''
  return msg.replace(/\s+/g, ' ').trim().toLowerCase()
}

function shouldIgnoreMessage(m) {
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

  // Hitung spread
  const spread = Math.abs(sell - buy)
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  return `📊 Harga Treasury 🇮🇩:

💰 Buy : Rp ${fmt(buy)}
💸 Sell: Rp ${fmt(sell)}

📈 Spread: Rp ${fmt(spread)} (${spreadPercent}%)

⏰ Update: ${updated}

⚠️ Bot ini memiliki limit penggunaan untuk menghindari pemblokiran.`
}

async function fetchTreasury() {
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

// Cek apakah sudah melebihi limit
function isRateLimited(chatId) {
  const hourCount = messageCountPerHour.get(chatId) || 0
  const dayCount = messageCountPerDay.get(chatId) || 0
  
  return hourCount >= MAX_MESSAGES_PER_HOUR || dayCount >= MAX_MESSAGES_PER_DAY
}

// Increment counter
function incrementMessageCount(chatId) {
  messageCountPerHour.set(chatId, (messageCountPerHour.get(chatId) || 0) + 1)
  messageCountPerDay.set(chatId, (messageCountPerDay.get(chatId) || 0) + 1)
}

// ------ EXPRESS ------
const app = express()
app.get('/', (_req, res) => {
  res.type('text/plain').send('Bot is running')
})

app.get('/qr', async (_req, res) => {
  if (!lastQr) {
    return res
      .status(200)
      .type('text/html')
      .send('<pre>QR belum siap atau sudah terscan.\nBot is running</pre>')
  }

  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.status(200).type('text/html').send(`<img src="${dataUrl}" />`)
    }
  } catch (_) {
    // fallback teks
  }
  res.status(200).type('text/plain').send(lastQr)
})

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`)
})

// ------ WHATSAPP ------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const logger = pino({ level: 'silent' }) // Ubah ke 'silent' untuk mengurangi log

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'), // Gunakan browser yang lebih umum
    markOnlineOnConnect: true, // Tampilkan online saat connect
    syncFullHistory: false,
    getMessage: async (key) => {
      return { conversation: '' }
    }
  })

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      lastQr = qr
      console.log('📲 QR diterima, buka /qr untuk scan')
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      
      console.log('❌ Koneksi terputus, reason:', reason)
      
      if (shouldReconnect) {
        // Tunggu lebih lama sebelum reconnect untuk menghindari spam
        console.log('⏳ Menunggu 5 detik sebelum reconnect...')
        setTimeout(() => start(), 5000)
      }
    } else if (connection === 'open') {
      lastQr = null
      console.log('✅ Bot WhatsApp siap!')
      pushLog('Bot connected successfully')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return
    
    for (const msg of ev.messages) {
      try {
        // Filter awal
        if (shouldIgnoreMessage(msg)) continue

        // Anti-duplikat berdasar stanzaId
        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)
        if (processedMsgIds.size > 5000) {
          const first = processedMsgIds.values().next().value
          processedMsgIds.delete(first)
        }

        const text = normalizeText(extractText(msg))
        if (!text) continue
        
        // Trigger kata "emas"
        if (!/\bemas\b/.test(text)) continue

        const sendTarget = msg.key.remoteJid

        // Rate limiting - lebih ketat
        const now = Date.now()
        
        // Cek cooldown per chat (10 detik)
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        if (now - lastReply < COOLDOWN_PER_CHAT) {
          pushLog(`Cooldown active for ${sendTarget}`)
          continue
        }
        
        // Cek global throttle (1 detik)
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) {
          pushLog(`Global throttle active`)
          continue
        }
        
        // Cek rate limit per jam dan per hari
        if (isRateLimited(sendTarget)) {
          pushLog(`Rate limit exceeded for ${sendTarget}`)
          await sock.sendMessage(
            sendTarget,
            { 
              text: '⚠️ Maaf, Anda sudah mencapai batas penggunaan bot. Silakan coba lagi nanti untuk menghindari pemblokiran WhatsApp.' 
            },
            { quoted: msg }
          )
          continue
        }

        // Ambil harga
        let replyText
        try {
          const data = await fetchTreasury()
          replyText = formatTreasuryText(data)
        } catch (e) {
          replyText = '❌ Gagal mengambil harga Treasury. Coba lagi sebentar.'
          pushLog(`ERR fetchTreasury: ${e?.message || e}`)
        }

        // Kirim balasan dengan delay random untuk terlihat lebih natural
        const randomDelay = Math.floor(Math.random() * 2000) + 1000 // 1-3 detik
        await new Promise(r => setTimeout(r, randomDelay))
        
        await sock.sendMessage(
          sendTarget,
          { text: replyText },
          { quoted: msg }
        )

        // Update counter dan timestamp
        incrementMessageCount(sendTarget)
        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        pushLog(`Replied to ${sendTarget}`)
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
