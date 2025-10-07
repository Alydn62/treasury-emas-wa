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

// Price monitoring settings - 50 detik untuk hemat CPU
const PRICE_CHECK_INTERVAL = 50000 // 50 detik
let lastKnownPrice = null

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

function pushLog(s) {
  const logMsg = `${new Date().toISOString()} ${s}`
  logs.push(logMsg)
  console.log(logMsg)
  if (logs.length > 50) logs.splice(0, logs.length - 50)
}

// Cleanup memory setiap jam
setInterval(() => {
  if (processedMsgIds.size > 1000) {
    const idsArray = Array.from(processedMsgIds)
    const toKeep = idsArray.slice(-500)
    processedMsgIds.clear()
    toKeep.forEach(id => processedMsgIds.add(id))
  }
}, 60 * 60 * 1000)

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

async function fetchUSDIDRFallback() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: AbortSignal.timeout(5000) // 5 detik timeout
    })
    if (res.ok) {
      const json = await res.json()
      const rate = json.rates?.IDR || 0
      
      if (rate > 1000 && rate < 50000) {
        return { rate, change: 0, changePercent: 0 }
      }
    }
  } catch (e) {
    console.error('Fallback API error:', e.message)
  }
  
  return { rate: 15750, change: 0, changePercent: 0 }
}

async function fetchUSDIDRFromGoogle() {
  try {
    const res = await fetch('https://www.google.com/finance/quote/USD-IDR', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: AbortSignal.timeout(5000) // 5 detik timeout
    })
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    
    const html = await res.text()
    
    let rateMatch = html.match(/class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i)
    if (!rateMatch) rateMatch = html.match(/data-last-price="([0-9,\.]+)"/i)
    if (!rateMatch) rateMatch = html.match(/class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i)
    
    if (rateMatch && rateMatch[1]) {
      const rate = parseFloat(rateMatch[1].replace(/,/g, ''))
      
      if (rate > 1000 && rate < 50000) {
        let change = 0
        let changePercent = 0
        
        const changeMatch = html.match(/class="[^"]*P2Luy[^"]*"[^>]*>\s*([+-]?[\d,\.]+)\s*\(([+-]?[\d,\.]+)%\)/i)
        if (changeMatch) {
          change = parseFloat(changeMatch[1].replace(/,/g, ''))
          changePercent = parseFloat(changeMatch[2].replace(/,/g, ''))
        }
        
        return { rate, change, changePercent }
      }
    }
    
    throw new Error('Parse failed')
  } catch (e) {
    return await fetchUSDIDRFallback()
  }
}

// FORMAT MESSAGE dengan indikator naik/turun
function formatMessage(treasuryData, usdIdrData, priceChange = null) {
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
  
  // Indikator perubahan harga
  let priceIndicator = ''
  if (priceChange) {
    if (priceChange.buyChange > 0 || priceChange.sellChange > 0) {
      priceIndicator = ' 📈'
    } else if (priceChange.buyChange < 0 || priceChange.sellChange < 0) {
      priceIndicator = ' 📉'
    }
  }
  
  return `💎 *HARGA EMAS TREASURY* 💎${priceIndicator}
⏰ ${timeStr} WIB

┏━━━━━━━━━━━━━━━━━━━
┣ 📊 *Beli:* Rp${formatRupiah(buy)}/gr
┣ 📊 *Jual:* Rp${formatRupiah(sell)}/gr
┣ 📉 *Spread:* Rp${formatRupiah(spread)} (${spreadPercent}%)
┗━━━━━━━━━━━━━━━━━━━

💵 *USD/IDR:* Rp${formatRupiah(Math.round(usdIdrRate))} ${usdIdrSign}${Math.abs(usdIdrChangePercent).toFixed(2)}% ${usdIdrEmoji}

${generateDiscountSimulation(buy, sell)}

⚡ _Update otomatis saat harga berubah_`
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
  try {
    const res = await fetch(TREASURY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000) // 5 detik timeout
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
      throw new Error('Invalid data')
    }
    return json
  } catch (e) {
    throw e
  }
}

// ------ SUBSCRIPTION BROADCAST ------
async function broadcastToSubscribers(priceChange = null) {
  const now = new Date()
  const timeStr = `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`
  
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  console.log(`🔔 BROADCAST TRIGGERED at ${timeStr}`)
  console.log(`📊 Subscribers: ${subscriptions.size}`)
  
  if (priceChange) {
    console.log(`📈 Buy: ${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)}`)
    console.log(`📈 Sell: ${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)}`)
  }
  
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)

  if (!sock || !isReady || subscriptions.size === 0) {
    console.log('❌ Broadcast skipped')
    return
  }

  try {
    const [treasury, usdIdr] = await Promise.all([
      fetchTreasury(),
      fetchUSDIDRFromGoogle()
    ])
    
    const message = formatMessage(treasury, usdIdr, priceChange)
    
    let successCount = 0
    
    for (const chatId of subscriptions) {
      try {
        await sock.sendMessage(chatId, { text: message })
        successCount++
        await new Promise(r => setTimeout(r, 2000))
      } catch (e) {
        console.log(`❌ Failed: ${chatId.substring(0, 20)}`)
      }
    }
    
    console.log(`✅ Broadcast: ${successCount}/${subscriptions.size}\n`)
    
  } catch (e) {
    console.error('❌ Broadcast error:', e.message)
  }
}

// ------ PRICE MONITORING (50 detik) ------
async function checkPriceUpdate() {
  if (!isReady || subscriptions.size === 0) {
    return
  }

  try {
    const treasuryData = await fetchTreasury()
    const currentPrice = {
      buy: treasuryData?.data?.buying_rate,
      sell: treasuryData?.data?.selling_rate,
      updated_at: treasuryData?.data?.updated_at
    }

    // Cek perubahan harga
    if (!lastKnownPrice) {
      console.log('📊 First price check')
      lastKnownPrice = currentPrice
    } else if (
      lastKnownPrice.buy !== currentPrice.buy || 
      lastKnownPrice.sell !== currentPrice.sell ||
      lastKnownPrice.updated_at !== currentPrice.updated_at
    ) {
      // HARGA BERUBAH!
      const priceChange = {
        buyChange: currentPrice.buy - lastKnownPrice.buy,
        sellChange: currentPrice.sell - lastKnownPrice.sell
      }
      
      console.log('\n🔔 PRICE CHANGED!')
      console.log(`Buy: ${formatRupiah(lastKnownPrice.buy)} → ${formatRupiah(currentPrice.buy)} (${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)})`)
      console.log(`Sell: ${formatRupiah(lastKnownPrice.sell)} → ${formatRupiah(currentPrice.sell)} (${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)})`)
      
      pushLog(`Price changed: Buy ${priceChange.buyChange > 0 ? '↑' : '↓'} Sell ${priceChange.sellChange > 0 ? '↑' : '↓'}`)
      
      lastKnownPrice = currentPrice
      
      // Trigger broadcast
      await broadcastToSubscribers(priceChange)
    } else {
      console.log('✓ No change')
    }
  } catch (e) {
    console.error('❌ Price check error:', e.message)
  }
}

// Start monitoring setiap 50 detik
setInterval(checkPriceUpdate, PRICE_CHECK_INTERVAL)
console.log(`✅ Price monitoring: every ${PRICE_CHECK_INTERVAL/1000}s`)

// ------ EXPRESS ------
const app = express()
app.use(express.json())

app.get('/', (_req, res) => {
  res.send('✅ Bot Running')
})

app.get('/qr', async (_req, res) => {
  if (!lastQr) {
    return res.send('<pre>QR belum siap\n\n✅ Bot running</pre>')
  }

  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.send(`<div style="text-align:center;padding:20px"><h2>📱 Scan QR</h2><img src="${dataUrl}" style="max-width:400px"/></div>`)
    }
  } catch (_) {}
  res.send(lastQr)
})

app.get('/stats', (_req, res) => {
  res.json({
    status: isReady ? '🟢 Online' : '🔴 Warming',
    uptime: Math.floor(process.uptime()),
    subscribers: subscriptions.size,
    lastPrice: lastKnownPrice ? {
      buy: formatRupiah(lastKnownPrice.buy),
      sell: formatRupiah(lastKnownPrice.sell),
      updated: lastKnownPrice.updated_at
    } : null,
    checkInterval: `${PRICE_CHECK_INTERVAL/1000}s`,
    logs: logs.slice(-10)
  })
})

app.get('/broadcast-now', async (_req, res) => {
  await broadcastToSubscribers()
  res.json({ ok: true })
})

app.get('/check-price', async (_req, res) => {
  await checkPriceUpdate()
  res.json({ ok: true, lastPrice: lastKnownPrice })
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

app.listen(PORT, () => {
  console.log(`\n🌐 Server: http://localhost:${PORT}`)
  console.log(`📊 Stats: /stats`)
  console.log(`🔴 Broadcast: /broadcast-now`)
  console.log(`🔍 Check: /check-price\n`)
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
    getMessage: async () => ({ conversation: '' })
  })

  setInterval(() => {
    if (sock?.ws?.readyState === 1) sock.ws.ping()
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    
    if (qr) {
      lastQr = qr
      console.log('📲 QR ready')
      pushLog('QR ready')
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      console.log(`❌ Closed: ${reason}`)
      
      if (reason === DisconnectReason.loggedOut) {
        console.log('⚠️  LOGGED OUT')
        lastQr = null
        return
      }
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        console.log(`🔄 Reconnect in ${Math.round(delay/1000)}s`)
        setTimeout(() => start(), delay)
      }
      
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      console.log('✅ Connected')
      
      isReady = false
      console.log('⏳ Warmup 20s')
      
      setTimeout(() => {
        isReady = true
        console.log('🟢 Ready!')
        checkPriceUpdate()
      }, 20000)
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async (ev) => {
    if (!isReady || ev.type !== 'notify') return
    
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
        
        // langganan
        if (/\blangganan\b|\bsubscribe\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '✅ Sudah berlangganan!\n\n📢 Update otomatis saat harga berubah.\n\n_Ketik "berhenti" untuk stop._'
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            console.log(`➕ New: ${sendTarget.substring(0, 20)} (${isGroup ? 'GROUP' : 'DM'})`)
            
            await sock.sendMessage(sendTarget, {
              text: '🎉 *Langganan Berhasil!*\n\n📢 Update otomatis saat harga berubah (cek setiap 50 detik).\n\n_Ketik "berhenti" untuk stop._'
            }, { quoted: msg })
          }
          continue
        }
        
        // berhenti
        if (/\bberhenti\b|\bunsubscribe\b|\bstop\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            console.log(`➖ Unsub: ${sendTarget.substring(0, 20)}`)
            
            await sock.sendMessage(sendTarget, {
              text: '👋 Langganan dihentikan.\n\n_Ketik "langganan" untuk mulai lagi._'
            }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, {
              text: '❌ Belum berlangganan.\n\n_Ketik "langganan" untuk mulai._'
            }, { quoted: msg })
          }
          continue
        }
        
        // emas
        if (!/\bemas\b/.test(text)) continue

        const now = Date.now()
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        
        if (now - lastReply < COOLDOWN_PER_CHAT) {
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
          replyText = '❌ Gagal mengambil data.\n⏱️ Coba lagi.'
        }

        const randomDelay = Math.floor(Math.random() * (RANDOM_DELAY_MAX - RANDOM_DELAY_MIN)) + RANDOM_DELAY_MIN
        await new Promise(r => setTimeout(r, randomDelay))
        
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (_) {}
        
        await sock.sendMessage(sendTarget, { text: replyText }, { quoted: msg })

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        console.log(`✅ Sent`)
        await new Promise(r => setTimeout(r, 2000))
        
      } catch (e) {
        console.error('Error:', e.message)
      }
    }
  })
}

start().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
