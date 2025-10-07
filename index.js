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
const TYPING_DURATION = 2000

// REAL-TIME dengan DEBOUNCE & MIN CHANGE
const PRICE_CHECK_INTERVAL = 2000
const DEBOUNCE_TIME = 5000
const MIN_PRICE_CHANGE = 50
const MIN_BROADCAST_INTERVAL = 10000

// Konversi troy ounce ke gram
const TROY_OZ_TO_GRAM = 31.1034768

// Threshold untuk harga normal/abnormal
const NORMAL_THRESHOLD = 2000
const NORMAL_LOW_THRESHOLD = 1000

let lastKnownPrice = null
let lastBroadcastedPrice = null
let lastBroadcastTime = 0
let isBroadcasting = false
let pendingBroadcast = null
let latestPriceChange = null
let broadcastCount = 0

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

const subscriptions = new Set()

function pushLog(s) {
  const logMsg = `${new Date().toISOString().substring(11, 19)} ${s}`
  logs.push(logMsg)
  if (logs.length > 30) logs.shift()
  console.log(logMsg)
}

setInterval(() => {
  if (processedMsgIds.size > 300) {
    const arr = Array.from(processedMsgIds).slice(-200)
    processedMsgIds.clear()
    arr.forEach(id => processedMsgIds.add(id))
  }
}, 5 * 60 * 1000)

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
  const discountAmount = calculateDiscount(investmentAmount)
  const discountedPrice = investmentAmount - discountAmount
  const totalGrams = investmentAmount / buyRate
  const sellValue = totalGrams * sellRate
  const totalProfit = sellValue - discountedPrice
  
  return {
    discountedPrice,
    totalGrams,
    profit: totalProfit
  }
}

async function fetchUSDIDRFallback() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) {
      const json = await res.json()
      return { rate: json.rates?.IDR || 15750 }
    }
  } catch (_) {}
  return { rate: 15750 }
}

async function fetchUSDIDRFromGoogle() {
  try {
    const res = await fetch('https://www.google.com/finance/quote/USD-IDR', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3000)
    })
    
    if (!res.ok) return await fetchUSDIDRFallback()
    
    const html = await res.text()
    let rateMatch = html.match(/class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i)
    if (!rateMatch) rateMatch = html.match(/class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i)
    
    if (rateMatch?.[1]) {
      const rate = parseFloat(rateMatch[1].replace(/,/g, ''))
      if (rate > 1000 && rate < 50000) {
        return { rate }
      }
    }
  } catch (_) {}
  return await fetchUSDIDRFallback()
}

async function fetchXAUUSDFromTradingView() {
  try {
    const res = await fetch('https://scanner.tradingview.com/symbol', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: JSON.stringify({
        symbols: {
          tickers: ['OANDA:XAUUSD'],
          query: { types: [] }
        },
        columns: ['close']
      }),
      signal: AbortSignal.timeout(5000)
    })
    
    if (res.ok) {
      const json = await res.json()
      if (json?.data?.[0]?.d) {
        const price = json.data[0].d[0]
        
        if (price > 1000 && price < 10000) {
          console.log(`✅ XAU/USD from TradingView: $${price.toFixed(2)}`)
          return price
        }
      }
    }
  } catch (e) {
    console.log('TradingView fetch error:', e.message)
  }
  return null
}

async function fetchXAUUSDFromInvesting() {
  try {
    const res = await fetch('https://www.investing.com/currencies/xau-usd', {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      signal: AbortSignal.timeout(5000)
    })
    
    if (res.ok) {
      const html = await res.text()
      
      let priceMatch = html.match(/data-test="instrument-price-last"[^>]*>([0-9,\.]+)</i)
      if (!priceMatch) {
        priceMatch = html.match(/([0-9]{1},[0-9]{3}\.[0-9]{2})\s*<\/span>/i)
      }
      if (!priceMatch) {
        priceMatch = html.match(/"last[Pp]rice"[^>]*>([0-9,\.]+)</i)
      }
      
      if (priceMatch?.[1]) {
        const price = parseFloat(priceMatch[1].replace(/,/g, ''))
        
        if (price > 1000 && price < 10000) {
          console.log(`✅ XAU/USD from Investing.com: $${price.toFixed(2)}`)
          return price
        }
      }
    }
  } catch (e) {
    console.log('Investing.com fetch error:', e.message)
  }
  return null
}

async function fetchXAUUSDFromGoogle() {
  try {
    const res = await fetch('https://www.google.com/finance/quote/XAU-USD', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(3000)
    })
    
    if (res.ok) {
      const html = await res.text()
      let priceMatch = html.match(/class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i)
      if (!priceMatch) priceMatch = html.match(/class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i)
      
      if (priceMatch?.[1]) {
        const price = parseFloat(priceMatch[1].replace(/,/g, ''))
        if (price > 1000 && price < 10000) {
          console.log(`✅ XAU/USD from Google Finance: $${price.toFixed(2)}`)
          return price
        }
      }
    }
  } catch (e) {
    console.log('Google Finance fetch error:', e.message)
  }
  return null
}

async function fetchXAUUSD() {
  let result = await fetchXAUUSDFromTradingView()
  if (result) return result
  
  result = await fetchXAUUSDFromInvesting()
  if (result) return result
  
  result = await fetchXAUUSDFromGoogle()
  if (result) return result
  
  console.log('⚠️  All XAU/USD sources failed')
  return null
}

function analyzePriceStatus(treasuryBuy, treasurySell, xauUsdPrice, usdIdrRate) {
  if (!xauUsdPrice) {
    return {
      status: 'DATA_INCOMPLETE',
      message: '⚠️ Data XAU/USD tidak tersedia'
    }
  }
  
  // Hitung harga emas internasional dalam Rupiah per gram
  const internationalPricePerGram = (xauUsdPrice / TROY_OZ_TO_GRAM) * usdIdrRate
  
  // Selisih harga jual Treasury dengan harga internasional
  const difference = treasurySell - internationalPricePerGram
  const differencePercent = ((difference / internationalPricePerGram) * 100).toFixed(2)
  
  let status = 'NORMAL'
  let emoji = '✅'
  let message = ''
  
  if (Math.abs(difference) <= NORMAL_LOW_THRESHOLD) {
    status = 'NORMAL'
    emoji = '✅'
    message = `HARGA NORMAL ✅`
  } else if (Math.abs(difference) <= NORMAL_THRESHOLD) {
    status = 'NORMAL'
    emoji = '✅'
    message = `HARGA NORMAL ✅`
  } else {
    status = 'ABNORMAL'
    emoji = '⚠️'
    const selisihText = difference > 0 
      ? `+${formatRupiah(Math.round(Math.abs(difference)))}` 
      : `-${formatRupiah(Math.round(Math.abs(difference)))}`
    message = `ABNORMAL ⚠️\nSELISIH HARGA JUAL - HARGA JUAL TREASURY = ${selisihText}\n📊 = dari data sebelumnya`
  }
  
  return {
    status,
    emoji,
    message,
    internationalPrice: internationalPricePerGram,
    difference,
    differencePercent
  }
}

function formatMessage(treasuryData, usdIdrRate, xauUsdPrice = null, priceChange = null) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0
  
  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)
  
  // Waktu update dari API (WIB/Jakarta)
  const updatedAt = treasuryData?.data?.updated_at
  let timeSection = ''
  if (updatedAt) {
    const date = new Date(updatedAt)
    // Format: HH:MM:SS WIB
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    timeSection = `🕐 *Update: ${hours}:${minutes}:${seconds} WIB*\n`
  }
  
  // Header untuk naik/turun
  let headerSection = ''
  if (priceChange && priceChange.buyChange !== 0) {
    if (priceChange.buyChange > 0) {
      headerSection = '*HARGA NAIK 🚀 🚀 🚀 🚀*\n'
    } else {
      headerSection = '*HARGA TURUN 🔻 🔻 🔻 🔻*\n'
    }
  }
  
  let statusSection = ''
  
  if (xauUsdPrice && usdIdrRate) {
    const analysis = analyzePriceStatus(buy, sell, xauUsdPrice, usdIdrRate)
    statusSection = `${analysis.emoji} *${analysis.message}*\n`
  }
  
  // Format harga
  const buyFormatted = `Rp${formatRupiah(buy)}/gr`
  const sellFormatted = `Rp${formatRupiah(sell)}/gr`
  const spreadFormatted = `Rp${formatRupiah(Math.abs(spread))} (-${spreadPercent}%)`
  
  // Kurs & Pasar section
  let marketSection = '💱 *Kurs & Pasar*\n'
  marketSection += `💵 USD/IDR: Rp${formatRupiah(Math.round(usdIdrRate))}\n`
  
  if (xauUsdPrice) {
    marketSection += `💰 XAU/USD: $${xauUsdPrice.toFixed(2)}/oz`
  }
  
  return `${headerSection}${timeSection}${statusSection}
📊 *Harga Beli:* ${buyFormatted}
📉 *Harga Jual:* ${sellFormatted}
💬 *Selisih:* ${spreadFormatted}

${marketSection}

🎁 *Promo*
💰 Rp20 Juta ➜ ${calculateProfit(buy, sell, 20000000).totalGrams.toFixed(2)} gr | Profit: +Rp${formatRupiah(Math.round(calculateProfit(buy, sell, 20000000).profit))} 🚀
💰 Rp30 Juta ➜ ${calculateProfit(buy, sell, 30000000).totalGrams.toFixed(2)} gr | Profit: +Rp${formatRupiah(Math.round(calculateProfit(buy, sell, 30000000).profit))} 🚀

⚡ _Harga diperbarui otomatis_`
}

async function fetchTreasury() {
  const res = await fetch(TREASURY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(3000)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.data?.buying_rate || !json?.data?.selling_rate) {
    throw new Error('Invalid data')
  }
  return json
}

async function doBroadcast(priceChange) {
  if (isBroadcasting) {
    pushLog('⏭️  Broadcast already in progress, skipping')
    return
  }

  const now = Date.now()
  if (now - lastBroadcastTime < MIN_BROADCAST_INTERVAL) {
    const remaining = Math.ceil((MIN_BROADCAST_INTERVAL - (now - lastBroadcastTime)) / 1000)
    pushLog(`⏭️  Too soon, wait ${remaining}s`)
    return
  }

  isBroadcasting = true
  broadcastCount++
  const currentBroadcastId = broadcastCount
  
  if (!sock || !isReady || subscriptions.size === 0) {
    isBroadcasting = false
    return
  }

  try {
    const [treasury, usdIdr, xauUsd] = await Promise.all([
      fetchTreasury(),
      fetchUSDIDRFromGoogle(),
      fetchXAUUSD()
    ])
    
    if (lastBroadcastedPrice && 
        lastBroadcastedPrice.buy === treasury?.data?.buying_rate &&
        lastBroadcastedPrice.sell === treasury?.data?.selling_rate) {
      pushLog(`⏭️  Price unchanged from last broadcast, skipping`)
      isBroadcasting = false
      return
    }
    
    lastBroadcastedPrice = {
      buy: treasury?.data?.buying_rate,
      sell: treasury?.data?.selling_rate
    }
    
    const message = formatMessage(treasury, usdIdr.rate, xauUsd, priceChange)
    
    pushLog(`📤 [#${currentBroadcastId}] Broadcasting to ${subscriptions.size} subs`)
    
    let successCount = 0
    let failCount = 0
    
    for (const chatId of subscriptions) {
      try {
        await sock.sendMessage(chatId, { text: message })
        successCount++
        await new Promise(r => setTimeout(r, 1000))
      } catch (e) {
        failCount++
        pushLog(`❌ Failed: ${chatId.substring(0, 15)}`)
      }
    }
    
    lastBroadcastTime = Date.now()
    pushLog(`✅ [#${currentBroadcastId}] Sent: ${successCount}, Failed: ${failCount}`)
    
  } catch (e) {
    pushLog(`❌ Broadcast error: ${e.message}`)
  }
  
  isBroadcasting = false
}

function scheduleBroadcast(priceChange) {
  if (pendingBroadcast) {
    clearTimeout(pendingBroadcast)
    pushLog('⏱️  Debounce reset (price still changing)')
  }
  
  latestPriceChange = priceChange
  
  pendingBroadcast = setTimeout(async () => {
    pushLog('✓ Price stabilized, broadcasting...')
    await doBroadcast(latestPriceChange)
    pendingBroadcast = null
    latestPriceChange = null
  }, DEBOUNCE_TIME)
}

async function checkPriceUpdate() {
  if (!isReady || subscriptions.size === 0) return

  try {
    const treasuryData = await fetchTreasury()
    const currentPrice = {
      buy: treasuryData?.data?.buying_rate,
      sell: treasuryData?.data?.selling_rate,
      updated_at: treasuryData?.data?.updated_at
    }

    if (!lastKnownPrice) {
      lastKnownPrice = currentPrice
      lastBroadcastedPrice = currentPrice
      pushLog(`📊 Initial: Buy=${formatRupiah(currentPrice.buy)}, Sell=${formatRupiah(currentPrice.sell)}`)
      return
    }
    
    const buyChanged = lastKnownPrice.buy !== currentPrice.buy
    const sellChanged = lastKnownPrice.sell !== currentPrice.sell
    const timestampChanged = lastKnownPrice.updated_at !== currentPrice.updated_at
    
    if (!buyChanged && !sellChanged && !timestampChanged) {
      return
    }
    
    const priceChange = {
      buyChange: currentPrice.buy - lastKnownPrice.buy,
      sellChange: currentPrice.sell - lastKnownPrice.sell
    }
    
    const buyChangeSinceBroadcast = Math.abs(currentPrice.buy - (lastBroadcastedPrice?.buy || currentPrice.buy))
    const sellChangeSinceBroadcast = Math.abs(currentPrice.sell - (lastBroadcastedPrice?.sell || currentPrice.sell))
    
    lastKnownPrice = currentPrice
    
    if (buyChangeSinceBroadcast < MIN_PRICE_CHANGE && sellChangeSinceBroadcast < MIN_PRICE_CHANGE) {
      const time = new Date().toISOString().substring(11, 19)
      const buyIcon = priceChange.buyChange > 0 ? '📈' : priceChange.buyChange < 0 ? '📉' : '➡️'
      const sellIcon = priceChange.sellChange > 0 ? '📈' : priceChange.sellChange < 0 ? '📉' : '➡️'
      pushLog(`⏭️  ${time} Change < Rp${MIN_PRICE_CHANGE} ${buyIcon}B:${priceChange.buyChange} ${sellIcon}S:${priceChange.sellChange} - SKIP`)
      return
    }
    
    const time = new Date().toISOString().substring(11, 19)
    const buyIcon = priceChange.buyChange > 0 ? '📈' : '📉'
    const sellIcon = priceChange.sellChange > 0 ? '📈' : '📉'
    
    pushLog(`\n🔔 ${time} PRICE CHANGE!`)
    pushLog(`${buyIcon} Buy: ${formatRupiah(lastKnownPrice.buy - priceChange.buyChange)} → ${formatRupiah(currentPrice.buy)} (${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)})`)
    pushLog(`${sellIcon} Sell: ${formatRupiah(lastKnownPrice.sell - priceChange.sellChange)} → ${formatRupiah(currentPrice.sell)} (${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)})`)
    
    scheduleBroadcast(priceChange)
    
  } catch (e) {
    // Silent fail
  }
}

setInterval(checkPriceUpdate, PRICE_CHECK_INTERVAL)
console.log(`✅ Real-time monitoring: every ${PRICE_CHECK_INTERVAL/1000}s`)
console.log(`⏱️  Debounce: ${DEBOUNCE_TIME/1000}s`)
console.log(`📊 Min change: ±Rp${MIN_PRICE_CHANGE}`)
console.log(`⏰ Min broadcast interval: ${MIN_BROADCAST_INTERVAL/1000}s`)
console.log(`🌍 XAU/USD: TradingView → Investing → Google\n`)

const app = express()
app.use(express.json())

app.get('/', (_req, res) => res.send('✅ Bot Running'))

app.get('/qr', async (_req, res) => {
  if (!lastQr) return res.send('<pre>QR not ready</pre>')
  try {
    const mod = await import('qrcode').catch(() => null)
    if (mod?.toDataURL) {
      const dataUrl = await mod.toDataURL(lastQr, { margin: 1 })
      return res.send(`<div style="text-align:center;padding:20px"><img src="${dataUrl}" style="max-width:400px"/></div>`)
    }
  } catch (_) {}
  res.send(lastQr)
})

app.get('/stats', (_req, res) => {
  res.json({
    status: isReady ? '🟢' : '🔴',
    uptime: Math.floor(process.uptime()),
    subs: subscriptions.size,
    lastPrice: lastKnownPrice,
    lastBroadcasted: lastBroadcastedPrice,
    broadcastCount: broadcastCount,
    logs: logs.slice(-20)
  })
})

app.listen(PORT, () => {
  console.log(`🌐 http://localhost:${PORT}`)
  console.log(`📊 /stats\n`)
})

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    getMessage: async () => ({ conversation: '' })
  })

  setInterval(() => {
    if (sock?.ws?.readyState === 1) sock.ws.ping()
  }, 30000)

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect, qr } = u
    
    if (qr) {
      lastQr = qr
      pushLog('QR ready')
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      pushLog(`Closed: ${reason}`)
      
      if (reason === DisconnectReason.loggedOut) {
        pushLog('LOGGED OUT')
        return
      }
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        pushLog(`Reconnect in ${Math.round(delay/1000)}s`)
        setTimeout(() => start(), delay)
      }
      
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      pushLog('Connected')
      
      isReady = false
      pushLog('Warmup 15s')
      
      setTimeout(() => {
        isReady = true
        pushLog('Ready!')
        checkPriceUpdate()
      }, 15000)
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
        
        if (/\blangganan\b|\bsubscribe\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '✅ Sudah berlangganan!\n\n📢 Update real-time otomatis'
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            pushLog(`+ ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)
            
            await sock.sendMessage(sendTarget, {
              text: '🎉 *Langganan Berhasil!*\n\n📢 Notifikasi otomatis saat harga berubah\n\n_Ketik "berhenti" untuk stop._'
            }, { quoted: msg })
          }
          continue
        }
        
        if (/\bberhenti\b|\bunsubscribe\b|\bstop\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            pushLog(`- ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)
            await sock.sendMessage(sendTarget, { text: '👋 Langganan dihentikan.' }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, { text: '❌ Belum berlangganan.' }, { quoted: msg })
          }
          continue
        }
        
        if (!/\bemas\b/.test(text)) continue

        const now = Date.now()
        const lastReply = lastReplyAtPerChat.get(sendTarget) || 0
        
        if (now - lastReply < COOLDOWN_PER_CHAT) continue
        if (now - lastGlobalReplyAt < GLOBAL_THROTTLE) continue

        try {
          await sock.sendPresenceUpdate('composing', sendTarget)
        } catch (_) {}
        
        await new Promise(r => setTimeout(r, TYPING_DURATION))

        let replyText
        try {
          const [treasury, usdIdr, xauUsd] = await Promise.all([
            fetchTreasury(),
            fetchUSDIDRFromGoogle(),
            fetchXAUUSD()
          ])
          replyText = formatMessage(treasury, usdIdr.rate, xauUsd, null)
        } catch (e) {
replyText = '❌ Gagal mengambil data harga.'
        }

        await new Promise(r => setTimeout(r, 500))
        
        try {
          await sock.sendPresenceUpdate('paused', sendTarget)
        } catch (_) {}
        
        await sock.sendMessage(sendTarget, { text: replyText }, { quoted: msg })

        lastReplyAtPerChat.set(sendTarget, now)
        lastGlobalReplyAt = now
        
        await new Promise(r => setTimeout(r, 1000))
        
      } catch (e) {
        pushLog(`Error: ${e.message}`)
      }
    }
  })
}

start().catch(e => {
  console.error('Fatal:', e)
  process.exit(1)
})
