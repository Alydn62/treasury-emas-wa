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

// Anti-spam settings
const COOLDOWN_PER_CHAT = 60000
const GLOBAL_THROTTLE = 3000
const TYPING_DURATION = 6000
const RANDOM_DELAY_MIN = 2000
const RANDOM_DELAY_MAX = 5000

// Reconnect backoff
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
const BASE_RECONNECT_DELAY = 5000

// ------ STATE ------
let lastQr = null
const logs = []
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0
let isReady = false

function pushLog(s) {
  logs.push(`${new Date().toISOString()} ${s}`)
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

setInterval(() => {
  if (processedMsgIds.size > 2000) {
    const idsArray = Array.from(processedMsgIds)
    const toKeep = idsArray.slice(-1000)
    processedMsgIds.clear()
    toKeep.forEach(id => processedMsgIds.add(id))
    pushLog(`Cleaned up message IDs, kept ${toKeep.length}`)
  }
}, 30 * 60 * 1000)

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

function formatRupiah(n) {
  return typeof n === 'number'
    ? n.toLocaleString('id-ID')
    : (Number(n || 0) || 0).toLocaleString('id-ID')
}

// PERBAIKAN: Hitung diskon sesuai tabel Treasury (max Rp1.020.000)
function calculateDiscount(investmentAmount) {
  const MAX_DISCOUNT = 1020000 // Maksimal diskon Rp1.020.000
  
  // Diskon progresif berdasarkan nominal
  let discountPercent
  
  if (investmentAmount <= 250000) {
    discountPercent = 3.0 // 3%
  } else if (investmentAmount <= 5000000) {
    discountPercent = 3.4 // 3.4%
  } else if (investmentAmount <= 10000000) {
    discountPercent = 3.45 // 3.45%
  } else if (investmentAmount <= 20000000) {
    discountPercent = 3.425 // 3.425%
  } else {
    discountPercent = 3.4 // 3.4% untuk 30jt+
  }
  
  const calculatedDiscount = investmentAmount * (discountPercent / 100)
  
  // Cap discount di Rp1.020.000
  return Math.min(calculatedDiscount, MAX_DISCOUNT)
}

// Hitung profit dengan diskon dinamis
function calculateProfit(buyRate, sellRate, investmentAmount) {
  // 1. Harga awal
  const originalPrice = investmentAmount
  
  // 2. Hitung diskon (max Rp1.020.000)
  const discountAmount = calculateDiscount(investmentAmount)
  const discountedPrice = investmentAmount - discountAmount
  
  // 3. Total gram = Harga Awal / Harga Beli API
  const totalGrams = investmentAmount / buyRate
  
  // 4. Harga Jual = Total Gram × Harga Jual API
  const sellValue = totalGrams * sellRate
  
  // 5. Profit = Harga Jual - Harga Setelah Diskon
  const totalProfit = sellValue - discountedPrice
  
  return {
    originalPrice,
    discountAmount,
    discountedPrice,
    totalGrams,
    sellValue,
    profit: totalProfit
  }
}

function formatTreasuryWithCalculator(payload) {
  const buy = payload?.data?.buying_rate
  const sell = payload?.data?.selling_rate
  const updated = payload?.data?.updated_at || new Date().toISOString()

  // Hitung spread
  const spread = Math.abs(sell - buy)
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  // Format waktu
  const dateStr = updated.split('T')[0] || ''
  const timeStr = updated.split('T')[1]?.substring(0, 8) || ''

  // Nominal investasi sesuai tabel Treasury
  const investments = [250000, 5000000, 10000000, 20000000, 30000000]
  
  let calculatorText = investments.map(amount => {
    const calc = calculateProfit(buy, sell, amount)
    
    // Format profit dengan emoji
    let profitEmoji = '📉 -'
    if (calc.profit > 0) {
      if (calc.profit >= 1500) profitEmoji = '🚀 ++'
      else if (calc.profit >= 1000) profitEmoji = '📈'
      else if (calc.profit >= 500) profitEmoji = '📊'
      else profitEmoji = '📉'
    }
    
    return `Harga Awal: Rp${formatRupiah(calc.originalPrice)}
Harga Setelah Diskon: Rp${formatRupiah(Math.round(calc.discountedPrice))}
Total Gram: ${calc.totalGrams.toFixed(4)} gram
Profit: Rp${formatRupiah(Math.round(calc.profit))} ${profitEmoji}`
  }).join('\n\n')

  return `🚨 DISKON TREASURY 🇮🇩
Waktu: ${dateStr} ${timeStr}

💰 Harga Emas Sekarang:
Buying: Rp${formatRupiah(buy)}
Selling: Rp${formatRupiah(sell)}

📈 Spread: Rp${formatRupiah(spread)} (${spreadPercent}%)

${calculatorText}

⚠️ Bot akan reply max 1x per menit untuk menghindari pemblokiran.`
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
  } catch (_) {}
  res.status(200).type('text/plain').send(lastQr)
})

app.get('/stats', (_req, res) => {
  const stats = {
    isReady,
    reconnectAttempts,
    totalChats: lastReplyAtPerChat.size,
    processedMessages: processedMsgIds.size,
    activeChats: Array.from(lastReplyAtPerChat.entries()).map(([chat, lastTime]) => ({
      chat: chat.substring(0, 20) + '...',
      lastReply: new Date(lastTime).toISOString(),
      cooldownRemaining: Math.max(0, Math.round((COOLDOWN_PER_CHAT - (Date.now() - lastTime)) / 1000))
    })),
    recentLogs: logs.slice(-20)
  }
  res.json(stats)
})

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    isReady,
    timestamp: new Date().toISOString()
  })
})

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`)
  console.log(`📊 Stats endpoint: http://localhost:${PORT}/stats`)
})

// ------ WHATSAPP ------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      return { conversation: '' }
    }
  })

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    if (qr) {
      lastQr = qr
      console.log('📲 QR diterima, buka /qr untuk scan')
      pushLog('QR code generated')
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      
      console.log('❌ Koneksi terputus, reason:', reason)
      pushLog(`Connection closed: ${reason}`)
      
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts)
        reconnectAttempts++
        console.log(`⏳ Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`)
        pushLog(`Reconnect scheduled in ${delay}ms`)
        setTimeout(() => start(), delay)
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max reconnect attempts reached. Exiting...')
        pushLog('Max reconnect attempts reached')
        process.exit(1)
      }
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      console.log('✅ Bot WhatsApp connected!')
      
      isReady = false
      pushLog('Bot connected, entering 15s warmup period...')
      console.log('⏳ Warmup period 15 detik...')
      
      setTimeout(() => {
        isReady = true
        pushLog('Bot ready to receive messages')
        console.log('🟢 Bot siap menerima pesan!')
      }, 15000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady) {
      pushLog('Message received during warmup, ignored')
      return
    }
    
    if (ev.type !== 'notify') return
    
    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) {
          pushLog(`Duplicate message ignored: ${stanzaId}`)
          continue
        }
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text) continue
        
        if (!/\bemas\b/.test(text)) continue

        const sendTarget = msg.key.remoteJid
        const now = Date.now()
        
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        const timeSinceLastReply = now - lastReply
        if (timeSinceLastReply < COOLDOWN_PER_CHAT) {
          const remainingSeconds = Math.ceil((COOLDOWN_PER_CHAT - timeSinceLastReply) / 1000)
          pushLog(`Cooldown active for ${sendTarget}, ${remainingSeconds}s remaining`)
          continue
        }
        
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) {
          pushLog(`Global throttle active`)
          continue
        }

        pushLog(`Processing message from ${sendTarget}`)

        console.log(`⌨️  Typing for ${sendTarget}...`)
        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
        } catch (e) {
          pushLog(`Failed to send typing indicator: ${e.message}`)
        }
        
        await new Promise(r => setTimeout(r, TYPING_DURATION))

        let replyText
        try {
          const data = await fetchTreasury()
          replyText = formatTreasuryWithCalculator(data)
          pushLog('Treasury data fetched successfully')
        } catch (e) {
          replyText = '❌ Gagal mengambil harga Treasury. Coba lagi sebentar.'
          pushLog(`ERR fetchTreasury: ${e?.message || e}`)
        }

        const randomDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN)) + RANDOM_DELAY_MIN
        await new Promise(r => setTimeout(r, randomDelay))
        
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (e) {
          pushLog(`Failed to stop typing indicator: ${e.message}`)
        }
        
        await sock.sendMessage(
          sendTarget,
          { text: replyText },
          { quoted: msg }
        )

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        console.log(`✅ Replied to ${sendTarget}`)
        pushLog(`Successfully replied to ${sendTarget}`)
        
        await new Promise(r => setTimeout(r, 2000))
        
      } catch (e) {
        pushLog(`ERR handler: ${e?.message || e}`)
        console.error('Error handling message:', e)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })
}

start().catch((e) => {
  console.error('Fatal start error:', e)
  pushLog(`Fatal error: ${e.message}`)
  process.exit(1)
})
