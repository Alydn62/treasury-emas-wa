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

function formatUSD(n) {
  return typeof n === 'number'
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : (Number(n || 0) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Hitung diskon sesuai tabel Treasury
function calculateDiscount(investmentAmount) {
  const MAX_DISCOUNT = 1020000
  
  let discountPercent
  
  if (investmentAmount <= 250000) {
    discountPercent = 3.0
  } else if (investmentAmount <= 5000000) {
    discountPercent = 3.4
  } else if (investmentAmount <= 10000000) {
    discountPercent = 3.45
  } else if (investmentAmount <= 20000000) {
    discountPercent = 3.425
  } else {
    discountPercent = 3.4
  }
  
  const calculatedDiscount = investmentAmount * (discountPercent / 100)
  return Math.min(calculatedDiscount, MAX_DISCOUNT)
}

function calculateProfit(buyRate, sellRate, investmentAmount) {
  const originalPrice = investmentAmount
  const discountAmount = calculateDiscount(investmentAmount)
  const discountedPrice = investmentAmount - discountAmount
  const totalGrams = investmentAmount / buyRate
  const sellValue = totalGrams * sellRate
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

// Fetch USD/IDR dari Google Finance dengan scraping
async function fetchUSDIDRFromGoogle() {
  try {
    const url = 'https://www.google.com/finance/quote/USD-IDR'
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
      }
    })
    
    if (!res.ok) {
      throw new Error(`Google Finance HTTP ${res.status}`)
    }
    
    const html = await res.text()
    
    // Extract harga dari HTML
    // Pattern 1: <div class="YMlKec fxKbKc">15,750.00</div>
    let rateMatch = html.match(/class="YMlKec fxKbKc">([0-9,\.]+)</i)
    
    if (!rateMatch) {
      // Pattern 2: data-last-price="15750.00"
      rateMatch = html.match(/data-last-price="([0-9,\.]+)"/i)
    }
    
    if (!rateMatch) {
      // Pattern 3: Cari angka setelah "USD to IDR"
      rateMatch = html.match(/USD to IDR[^\d]+([\d,\.]+)/i)
    }
    
    if (rateMatch && rateMatch[1]) {
      const rateStr = rateMatch[1].replace(/,/g, '')
      const rate = parseFloat(rateStr)
      
      if (rate > 1000 && rate < 50000) { // Sanity check
        pushLog(`Google Finance USD/IDR: ${rate}`)
        
        // Extract perubahan harga (opsional)
        let change = 0
        let changePercent = 0
        
        const changeMatch = html.match(/class="[^"]*P2Luy[^"]*[^>]*>\s*([+-]?[\d,\.]+)\s*\(([+-]?[\d,\.]+)%\)/i)
        if (changeMatch) {
          change = parseFloat(changeMatch[1].replace(/,/g, ''))
          changePercent = parseFloat(changeMatch[2].replace(/,/g, ''))
        }
        
        return {
          rate,
          change,
          changePercent,
          source: 'Google Finance',
          timestamp: Date.now()
        }
      }
    }
    
    throw new Error('Failed to parse USD/IDR from Google Finance')
    
  } catch (e) {
    pushLog(`Google Finance scraping failed: ${e.message}`)
    throw e
  }
}

// Fetch USD/IDR dengan multiple fallback
async function fetchUSDIDR() {
  // Try 1: Google Finance (Primary)
  try {
    const data = await fetchUSDIDRFromGoogle()
    return data
  } catch (e) {
    pushLog(`Google Finance failed, trying fallback APIs`)
  }

  // Try 2: ExchangeRate-API.com
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    if (res.ok) {
      const json = await res.json()
      const rate = json.rates?.IDR || 0
      return {
        rate,
        change: 0,
        changePercent: 0,
        source: 'ExchangeRate-API',
        timestamp: Date.now()
      }
    }
  } catch (e) {
    pushLog(`ExchangeRate-API failed: ${e.message}`)
  }

  // Try 3: FreeCurrencyAPI
  try {
    const res = await fetch('https://api.freecurrencyapi.com/v1/latest?apikey=fca_live_demo&currencies=IDR&base_currency=USD')
    if (res.ok) {
      const json = await res.json()
      const rate = json.data?.IDR || 0
      return {
        rate,
        change: 0,
        changePercent: 0,
        source: 'FreeCurrencyAPI',
        timestamp: Date.now()
      }
    }
  } catch (e) {
    pushLog(`FreeCurrencyAPI failed: ${e.message}`)
  }

  // Fallback manual
  pushLog('All USD/IDR APIs failed, using fallback')
  return {
    rate: 15750,
    change: 0,
    changePercent: 0,
    source: 'Fallback',
    timestamp: Date.now()
  }
}

// Fetch XAU/USD price
async function fetchGoldPrice() {
  // Try API 1: metals.live
  try {
    const res = await fetch('https://api.metals.live/v1/spot/gold')
    if (res.ok) {
      const json = await res.json()
      const data = json[0] || {}
      return {
        price: data.price || 0,
        change: data.change || 0,
        changePercent: data.changePct || 0,
        timestamp: data.timestamp || Date.now(),
        source: 'Metals.live'
      }
    }
  } catch (e) {
    pushLog(`Metals.live API failed: ${e.message}`)
  }

  // Try API 2: goldapi.io
  try {
    const res = await fetch('https://www.goldapi.io/api/XAU/USD', {
      headers: {
        'x-access-token': 'goldapi-demo'
      }
    })
    
    if (res.ok) {
      const json = await res.json()
      return {
        price: json.price || 0,
        change: json.ch || 0,
        changePercent: json.chp || 0,
        timestamp: json.timestamp || Date.now(),
        source: 'GoldAPI.io'
      }
    }
  } catch (e) {
    pushLog(`GoldAPI failed: ${e.message}`)
  }

  // Fallback
  return {
    price: 2650.00,
    change: 0,
    changePercent: 0,
    timestamp: Date.now(),
    source: 'Fallback'
  }
}

function formatTreasuryWithCalculator(treasuryPayload, goldPriceData, usdIdrData) {
  const buy = treasuryPayload?.data?.buying_rate
  const sell = treasuryPayload?.data?.selling_rate
  const updated = treasuryPayload?.data?.updated_at || new Date().toISOString()

  const spread = Math.abs(sell - buy)
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  const dateStr = updated.split('T')[0] || ''
  const timeStr = updated.split('T')[1]?.substring(0, 8) || ''

  // XAU/USD
  const xauPrice = goldPriceData?.price || 0
  const xauChange = goldPriceData?.change || 0
  const xauChangePercent = goldPriceData?.changePercent || 0
  const xauEmoji = xauChange >= 0 ? '📈' : '📉'
  const xauSign = xauChange >= 0 ? '+' : ''

  // USD/IDR
  const usdIdrRate = usdIdrData?.rate || 0
  const usdIdrChange = usdIdrData?.change || 0
  const usdIdrChangePercent = usdIdrData?.changePercent || 0
  const usdIdrSource = usdIdrData?.source || 'N/A'
  const usdIdrEmoji = usdIdrChange >= 0 ? '📈' : '📉'
  const usdIdrSign = usdIdrChange >= 0 ? '+' : ''

  // Hitung harga emas dalam IDR per gram
  const gramPerOz = 31.1035
  const xauPricePerGram = xauPrice / gramPerOz
  const xauPriceIDRPerGram = xauPricePerGram * usdIdrRate

  const investments = [250000, 5000000, 10000000, 20000000, 30000000]
  
  let calculatorText = investments.map(amount => {
    const calc = calculateProfit(buy, sell, amount)
    
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

  // Format change untuk USD/IDR jika ada
  let usdIdrChangeText = ''
  if (usdIdrChange !== 0 || usdIdrChangePercent !== 0) {
    usdIdrChangeText = `\nChange: ${usdIdrSign}Rp${formatRupiah(Math.abs(Math.round(usdIdrChange)))} (${usdIdrSign}${Math.abs(usdIdrChangePercent).toFixed(2)}%) ${usdIdrEmoji}`
  }

  return `🚨 DISKON TREASURY 🇮🇩
Waktu: ${dateStr} ${timeStr}

💰 Harga Emas Sekarang:
Buying: Rp${formatRupiah(buy)}
Selling: Rp${formatRupiah(sell)}

📈 Spread: Rp${formatRupiah(spread)} (${spreadPercent}%)

🌍 Chart Harga Emas (XAU/USD):
Price: $${formatUSD(xauPrice)}/oz
Change: ${xauSign}$${formatUSD(Math.abs(xauChange))} (${xauSign}${Math.abs(xauChangePercent).toFixed(2)}%) ${xauEmoji}

💵 Kurs USD/IDR (${usdIdrSource}):
Rate: Rp${formatRupiah(Math.round(usdIdrRate))}${usdIdrChangeText}

💎 Harga Emas Global (IDR):
Rp${formatRupiah(Math.round(xauPriceIDRPerGram))}/gram

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

app.get('/gold', async (_req, res) => {
  try {
    const goldPrice = await fetchGoldPrice()
    res.json(goldPrice)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/usd-idr', async (_req, res) => {
  try {
    const usdIdr = await fetchUSDIDR()
    res.json(usdIdr)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`)
  console.log(`📊 Stats endpoint: http://localhost:${PORT}/stats`)
  console.log(`🏆 Gold price: http://localhost:${PORT}/gold`)
  console.log(`💵 USD/IDR rate: http://localhost:${PORT}/usd-idr`)
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
          const [treasuryData, goldPriceData, usdIdrData] = await Promise.all([
            fetchTreasury(),
            fetchGoldPrice(),
            fetchUSDIDR()
          ])
          
          replyText = formatTreasuryWithCalculator(treasuryData, goldPriceData, usdIdrData)
          pushLog('All data fetched successfully')
        } catch (e) {
          replyText = '❌ Gagal mengambil data. Coba lagi sebentar.'
          pushLog(`ERR fetchData: ${e?.message || e}`)
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
