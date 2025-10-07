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

// Reconnect settings
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 10
const BASE_RECONNECT_DELAY = 5000

// ------ STATE ------
let lastQr = null
const logs = []
const processedMsgIds = new Set()
const lastReplyAtPerChat = new Map()
let lastGlobalReplyAt = 0
let isReady = false
let sock = null

// Subscription state
const subscriptions = new Set()
let lastBroadcastMinute = -1

function pushLog(s) {
  const logMsg = `${new Date().toISOString()} ${s}`
  logs.push(logMsg)
  console.log(logMsg)
  if (logs.length > 100) logs.splice(0, logs.length - 100)
}

setInterval(() => {
  if (processedMsgIds.size > 2000) {
    const idsArray = Array.from(processedMsgIds)
    const toKeep = idsArray.slice(-1000)
    processedMsgIds.clear()
    toKeep.forEach(id => processedMsgIds.add(id))
  }
}, 30 * 60 * 1000)

// ------ UTIL ------
function normalizeText(msg) {
  if (!msg) return ''
  return msg.replace(/\s+/g, ' ').trim().toLowerCase()
}

function isGroupMessage(m) {
  return m.key.remoteJid?.endsWith('@g.us')
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

// PERBAIKAN: Fallback API jika Google Finance gagal
async function fetchUSDIDRFallback() {
  try {
    console.log('🔄 Trying fallback API: ExchangeRate-API...')
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    if (res.ok) {
      const json = await res.json()
      const rate = json.rates?.IDR || 0
      
      if (rate > 1000 && rate < 50000) {
        console.log(`✅ Fallback API success: ${rate}`)
        pushLog(`Fallback API: USD/IDR = ${rate}`)
        return {
          rate,
          change: 0,
          changePercent: 0
        }
      }
    }
  } catch (e) {
    console.error('❌ Fallback API error:', e.message)
  }
  
  // Ultimate fallback
  console.log('⚠️  Using manual fallback')
  pushLog('Using manual fallback for USD/IDR')
  return { 
    rate: 15750, 
    change: 0, 
    changePercent: 0 
  }
}

// PERBAIKAN: Scraping Google Finance dengan multiple patterns
async function fetchUSDIDRFromGoogle() {
  try {
    const url = 'https://www.google.com/finance/quote/USD-IDR'
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      }
    })
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    
    const html = await res.text()
    console.log('📄 Google Finance HTML length:', html.length)
    
    let rateMatch = null
    
    // Pattern 1: YMlKec fxKbKc (paling umum)
    rateMatch = html.match(/class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i)
    if (rateMatch) console.log('✓ Pattern 1 matched')
    
    // Pattern 2: data-last-price
    if (!rateMatch) {
      rateMatch = html.match(/data-last-price="([0-9,\.]+)"/i)
      if (rateMatch) console.log('✓ Pattern 2 matched')
    }
    
    // Pattern 3: data-source-price
    if (!rateMatch) {
      rateMatch = html.match(/data-source-price="([0-9,\.]+)"/i)
      if (rateMatch) console.log('✓ Pattern 3 matched')
    }
    
    // Pattern 4: Cari angka setelah USD/IDR
    if (!rateMatch) {
      rateMatch = html.match(/USD[\s\/]*to[\s]*IDR[^\d]+([\d,\.]+)/i)
      if (rateMatch) console.log('✓ Pattern 4 matched')
    }
    
    // Pattern 5: JSON-LD structured data
    if (!rateMatch) {
      const jsonMatch = html.match(/"price"\s*:\s*"?([0-9,\.]+)"?/i)
      if (jsonMatch) {
        rateMatch = jsonMatch
        console.log('✓ Pattern 5 matched')
      }
    }
    
    // Pattern 6: class fxKbKc tanpa YMlKec
    if (!rateMatch) {
      rateMatch = html.match(/class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i)
      if (rateMatch) console.log('✓ Pattern 6 matched')
    }
    
    // Pattern 7: Cari di script tag dengan window variables
    if (!rateMatch) {
      const scriptMatch = html.match(/window\[['"]ds:[\d]+['"]\]\s*=\s*.*?"([0-9,\.]+)"/i)
      if (scriptMatch) {
        rateMatch = scriptMatch
        console.log('✓ Pattern 7 matched')
      }
    }
    
    if (rateMatch && rateMatch[1]) {
      const rateStr = rateMatch[1].replace(/,/g, '')
      const rate = parseFloat(rateStr)
      
      console.log(`💵 Parsed rate: ${rate}`)
      
      // Sanity check
      if (rate > 1000 && rate < 50000) {
        // Extract perubahan harga
        let change = 0
        let changePercent = 0
        
        const changePatterns = [
          /class="[^"]*P2Luy[^"]*"[^>]*>\s*([+-]?[\d,\.]+)\s*\(([+-]?[\d,\.]+)%\)/i,
          /class="[^"]*enJeMd[^"]*"[^>]*>\s*([+-]?[\d,\.]+)\s*\(([+-]?[\d,\.]+)%\)/i,
          /"change"\s*:\s*"?([+-]?[\d,\.]+)"?/i
        ]
        
        for (const pattern of changePatterns) {
          const changeMatch = html.match(pattern)
          if (changeMatch) {
            change = parseFloat(changeMatch[1].replace(/,/g, ''))
            if (changeMatch[2]) {
              changePercent = parseFloat(changeMatch[2].replace(/,/g, ''))
            }
            console.log(`📊 Change found: ${change} (${changePercent}%)`)
            break
          }
        }
        
        pushLog(`Google Finance: USD/IDR = ${rate}`)
        
        return { 
          rate, 
          change, 
          changePercent 
        }
      } else {
        console.log(`❌ Rate out of range: ${rate}`)
      }
    }
    
    throw new Error('Failed to parse USD/IDR from HTML')
    
  } catch (e) {
    console.error('❌ Google Finance error:', e.message)
    pushLog(`Google Finance error: ${e.message}`)
    
    // Fallback
    return await fetchUSDIDRFallback()
  }
}

function formatMessage(treasuryData, usdIdrData) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0
  const updated = treasuryData?.data?.updated_at || new Date().toISOString()
  
  const timeStr = updated.split('T')[1]?.substring(0, 5) || ''
  
  const usdIdrRate = usdIdrData.rate
  const usdIdrChange = usdIdrData.change
  const usdIdrChangePercent = usdIdrData.changePercent
  const usdIdrEmoji = usdIdrChange >= 0 ? '📈' : '📉'
  const usdIdrSign = usdIdrChange >= 0 ? '+' : ''
  
  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)
  
  return `💎 *HARGA EMAS TREASURY* 💎
⏰ ${timeStr} WIB

┏━━━━━━━━━━━━━━━━━━━
┣ 📊 *Beli:* Rp${formatRupiah(buy)}/gr
┣ 📊 *Jual:* Rp${formatRupiah(sell)}/gr
┣ 📉 *Spread:* Rp${formatRupiah(spread)} (${spreadPercent}%)
┗━━━━━━━━━━━━━━━━━━━

💵 *USD/IDR:* Rp${formatRupiah(Math.round(usdIdrRate))} ${usdIdrSign}${Math.abs(usdIdrChangePercent).toFixed(2)}% ${usdIdrEmoji}

${generateDiscountSimulation(buy, sell)}

⚡ _Reply max 1x/menit • Data real-time_`
}

function generateDiscountSimulation(buy, sell) {
  const amounts = [
    { value: 20000000, label: '20 Juta' },
    { value: 30000000, label: '30 Juta' }
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
    
    return `🎁 *${label}*
├ Bayar: Rp${formatRupiah(Math.round(calc.discountedPrice))}
├ Dapat: ${calc.totalGrams.toFixed(4)} gram
└ Profit: ${profitSign}Rp${formatRupiah(Math.round(calc.profit))} ${emoji}`
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

// ------ SUBSCRIPTION BROADCAST ------
async function broadcastToSubscribers() {
  const now = new Date()
  const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`🔔 BROADCAST TRIGGERED at ${timeStr}`)
  console.log(`📊 Status: isReady=${isReady}, sock=${!!sock}, subscribers=${subscriptions.size}`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  if (!sock) {
    console.log('❌ Socket not initialized')
    return
  }

  if (!isReady) {
    console.log('❌ Bot not ready yet')
    return
  }

  if (subscriptions.size === 0) {
    console.log('❌ No subscribers')
    return
  }

  console.log(`📢 Broadcasting to ${subscriptions.size} subscriber(s)...`)

  try {
    console.log('📥 Fetching data...')
    const [treasury, usdIdr] = await Promise.all([
      fetchTreasury(),
      fetchUSDIDRFromGoogle()
    ])
    
    const message = formatMessage(treasury, usdIdr)
    console.log('✅ Data fetched successfully')
    
    let successCount = 0
    let failCount = 0
    
    for (const chatId of subscriptions) {
      try {
        console.log(`📤 Sending to ${chatId}...`)
        await sock.sendMessage(chatId, { text: message })
        successCount++
        console.log(`✅ Sent to ${chatId}`)
        
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        failCount++
        console.log(`❌ Failed to send to ${chatId}: ${e.message}`)
      }
    }
    
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    console.log(`📊 Broadcast complete: ${successCount} success, ${failCount} failed`)
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
    
  } catch (e) {
    console.error('❌ Broadcast error:', e)
  }
}

// Broadcast scheduler
setInterval(() => {
  const now = new Date()
  const currentMinute = now.getMinutes()
  const currentSecond = now.getSeconds()
  
  if (currentSecond === 1 && currentMinute !== lastBroadcastMinute) {
    lastBroadcastMinute = currentMinute
    broadcastToSubscribers()
  }
}, 1000)

console.log('✅ Broadcast scheduler started (every minute at :01 seconds)')

// ------ EXPRESS ------
const app = express()
app.use(express.json())

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
    totalSubscribers: subscriptions.size,
    subscribers: Array.from(subscriptions).map(id => ({
      id: id.substring(0, 25) + '...',
      type: id.endsWith('@g.us') ? 'GROUP' : 'DM'
    })),
    processedMessages: processedMsgIds.size,
    reconnectAttempts,
    lastBroadcastMinute,
    activeChats: Array.from(lastReplyAtPerChat.entries())
      .slice(-10)
      .map(([chat, lastTime]) => ({
        chat: chat.substring(0, 25) + '...',
        type: chat.endsWith('@g.us') ? 'GROUP' : 'DM',
        lastReply: new Date(lastTime).toISOString(),
        cooldown: Math.max(0, Math.round((COOLDOWN_PER_CHAT - (Date.now() - lastTime)) / 1000)) + 's'
      })),
    recentLogs: logs.slice(-20)
  }
  res.json(stats)
})

app.get('/subscribers', (_req, res) => {
  res.json({
    total: subscriptions.size,
    subscribers: Array.from(subscriptions)
  })
})

app.post('/subscribe', (req, res) => {
  const { chatId } = req.body
  if (!chatId) {
    return res.status(400).json({ error: 'chatId required' })
  }
  subscriptions.add(chatId)
  pushLog(`Manual subscribe: ${chatId}`)
  res.json({ success: true, total: subscriptions.size })
})

app.post('/unsubscribe', (req, res) => {
  const { chatId } = req.body
  if (!chatId) {
    return res.status(400).json({ error: 'chatId required' })
  }
  subscriptions.delete(chatId)
  pushLog(`Manual unsubscribe: ${chatId}`)
  res.json({ success: true, total: subscriptions.size })
})

app.get('/broadcast-now', async (_req, res) => {
  console.log('\n🔴 Manual broadcast triggered via API')
  await broadcastToSubscribers()
  res.json({ 
    success: true, 
    subscribers: subscriptions.size,
    message: 'Broadcast triggered'
  })
})

app.get('/test', async (_req, res) => {
  try {
    const [treasury, usdIdr] = await Promise.all([
      fetchTreasury(),
      fetchUSDIDRFromGoogle()
    ])
    
    const message = formatMessage(treasury, usdIdr)
    res.type('text/plain').send(message)
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`)
  }
})

// ENDPOINT BARU: Test USD/IDR
app.get('/test-usd', async (_req, res) => {
  try {
    console.log('\n🧪 Testing USD/IDR fetch...')
    const usdIdr = await fetchUSDIDRFromGoogle()
    res.json({
      success: true,
      data: usdIdr,
      timestamp: new Date().toISOString()
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    })
  }
})

// ENDPOINT BARU: Debug Google Finance
app.get('/debug-google', async (_req, res) => {
  try {
    const url = 'https://www.google.com/finance/quote/USD-IDR'
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    })
    const html = await response.text()
    
    // Cari semua angka yang mirip 15xxx - 16xxx
    const possibleRates = html.match(/1[45][0-9]{3}[,\.]?[0-9]*/g)
    
    res.type('text/html').send(`
      <h2>Debug Google Finance</h2>
      <h3>Status: ${response.status}</h3>
      <h3>HTML Length: ${html.length}</h3>
      <h3>Possible Rates Found:</h3>
      <pre>${JSON.stringify(possibleRates?.slice(0, 20), null, 2)}</pre>
      <h3>HTML Preview (first 5000 chars):</h3>
      <textarea style="width:100%; height:400px">${html.substring(0, 5000)}</textarea>
    `)
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`)
  }
})

app.listen(PORT, () => {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`🌐 Server running on port ${PORT}`)
  console.log(`📊 Stats: http://localhost:${PORT}/stats`)
  console.log(`👥 Subscribers: http://localhost:${PORT}/subscribers`)
  console.log(`🔴 Broadcast Now: http://localhost:${PORT}/broadcast-now`)
  console.log(`🧪 Test Message: http://localhost:${PORT}/test`)
  console.log(`💵 Test USD/IDR: http://localhost:${PORT}/test-usd`)
  console.log(`🔍 Debug Google: http://localhost:${PORT}/debug-google`)
  console.log(`📱 QR: http://localhost:${PORT}/qr`)
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
})

// ------ WHATSAPP ------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  const logger = pino({ level: 'silent' })

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    generateHighQualityLinkPreview: false,
    getMessage: async (key) => {
      return { conversation: '' }
    }
  })

  setInterval(() => {
    if (sock && sock.ws && sock.ws.readyState === 1) {
      sock.ws.ping()
    }
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    
    if (qr) {
      lastQr = qr
      console.log('📲 QR ready - Open /qr')
      pushLog('QR generated')
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log(`❌ Connection closed: ${reason}`)
      pushLog(`Closed: ${reason}`)
      
      if (reason === DisconnectReason.loggedOut) {
        console.log('⚠️  LOGGED OUT - Scan QR at /qr')
        pushLog('LOGGED OUT')
        lastQr = null
        reconnectAttempts = 0
        return
      }
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        console.log(`🔄 Reconnecting in ${Math.round(delay/1000)}s (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        pushLog(`Reconnect attempt ${reconnectAttempts}`)
        
        setTimeout(() => {
          console.log('🔄 Attempting reconnect...')
          start()
        }, delay)
      } else {
        console.log('❌ Max reconnect attempts')
        pushLog('Max reconnect')
        process.exit(1)
      }
      
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      console.log('✅ Connected!')
      pushLog('Connected')
      
      isReady = false
      console.log('⏳ Warmup 20s...')
      
      setTimeout(() => {
        isReady = true
        console.log('🟢 Ready!')
        console.log(`📊 Subscribers: ${subscriptions.size}`)
        pushLog('Bot ready')
      }, 20000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady) return
    if (ev.type !== 'notify') return
    
    for (const msg of ev.messages) {
      try {
        if (shouldIgnoreMessage(msg)) continue

        const stanzaId = msg.key.id
        if (processedMsgIds.has(stanzaId)) continue
        processedMsgIds.add(stanzaId)

        const text = normalizeText(extractText(msg))
        if (!text) continue

        const sendTarget = msg.key.remoteJid
        const isGroup = isGroupMessage(msg)
        
        // Command: langganan
        if (/\blangganan\b|\bsubscribe\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '✅ Anda sudah berlangganan!\n\n📢 Anda akan menerima update harga emas otomatis setiap menit.\n\n_Ketik "berhenti" untuk berhenti langganan._'
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            console.log(`➕ New subscriber: ${sendTarget} (${isGroup ? 'GROUP' : 'DM'})`)
            pushLog(`New subscriber: ${sendTarget}`)
            
            await sock.sendMessage(sendTarget, {
              text: '🎉 *Langganan Berhasil!*\n\n📢 Anda akan menerima update harga emas otomatis setiap menit di detik ke-01.\n\n_Ketik "berhenti" untuk berhenti langganan._'
            }, { quoted: msg })
          }
          continue
        }
        
if (/\bberhenti\b|\bunsubscribe\b|\bstop\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            console.log(`➖ Unsubscribed: ${sendTarget}`)
            pushLog(`Unsubscribed: ${sendTarget}`)
            
            await sock.sendMessage(sendTarget, {
              text: '👋 Langganan dihentikan.\n\n_Ketik "langganan" untuk berlangganan kembali._'
            }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, {
              text: '❌ Anda belum berlangganan.\n\n_Ketik "langganan" untuk mulai berlangganan._'
            }, { quoted: msg })
          }
          continue
        }
        
        // Trigger: emas
        if (!/\bemas\b/.test(text)) continue

        const now = Date.now()
        
        console.log(`📨 Message from: ${isGroup ? 'GROUP' : 'DM'} | ${sendTarget}`)
        
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        const timeSinceLastReply = now - lastReply
        
        if (timeSinceLastReply < COOLDOWN_PER_CHAT) {
          const remaining = Math.ceil((COOLDOWN_PER_CHAT - timeSinceLastReply) / 1000)
          console.log(`⏳ Cooldown: ${remaining}s`)
          continue
        }
        
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) {
          continue
        }

        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
        } catch (_) {}
        
        await new Promise(r => setTimeout(r, TYPING_DURATION))

        let replyText
        try {
          const [treasury, usdIdr] = await Promise.all([
            fetchTreasury(),
            fetchUSDIDRFromGoogle()
          ])
          
          replyText = formatMessage(treasury, usdIdr)
        } catch (e) {
          replyText = '❌ Gagal mengambil data.\n⏱️ Coba lagi nanti.'
          pushLog(`Error: ${e.message}`)
        }

        const randomDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN)) + RANDOM_DELAY_MIN
        await new Promise(r => setTimeout(r, randomDelay))
        
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (_) {}
        
        await sock.sendMessage(
          sendTarget,
          { text: replyText },
          { quoted: msg }
        )

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        console.log(`✅ Sent`)
        
        await new Promise(r => setTimeout(r, 2000))
        
      } catch (e) {
        console.error('Error:', e)
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  })
}

start().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
