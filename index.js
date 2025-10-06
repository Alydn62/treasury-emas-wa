// index.js
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  Browsers,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'
import NodeCache from 'node-cache'

// ------ CONFIG ------
const PORT = process.env.PORT || 8000
const TREASURY_URL = process.env.TREASURY_URL ||
  'https://api.treasury.id/api/v1/antigrvty/gold/rate'

// Anti-spam settings (LEBIH KETAT untuk mencegah logout)
const COOLDOWN_PER_CHAT = 120000 // 2 menit (lebih aman)
const GLOBAL_THROTTLE = 5000 // 5 detik antar pesan
const TYPING_DURATION = 6000
const RANDOM_DELAY_MIN = 3000 // Min 3 detik
const RANDOM_DELAY_MAX = 7000 // Max 7 detik

// Reconnect backoff
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10 // Lebih banyak attempt
const BASE_RECONNECT_DELAY = 10000 // 10 detik

// ------ STATE ------
let lastQr = null
const logs = []
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0
let isReady = false
const msgRetryCounterCache = new NodeCache() // Cache untuk message retry

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

async function fetchUSDIDRFromGoogle() {
  try {
    const url = 'https://www.google.com/finance/quote/USD-IDR'
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      }
    })
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    
    const html = await res.text()
    
    let rateMatch = html.match(/class="YMlKec fxKbKc">([0-9,\.]+)</i)
    if (!rateMatch) {
      rateMatch = html.match(/data-last-price="([0-9,\.]+)"/i)
    }
    if (!rateMatch) {
      rateMatch = html.match(/USD to IDR[^\d]+([\d,\.]+)/i)
    }
    
    if (rateMatch && rateMatch[1]) {
      const rateStr = rateMatch[1].replace(/,/g, '')
      const rate = parseFloat(rateStr)
      
      if (rate > 1000 && rate < 50000) {
        pushLog(`Google Finance USD/IDR: ${rate}`)
        
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
          changePercent
        }
      }
    }
    
    throw new Error('Failed to parse')
  } catch (e) {
    pushLog(`Google Finance error: ${e.message}`)
    return {
      rate: 15750,
      change: 0,
      changePercent: 0
    }
  }
}

async function fetchGoldPrice() {
  try {
    const res = await fetch('https://api.metals.live/v1/spot/gold')
    if (res.ok) {
      const json = await res.json()
      const data = json[0] || {}
      return {
        price: data.price || 2650,
        change: data.change || 0,
        changePercent: data.changePct || 0
      }
    }
  } catch (e) {
    pushLog(`Gold API error: ${e.message}`)
  }
  
  return {
    price: 2650,
    change: 0,
    changePercent: 0
  }
}

function formatMessage(treasuryData, goldData, usdIdrData) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0
  const updated = treasuryData?.data?.updated_at || new Date().toISOString()
  
  const dateStr = updated.split('T')[0] || ''
  const timeStr = updated.split('T')[1]?.substring(0, 5) || ''
  
  const xauPrice = goldData.price
  const xauChange = goldData.change
  const xauChangePercent = goldData.changePercent
  const xauEmoji = xauChange >= 0 ? '📈' : '📉'
  const xauSign = xauChange >= 0 ? '+' : ''
  
  const usdIdrRate = usdIdrData.rate
  const usdIdrChange = usdIdrData.change
  const usdIdrChangePercent = usdIdrData.changePercent
  const usdIdrEmoji = usdIdrChange >= 0 ? '📈' : '📉'
  const usdIdrSign = usdIdrChange >= 0 ? '+' : ''
  
  const gramPerOz = 31.1035
  const xauPricePerGram = xauPrice / gramPerOz
  const xauPriceIDR = xauPricePerGram * usdIdrRate
  
  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)
  
  return `✨ *HARGA EMAS HARI INI* ✨
📅 ${dateStr} ${timeStr} WIB

━━━━━━━━━━━━━━━━━━━━━
💰 *HARGA TREASURY INDONESIA*

📊 Beli Emas:
   Rp${formatRupiah(buy)}/gram

📊 Jual Emas:
   Rp${formatRupiah(sell)}/gram

📉 Spread: Rp${formatRupiah(spread)} (${spreadPercent}%)

━━━━━━━━━━━━━━━━━━━━━
💵 Kurs USD/IDR:
   Rp${formatRupiah(Math.round(usdIdrRate))}
   ${usdIdrSign}Rp${formatRupiah(Math.abs(Math.round(usdIdrChange)))} (${usdIdrSign}${Math.abs(usdIdrChangePercent).toFixed(2)}%) ${usdIdrEmoji}
━━━━━━━━━━━━━━━━━━━━━
🎁 *SIMULASI DISKON TREASURY*
(Diskon hingga Rp1.020.000)

${generateDiscountSimulation(buy, sell)}

━━━━━━━━━━━━━━━━━━━━━
⏱️ _Bot akan reply 1x per 2 menit_
📊 _Data real-time dari Google Finance_`
}

function generateDiscountSimulation(buy, sell) {
  const amounts = [
    { value: 250000, label: '250rb' },
    { value: 5000000, label: '5jt' },
    { value: 10000000, label: '10jt' },
    { value: 20000000, label: '20jt' },
    { value: 30000000, label: '30jt' }
  ]
  
  return amounts.map(({ value, label }) => {
    const calc = calculateProfit(buy, sell, value)
    
    let emoji = '📉'
    if (calc.profit > 0) {
      if (calc.profit >= 1500) emoji = '🚀'
      else if (calc.profit >= 1000) emoji = '💎'
      else if (calc.profit >= 500) emoji = '📈'
    }
    
    const profitSign = calc.profit >= 0 ? '+' : ''
    
    return `💰 *Nominal ${label}*
   Harga: Rp${formatRupiah(value)}
   Diskon: Rp${formatRupiah(Math.round(calc.discountAmount))}
   Bayar: Rp${formatRupiah(Math.round(calc.discountedPrice))}
   Dapat: ${calc.totalGrams.toFixed(4)} gram
   Profit: ${profitSign}Rp${formatRupiah(Math.round(calc.profit))} ${emoji}`
  }).join('\n\n')
}

async function fetchTreasury() {
  let lastErr
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(TREASURY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
        throw new Error('Invalid data')
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
  res.type('text/plain').send('✅ Bot WhatsApp Emas is running')
})

app.get('/qr', async (_req, res) => {
  if (!lastQr) {
    return res
      .status(200)
      .type('text/html')
      .send('<pre>QR belum siap atau sudah terscan.\n\n✅ Bot is running</pre>')
  }

  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.status(200).type('text/html').send(`
        <div style="text-align: center; padding: 20px;">
          <h2>📱 Scan QR Code</h2>
          <img src="${dataUrl}" style="max-width: 400px;" />
          <p>Scan dengan WhatsApp untuk connect bot</p>
        </div>
      `)
    }
  } catch (_) {}
  res.status(200).type('text/plain').send(lastQr)
})

app.get('/stats', (_req, res) => {
  const stats = {
    status: isReady ? '🟢 Online' : '🔴 Warming up',
    uptime: Math.floor(process.uptime()),
    totalChats: lastReplyAtPerChat.size,
    processedMessages: processedMsgIds.size,
    reconnectAttempts,
    activeChats: Array.from(lastReplyAtPerChat.entries())
      .slice(-10)
      .map(([chat, lastTime]) => ({
        chat: chat.substring(0, 25) + '...',
        lastReply: new Date(lastTime).toISOString(),
        cooldown: Math.max(0, Math.round((COOLDOWN_PER_CHAT - (Date.now() - lastTime)) / 1000)) + 's'
      })),
    recentLogs: logs.slice(-15)
  }
  res.json(stats)
})

app.get('/test', async (_req, res) => {
  try {
    const [treasury, gold, usdIdr] = await Promise.all([
      fetchTreasury(),
      fetchGoldPrice(),
      fetchUSDIDRFromGoogle()
    ])
    
    const message = formatMessage(treasury, gold, usdIdr)
    res.type('text/plain').send(message)
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`)
  }
})

app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`)
  console.log(`📊 Stats: http://localhost:${PORT}/stats`)
  console.log(`🧪 Test: http://localhost:${PORT}/test`)
  console.log(`📱 QR: http://localhost:${PORT}/qr`)
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
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Desktop'), // PENTING: Gunakan Desktop, bukan Mobile
    markOnlineOnConnect: false, // PENTING: Jangan auto online
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000, // PENTING: Keep alive setiap 30 detik
    connectTimeoutMs: 60000,
    msgRetryCounterCache, // PENTING: Cache untuk retry
    generateHighQualityLinkPreview: false,
    patchMessageBeforeSending: (message) => {
      // PENTING: Patch message untuk mencegah error
      const requiresPatch = !!(
        message.buttonsMessage ||
        message.templateMessage ||
        message.listMessage
      )
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        }
      }
      return message
    },
    getMessage: async (key) => {
      return { conversation: '' }
    }
  })

  // PENTING: Handle keepalive
  setInterval(() => {
    if (sock && sock.ws && sock.ws.readyState === 1) {
      sock.ws.ping()
      pushLog('Keepalive ping sent')
    }
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    
    if (qr) {
      lastQr = qr
      console.log('📲 QR code ready - Open /qr to scan')
      pushLog('QR generated')
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = reason !== DisconnectReason.loggedOut
      
      console.log('❌ Connection closed:', reason)
      pushLog(`Closed: ${reason}`)
      
      // PENTING: Detail error logging
      if (reason === DisconnectReason.loggedOut) {
        console.log('⚠️  LOGGED OUT - Scan QR lagi!')
        pushLog('LOGGED OUT - Need QR scan')
        reconnectAttempts = 0
        // Jangan reconnect otomatis jika logged out
        return
      }
      
      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts) // Exponential backoff lebih lembut
        reconnectAttempts++
        console.log(`⏳ Reconnecting in ${Math.round(delay/1000)}s (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        pushLog(`Reconnect attempt ${reconnectAttempts}`)
        setTimeout(() => start(), delay)
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error('❌ Max reconnect attempts - stopping')
        pushLog('Max attempts reached')
        process.exit(1)
      }
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      console.log('✅ WhatsApp connected!')
      pushLog('Connected successfully')
      
      // PENTING: Warmup period lebih lama
      isReady = false
      console.log('⏳ Warmup 30s untuk stabilitas...')
      pushLog('Warmup started')
      
      setTimeout(() => {
        isReady = true
        console.log('🟢 Bot ready to receive messages!')
        pushLog('Bot ready')
      }, 30000) // 30 detik warmup
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // PENTING: Handle presence update untuk tetap terlihat aktif
  sock.ev.on('presence.update', async (data) => {
    pushLog(`Presence update: ${data.id}`)
  })

  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady) {
      pushLog('Message ignored - warmup period')
      return
    }
    if (ev.type !== 'notify') return
    
    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text || !/\bemas\b/.test(text)) continue

        const sendTarget = msg.key.remoteJid
        const now = Date.now()
        
        // Cooldown check - 2 menit
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        if (now - lastReply < COOLDOWN_PER_CHAT) {
          const remaining = Math.ceil((COOLDOWN_PER_CHAT - (now - lastReply)) / 1000)
          pushLog(`Cooldown: ${sendTarget} (${remaining}s remaining)`)
          continue
        }
        
        // Global throttle - 5 detik
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) {
          pushLog('Global throttle active')
          continue
        }

        pushLog(`Processing message from: ${sendTarget}`)

        // Typing indicator
        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
          pushLog('Typing indicator sent')
        } catch (e) {
          pushLog(`Typing error: ${e.message}`)
        }
        
        await new Promise(r => setTimeout(r, TYPING_DURATION))

        // Fetch data
        let replyText
        try {
          const [treasury, gold, usdIdr] = await Promise.all([
            fetchTreasury(),
            fetchGoldPrice(),
            fetchUSDIDRFromGoogle()
          ])
          
          replyText = formatMessage(treasury, gold, usdIdr)
          pushLog('Data fetched successfully')
        } catch (e) {
          replyText = '❌ Maaf, gagal mengambil data harga emas.\n\n⏱️ Silakan coba lagi dalam beberapa saat.'
          pushLog(`Fetch error: ${e.message}`)
        }

        // Random delay lebih lama
        const randomDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN)) + RANDOM_DELAY_MIN
        await new Promise(r => setTimeout(r, randomDelay))
        
        // Stop typing
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (e) {
          pushLog(`Pause typing error: ${e.message}`)
        }
        
        // Send message
        await sock.sendMessage(
          sendTarget,
          { text: replyText },
          { quoted: msg }
        )

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        console.log(`✅ Reply sent to ${sendTarget}`)
        pushLog(`Message sent successfully`)
        
        // Delay setelah send
        await new Promise(r => setTimeout(r, 3000))
        
      } catch (e) {
        pushLog(`Handler error: ${e.message}`)
        console.error('Message handler error:', e)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })
}

start().catch((e) => {
  console.error('Fatal start error:', e)
  pushLog(`Fatal: ${e.message}`)
  process.exit(1)
})
