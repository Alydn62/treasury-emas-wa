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

// BROADCAST COOLDOWN
const PRICE_CHECK_INTERVAL = 1000 // 1 DETIK - ULTRA REAL-TIME!
const MIN_PRICE_CHANGE = 1
const BROADCAST_COOLDOWN = 50000 // 50 detik antar broadcast (atau ganti menit)

// Economic Calendar Settings
const ECONOMIC_CALENDAR_ENABLED = true
const CALENDAR_COUNTRY_FILTER = ['USD']
const CALENDAR_MIN_IMPACT = 3

// Broadcast Settings
const BATCH_SIZE = 20 // Max messages per batch
const BATCH_DELAY = 1000 // Delay between batches (ms)

// Konversi troy ounce ke gram
const TROY_OZ_TO_GRAM = 31.1034768

// Threshold untuk harga normal/abnormal
const NORMAL_THRESHOLD = 2000
const NORMAL_LOW_THRESHOLD = 1000

// Cache untuk XAU/USD
let cachedXAUUSD = null
let lastXAUUSDFetch = 0
const XAU_CACHE_DURATION = 30000

// Cache untuk Economic Calendar
let cachedEconomicEvents = null
let lastEconomicFetch = 0
const ECONOMIC_CACHE_DURATION = 300000 // 5 menit

let lastKnownPrice = null
let lastBroadcastedPrice = null
let isBroadcasting = false
let broadcastCount = 0
let lastBroadcastTime = 0

// ⏱️ STALE PRICE DETECTION
let lastPriceUpdateTime = 0  // Kapan terakhir harga berubah dari API
const STALE_PRICE_THRESHOLD = 5 * 60 * 1000  // 5 menit

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

// ⚡ CACHE GLOBAL untuk market data (pre-fetched)
let cachedMarketData = {
  usdIdr: { rate: 16600 }, // Updated default to current market rate
  xauUsd: null,
  economicEvents: null,
  lastUpdate: 0
}

// Background task untuk pre-fetch market data
// USD/IDR only fetched at second 50 of each minute
// XAU/USD and calendar updated every 5 seconds
setInterval(async () => {
  try {
    const currentSecond = new Date().getSeconds();

    // Fetch USD/IDR only at second 50
    let usdIdr = cachedMarketData.usdIdr;
    if (currentSecond >= 50 && currentSecond <= 51) {
      try {
        usdIdr = await fetchUSDIDRFromGoogle();
      } catch (e) {
        // Keep old USD/IDR if fetch fails
      }
    }

    // Always fetch XAU/USD and economic calendar
    const [xauUsd, economicEvents] = await Promise.all([
      fetchXAUUSDCached(),
      fetchEconomicCalendar()
    ]);

    cachedMarketData = {
      usdIdr,
      xauUsd,
      economicEvents,
      lastUpdate: Date.now()
    }
  } catch (e) {
    // Silent fail - keep old cache
  }
}, 5000) // Check every 5 seconds, but USD/IDR only at second 50

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

// ------ ECONOMIC CALENDAR FUNCTIONS ------
async function fetchEconomicCalendar() {
  if (!ECONOMIC_CALENDAR_ENABLED) return null
  
  const now = Date.now()
  
  if (cachedEconomicEvents && (now - lastEconomicFetch) < ECONOMIC_CACHE_DURATION) {
    return cachedEconomicEvents
  }
  
  try {
    const res = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      signal: AbortSignal.timeout(5000)
    })
    
    if (!res.ok) {
      pushLog('❌ Economic calendar fetch failed')
      return null
    }
    
    const events = await res.json()
    
    // Waktu Jakarta (WIB = UTC+7)
    const jakartaNow = new Date(Date.now() + (7 * 60 * 60 * 1000))
    const todayJakarta = new Date(jakartaNow.getFullYear(), jakartaNow.getMonth(), jakartaNow.getDate())
    const tomorrowJakarta = new Date(todayJakarta.getTime() + (24 * 60 * 60 * 1000))
    const dayAfterTomorrowJakarta = new Date(todayJakarta.getTime() + (2 * 24 * 60 * 60 * 1000))
    
    const filteredEvents = events.filter(event => {
      if (!event.date) return false
      
      // Parse event date dan convert ke WIB
      const eventDate = new Date(event.date)
      const eventWIB = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))
      const eventDateOnly = new Date(eventWIB.getFullYear(), eventWIB.getMonth(), eventWIB.getDate())
      
      // ⏰ LOGIC: Tampilkan news 3 jam setelah rilis
      const threeHoursAfterEvent = new Date(eventDate.getTime() + (3 * 60 * 60 * 1000))
      
      // Jika news sudah lewat 3 jam, skip
      if (Date.now() > threeHoursAfterEvent.getTime()) {
        return false
      }
      
      // Filter: hanya hari ini dan besok (2 hari)
      if (eventDateOnly < todayJakarta || eventDateOnly >= dayAfterTomorrowJakarta) {
        return false
      }
      
      // Filter: hanya USD
      if (!CALENDAR_COUNTRY_FILTER.includes(event.country)) return false
      
      // Filter: hanya High Impact
      if (event.impact !== 'High') return false
      
      return true
    })
    
    // Sort by time
    filteredEvents.sort((a, b) => {
      const timeA = new Date(a.date).getTime()
      const timeB = new Date(b.date).getTime()
      return timeA - timeB
    })
    
    // Limit to 10 events
    const limitedEvents = filteredEvents.slice(0, 10)
    
    pushLog(`📅 Found ${limitedEvents.length} USD high-impact events (showing 3hrs window)`)
    
    cachedEconomicEvents = limitedEvents
    lastEconomicFetch = now
    
    return limitedEvents
    
  } catch (e) {
    pushLog(`❌ Economic calendar error: ${e.message}`)
    return null
  }
}

// Fungsi untuk menentukan apakah news bagus/jelek untuk gold
function analyzeGoldImpact(event) {
  const title = (event.title || '').toLowerCase()
  const actual = event.actual || ''
  const forecast = event.forecast || ''
  
  if (!actual || actual === '-' || !forecast || forecast === '-') {
    return null
  }
  
  const actualNum = parseFloat(actual.replace(/[^0-9.-]/g, ''))
  const forecastNum = parseFloat(forecast.replace(/[^0-9.-]/g, ''))
  
  if (isNaN(actualNum) || isNaN(forecastNum)) {
    return null
  }
  
  // Logic: news yang memperkuat USD = jelek untuk gold
  // news yang melemahkan USD = bagus untuk gold
  
  // Interest Rate: Naik = USD kuat = jelek untuk gold
  if (title.includes('interest rate') || title.includes('fed') || title.includes('fomc')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // NFP / Employment: Naik = ekonomi kuat = USD kuat = jelek untuk gold
  if (title.includes('non-farm') || title.includes('nfp') || title.includes('payroll')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // Unemployment: Naik = ekonomi lemah = USD lemah = bagus untuk gold
  if (title.includes('unemployment')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // CPI / Inflation: Naik = inflasi tinggi = bagus untuk gold
  if (title.includes('cpi') || title.includes('inflation') || title.includes('pce')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // GDP: Naik = ekonomi kuat = USD kuat = jelek untuk gold
  if (title.includes('gdp')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  // Jobless Claims: Naik = ekonomi lemah = bagus untuk gold
  if (title.includes('jobless') || title.includes('claims')) {
    return actualNum > forecastNum ? 'BAGUS' : 'JELEK'
  }
  
  // Retail Sales: Naik = ekonomi kuat = jelek untuk gold
  if (title.includes('retail sales')) {
    return actualNum > forecastNum ? 'JELEK' : 'BAGUS'
  }
  
  return null
}

function formatEconomicCalendar(events) {
  if (!events || events.length === 0) {
    return ''
  }
  
  let calendarText = '\n📅 USD News\n'
  
  events.forEach((event, index) => {
    const eventDate = new Date(event.date)
    const wibTime = new Date(eventDate.getTime() + (7 * 60 * 60 * 1000))
    
    const minutes = wibTime.getMinutes()
    const roundedMinutes = Math.round(minutes / 5) * 5
    wibTime.setMinutes(roundedMinutes)
    wibTime.setSeconds(0)
    
    const hours = wibTime.getHours().toString().padStart(2, '0')
    const mins = wibTime.getMinutes().toString().padStart(2, '0')
    const timeStr = `${hours}:${mins}`
    
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const dayName = days[wibTime.getDay()]
    
    const title = event.title || event.event || 'Unknown Event'
    const forecast = event.forecast || '-'
    const previous = event.previous || '-'
    const actual = event.actual || '-'
    
    const nowTime = Date.now()
    const eventTime = eventDate.getTime()
    const timeSinceEvent = nowTime - eventTime
    const minutesSinceEvent = Math.floor(timeSinceEvent / (60 * 1000))
    
    let timeStatus = ''
    if (timeSinceEvent < 0) {
      const minutesUntil = Math.abs(minutesSinceEvent)
      if (minutesUntil < 60) {
        timeStatus = `⏰${minutesUntil}m`
      } else {
        const hoursUntil = Math.floor(minutesUntil / 60)
        const minsUntil = minutesUntil % 60
        if (minsUntil > 0) {
          timeStatus = `⏰${hoursUntil}j ${minsUntil}m`
        } else {
          timeStatus = `⏰${hoursUntil}j`
        }
      }
    } else if (timeSinceEvent > 0 && timeSinceEvent <= 3 * 60 * 60 * 1000) {
      const hoursAgo = Math.floor(minutesSinceEvent / 60)
      const minsAgo = minutesSinceEvent % 60
      if (hoursAgo > 0) {
        timeStatus = `✅${hoursAgo}j ${minsAgo}m lalu`
      } else {
        timeStatus = `✅${minsAgo}m lalu`
      }
    }
    
    // Shortened title
    let shortTitle = title
    if (title.includes('Non-Farm')) shortTitle = 'NFP'
    else if (title.includes('Unemployment')) shortTitle = 'Unemp'
    else if (title.includes('Interest Rate')) shortTitle = 'Interest'
    else if (title.includes('CPI')) shortTitle = 'CPI'
    else if (title.includes('GDP')) shortTitle = 'GDP'
    else if (title.includes('Retail')) shortTitle = 'Retail'
    else if (title.includes('Jobless')) shortTitle = 'Jobless'
    
    calendarText += `• ${dayName} ${timeStr}`
    
    if (timeStatus) {
      calendarText += ` (${timeStatus})`
    }
    
    calendarText += ` ${shortTitle}`
    
    if (actual !== '-' && actual !== '') {
      const goldImpact = analyzeGoldImpact(event)
      
      calendarText += ` ${actual}>${forecast}`
      
      if (goldImpact === 'BAGUS') {
        calendarText += ` 🟢 BAGUS`
      } else if (goldImpact === 'JELEK') {
        calendarText += ` 🔴 JELEK`
      }
    } else if (forecast !== '-') {
      calendarText += ` F:${forecast}`
    }
    
    calendarText += '\n'
  })
  
  return calendarText
}

// ------ FOREX FUNCTIONS ------
async function fetchUSDIDRFromBankIndonesia() {
  try {
    // Try to fetch from Bank Indonesia JISDOR
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      signal: AbortSignal.timeout(2000)
    })
    if (res.ok) {
      const json = await res.json()
      const rate = json.rates?.IDR
      if (rate && rate > 10000 && rate < 20000) {
        console.log(`[USD/IDR] Exchange Rate API: Rp ${rate.toLocaleString('id-ID')}`)
        return { rate }
      }
    }
  } catch (_) {}
  return null
}

async function fetchUSDIDRFallback() {
  try {
    // Try multiple sources for better accuracy
    const sources = [
      // Primary: ExchangeRate-API
      async () => {
        const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
          signal: AbortSignal.timeout(2000)
        })
        if (res.ok) {
          const json = await res.json()
          return json.rates?.IDR
        }
      },
      // Secondary: Fixer.io (free tier)
      async () => {
        const res = await fetch('https://api.fixer.io/latest?base=USD&symbols=IDR', {
          signal: AbortSignal.timeout(2000)
        })
        if (res.ok) {
          const json = await res.json()
          return json.rates?.IDR
        }
      }
    ]

    for (const source of sources) {
      try {
        const rate = await source()
        if (rate && rate > 10000 && rate < 20000) {
          console.log(`[USD/IDR] Fallback API: Rp ${rate.toLocaleString('id-ID')}`)
          return { rate }
        }
      } catch (_) {}
    }
  } catch (_) {}

  console.log('[USD/IDR] Using default fallback: Rp 16,600')
  return { rate: 16600 }
}

async function fetchUSDIDRFromGoogle() {
  const maxRetries = 3
  let attempt = 0

  while (attempt < maxRetries) {
    attempt++

    try {
      // Only log first attempt
      if (attempt === 1) {
        console.log(`[USD/IDR] Fetching from Google Finance...`)
      }

      const res = await fetch('https://www.google.com/finance/quote/USD-IDR', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"Windows"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        },
        signal: AbortSignal.timeout(10000) // Increased timeout to 10 seconds
      })

      if (!res.ok) {
        if (attempt === maxRetries) {
          console.log(`[USD/IDR] Failed after ${maxRetries} attempts (HTTP ${res.status})`)
        }
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 2000)) // Wait 2 seconds before retry
          continue
        }
      }

      const html = await res.text()

      // More comprehensive patterns for Google Finance
      const patterns = [
        // Primary patterns - most likely to work
        /class="YMlKec fxKbKc"[^>]*>([0-9,\.]+)<\/div>/i,
        /class="[^"]*fxKbKc[^"]*"[^>]*>([0-9,\.]+)<\/div>/i,
        /data-last-price="([0-9,\.]+)"/i,
        /data-price="([0-9,\.]+)"/i,

        // JSON-LD patterns
        /"price":\s*"([0-9,\.]+)"/i,
        /"value":\s*"([0-9,\.]+)"/i,

        // Alternative div patterns
        /<div[^>]*>([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)<\/div>/i,

        // Specific Google Finance patterns
        /USD to IDR[^0-9]*([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)/i,
        /1 USD = ([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)/i,

        // Meta tag patterns
        /<meta[^>]*content="([0-9]{1,2}[,\.][0-9]{3}(?:\.[0-9]+)?)"[^>]*>/i,

        // Broader patterns
        />([0-9]{2}[,\.][0-9]{3}(?:\.[0-9]+)?)</,
        /USD\/IDR[^0-9]*([0-9]{1,2}[,\.][0-9]{3}(?:[,\.][0-9]+)?)/i
      ]

      // Silent parsing - no log needed

      for (const pattern of patterns) {
        const match = html.match(pattern)
        if (match?.[1]) {
          const rate = parseFloat(match[1].replace(/,/g, ''))

          // Validate rate is in reasonable range for IDR (15000-17000)
          if (rate > 15000 && rate < 17000) {
            console.log(`[USD/IDR] Rp ${rate.toLocaleString('id-ID')}`)
            return { rate }
          } else if (rate > 10000 && rate < 20000) {
            // Wider range as fallback
            console.log(`[USD/IDR] Rp ${rate.toLocaleString('id-ID')} (unusual)`)
            return { rate }
          }
        }
      }

      // Silent retry
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }

    } catch (err) {
      // Only log on final attempt
      if (attempt === maxRetries) {
        console.log(`[USD/IDR] Error: ${err.message}`)
      }

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 3000))
      }
    }
  }

  // After all retries failed, use a more recent default
  console.log('[USD/IDR] Using fallback: Rp 15,900')
  return { rate: 15900 } // More realistic current rate
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
          // Silent success - no log needed
          return price
        }
      }
    }
  } catch (e) {
    // Silent fail - will try next source
  }
  return null
}

async function fetchXAUUSDFromInvesting() {
  try {
    const res = await fetch('https://www.investing.com/currencies/xau-usd', {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      },
      signal: AbortSignal.timeout(6000)
    })
    
    if (!res.ok) {
      // Silent fail
      return null
    }
    
    const html = await res.text()
    const foundPrices = []
    
    let match = html.match(/data-test="instrument-price-last"[^>]*>([0-9,]+\.?[0-9]*)</i)
    if (match?.[1]) {
      const price = parseFloat(match[1].replace(/,/g, ''))
      if (price > 1000 && price < 10000) {
        foundPrices.push({ method: 'data-test', price, priority: 1 })
      }
    }

    match = html.match(/class="instrument-price-last[^"]*"[^>]*>([0-9,]+\.?[0-9]*)</i)
    if (match?.[1]) {
      const price = parseFloat(match[1].replace(/,/g, ''))
      if (price > 1000 && price < 10000) {
        foundPrices.push({ method: 'class-instrument', price, priority: 2 })
      }
    }

    const pricePatterns = [
      /instrument[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i,
      /quote[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i,
      /current[^>]{0,50}([0-9]{1},?[0-9]{3}\.[0-9]{2})/i
    ]

    for (const pattern of pricePatterns) {
      match = html.match(pattern)
      if (match?.[1]) {
        const price = parseFloat(match[1].replace(/,/g, ''))
        if (price > 1000 && price < 10000) {
          foundPrices.push({ method: 'generic-pattern', price, priority: 9 })
        }
      }
    }

    if (foundPrices.length === 0) {
      return null
    }

    if (foundPrices.length === 1) {
      return foundPrices[0].price
    }

    const priceGroups = new Map()

    for (const { method, price, priority } of foundPrices) {
      let foundGroup = false

      for (const [groupPrice, items] of priceGroups) {
        if (Math.abs(groupPrice - price) <= 1.0) {
          items.push({ method, price, priority })
          foundGroup = true
          break
        }
      }

      if (!foundGroup) {
        priceGroups.set(price, [{ method, price, priority }])
      }
    }

    let bestGroup = null
    let maxCount = 0
    let bestPriority = 999

    for (const [groupPrice, items] of priceGroups) {
      const avgPriority = items.reduce((sum, item) => sum + item.priority, 0) / items.length

      if (items.length > maxCount) {
        maxCount = items.length
        bestGroup = items
        bestPriority = avgPriority
      } else if (items.length === maxCount && avgPriority < bestPriority) {
        bestGroup = items
        bestPriority = avgPriority
      }
    }

    if (bestGroup) {
      const avgPrice = bestGroup.reduce((sum, item) => sum + item.price, 0) / bestGroup.length
      return avgPrice
    }

    foundPrices.sort((a, b) => a.priority - b.priority)
    const fallbackPrice = foundPrices[0].price

    return fallbackPrice
    
  } catch (e) {
    // Silent fail
    return null
  }
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
          // Silent success
          return price
        }
      }
    }
  } catch (e) {
    // Silent fail
  }
  return null
}

async function fetchXAUUSD() {
  let result = await fetchXAUUSDFromTradingView()
  if (result) {
    console.log(`[XAU/USD] $${result.toFixed(2)}`)
    return result
  }

  result = await fetchXAUUSDFromInvesting()
  if (result) {
    console.log(`[XAU/USD] $${result.toFixed(2)}`)
    return result
  }

  result = await fetchXAUUSDFromGoogle()
  if (result) {
    console.log(`[XAU/USD] $${result.toFixed(2)}`)
    return result
  }

  console.log('[XAU/USD] Failed - no data')
  return null
}

async function fetchXAUUSDCached() {
  const now = Date.now()
  
  if (cachedXAUUSD && (now - lastXAUUSDFetch) < XAU_CACHE_DURATION) {
    return cachedXAUUSD
  }
  
  const price = await fetchXAUUSD()
  if (price) {
    cachedXAUUSD = price
    lastXAUUSDFetch = now
  }
  
  return cachedXAUUSD
}

function analyzePriceStatus(treasuryBuy, treasurySell, xauUsdPrice, usdIdrRate) {
  if (!xauUsdPrice || !usdIdrRate) {
    return {
      status: 'DATA_INCOMPLETE',
      message: '⚠️ Data Incomplete',
      emoji: '⚠️'
    }
  }

  // Range NORMAL: margin 0.97% - 1.25%
  const TROY_OZ_TO_GRAM_EXACT = 31.1035
  const MIN_MARGIN = 1.0097  // 0.97%
  const MAX_MARGIN = 1.0125  // 1.25%

  // Hitung harga dasar internasional
  const basePrice = (xauUsdPrice * usdIdrRate) / TROY_OZ_TO_GRAM_EXACT

  // Hitung batas bawah dan atas untuk range NORMAL
  const lowerBound = basePrice * MIN_MARGIN
  const upperBound = basePrice * MAX_MARGIN

  // Hitung selisih dari range NORMAL
  let difference = 0
  let status = 'NORMAL'
  let emoji = '✅'
  let message = '✅ NORMAL'

  if (treasurySell < lowerBound) {
    // Di bawah range NORMAL (margin < 1.2%)
    difference = treasurySell - lowerBound  // akan negatif
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (${difference > 0 ? '+' : ''}${formatRupiah(Math.round(difference))})`
  } else if (treasurySell > upperBound) {
    // Di atas range NORMAL (margin > 1.35%)
    difference = treasurySell - upperBound  // akan positif
    status = 'ABNORMAL'
    emoji = '⚠️'
    message = `⚠️ TIDAK NORMAL (+${formatRupiah(Math.round(difference))})`
  }

  // Calculate actual margin percentage
  const actualMargin = ((treasurySell - basePrice) / basePrice) * 100

  // Log only once per minute or when status changes (removed repetitive logging)

  return {
    status,
    emoji,
    message,
    basePrice,
    lowerBound,
    upperBound,
    treasuryPrice: treasurySell,
    difference,
    actualMargin
  }
}

function formatMessage(treasuryData, usdIdrRate, xauUsdPrice = null, priceChange = null, economicEvents = null) {
  const buy = treasuryData?.data?.buying_rate || 0
  const sell = treasuryData?.data?.selling_rate || 0

  const spread = sell - buy
  const spreadPercent = ((spread / buy) * 100).toFixed(2)

  const buyFormatted = `Rp${formatRupiah(buy)}/gr`
  const sellFormatted = `Rp${formatRupiah(sell)}/gr`

  const updatedAt = treasuryData?.data?.updated_at
  let timeSection = ''
  if (updatedAt) {
    const date = new Date(updatedAt)
    const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu']
    const dayName = days[date.getDay()]
    const hours = date.getHours().toString().padStart(2, '0')
    const minutes = date.getMinutes().toString().padStart(2, '0')
    const seconds = date.getSeconds().toString().padStart(2, '0')
    timeSection = `${dayName} ${hours}:${minutes}:${seconds} WIB`
  }

  let headerSection = ''
  if (priceChange && priceChange.buyChange !== 0) {
    const changeAmount = Math.abs(priceChange.buyChange)
    const changeFormatted = formatRupiah(changeAmount)
    if (priceChange.buyChange > 0) {
      headerSection = `🚀 🚀 NAIK 🚀 🚀 (+Rp${changeFormatted})\n`
    } else {
      headerSection = `🔻 🔻 TURUN 🔻 🔻 (-Rp${changeFormatted})\n`
    }
  }

  // Analisis status harga dengan rumus user
  let statusSection = ''
  if (xauUsdPrice && usdIdrRate) {
    const priceStatus = analyzePriceStatus(buy, sell, xauUsdPrice, usdIdrRate)
    statusSection = `\n${priceStatus.message}`
  }

  let marketSection = `💱 USD Rp${formatRupiah(Math.round(usdIdrRate))}`

  if (xauUsdPrice) {
    marketSection += ` | XAU $${xauUsdPrice.toFixed(2)}`
  }

  const calendarSection = formatEconomicCalendar(economicEvents)

  const grams20M = calculateProfit(buy, sell, 20000000).totalGrams
  const profit20M = calculateProfit(buy, sell, 20000000).profit
  const grams30M = calculateProfit(buy, sell, 30000000).totalGrams
  const profit30M = calculateProfit(buy, sell, 30000000).profit

  // Format gram dengan 4 digit desimal
  const formatGrams = (g) => g.toFixed(4)

  return `${headerSection}${timeSection}${statusSection}

💰 Beli ${buyFormatted} | Jual ${sellFormatted} (${spreadPercent > 0 ? '-' : ''}${spreadPercent}%)
${marketSection}

🎁 20jt→${formatGrams(grams20M)}gr (+Rp${formatRupiah(Math.round(profit20M))}) | 30jt→${formatGrams(grams30M)}gr (+Rp${formatRupiah(Math.round(profit30M))})
${calendarSection}
⚡ Auto-update`
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

// ⚡ UPDATED BROADCAST FUNCTION dengan validasi timestamp
async function doBroadcast(priceChange, priceData) {
  // CRITICAL: Check flag sebelum set
  if (isBroadcasting) {
    pushLog(`⚠️  Broadcast already in progress, skipping...`)
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
    // ✅ VALIDASI TIMESTAMP: Pastikan harga masih fresh (max 3 detik)
    const priceAge = Date.now() - priceData.fetchedAt
    if (priceAge > 3000) {
      pushLog(`⚠️  [#${currentBroadcastId}] Price too old (${Math.round(priceAge/1000)}s), fetching fresh data...`)
      
      // Fetch ulang harga terbaru
      try {
        const freshTreasury = await fetchTreasury()
        const freshPrice = {
          buy: freshTreasury?.data?.buying_rate,
          sell: freshTreasury?.data?.selling_rate,
          updated_at: freshTreasury?.data?.updated_at,
          fetchedAt: Date.now()
        }
        
        // Update priceData dengan data fresh
        priceData = freshPrice
        
        // Recalculate priceChange
        priceChange = {
          buyChange: freshPrice.buy - lastBroadcastedPrice.buy,
          sellChange: freshPrice.sell - lastBroadcastedPrice.sell
        }
        
        pushLog(`✅ [#${currentBroadcastId}] Fresh data: Buy=${formatRupiah(freshPrice.buy)}, Sell=${formatRupiah(freshPrice.sell)}`)
        
      } catch (e) {
        pushLog(`❌ [#${currentBroadcastId}] Failed to fetch fresh data: ${e.message}`)
        isBroadcasting = false
        return
      }
    }
    
    const startTime = Date.now()
    pushLog(`📤 [#${currentBroadcastId}] Starting instant broadcast...`)
    
    // ⚡ INSTANT: Gunakan cached market data (sudah pre-fetched)
    const usdIdr = cachedMarketData.usdIdr
    const xauUsd = cachedMarketData.xauUsd
    const economicEvents = cachedMarketData.economicEvents
    
    // Check lagi sebelum broadcast (double safety)
    if (!sock || !isReady) {
      pushLog(`⚠️  Bot not ready, aborting broadcast #${currentBroadcastId}`)
      isBroadcasting = false
      return
    }
    
    // Buat treasury data object dari priceData
    const treasuryData = {
      data: {
        buying_rate: priceData.buy,
        selling_rate: priceData.sell,
        updated_at: priceData.updated_at
      }
    }
    
    const message = formatMessage(treasuryData, usdIdr.rate, xauUsd, priceChange, economicEvents)
    
    const prepTime = Date.now() - startTime
    pushLog(`📤 [#${currentBroadcastId}] Message ready (${prepTime}ms), sending to ${subscriptions.size} subs...`)
    
    let successCount = 0
    let failCount = 0
    
    const subsArray = Array.from(subscriptions)
    
    // ⚡ INSTANT SEND: Fire all messages at once with Promise.allSettled
    const sendStartTime = Date.now()
    
    const sendPromises = subsArray.map(chatId => 
      sock.sendMessage(chatId, { text: message })
        .then(() => {
          successCount++
        })
        .catch((e) => {
          failCount++
          pushLog(`❌ Failed: ${chatId.substring(0, 15)}`)
        })
    )
    
    // Wait for all to complete
    await Promise.allSettled(sendPromises)
    
    const sendTime = Date.now() - sendStartTime
    const totalTime = Date.now() - startTime
    
    pushLog(`✅ [#${currentBroadcastId}] Sent: ${successCount}, Failed: ${failCount} (send: ${sendTime}ms, total: ${totalTime}ms)`)
    
  } catch (e) {
    pushLog(`❌ Broadcast #${currentBroadcastId} error: ${e.message}`)
  } finally {
    // ALWAYS release flag in finally block
    isBroadcasting = false
  }
}

async function checkPriceUpdate() {
  if (!isReady || subscriptions.size === 0) return

  try {
    const treasuryData = await fetchTreasury()
    const currentPrice = {
      buy: treasuryData?.data?.buying_rate,
      sell: treasuryData?.data?.selling_rate,
      updated_at: treasuryData?.data?.updated_at,
      fetchedAt: Date.now()
    }

    if (!lastKnownPrice) {
      lastKnownPrice = currentPrice
      lastBroadcastedPrice = currentPrice
      lastPriceUpdateTime = Date.now()
      pushLog(`📊 Initial: Buy=${formatRupiah(currentPrice.buy)}, Sell=${formatRupiah(currentPrice.sell)}`)

      // Check initial price status
      if (cachedMarketData.xauUsd && cachedMarketData.usdIdr) {
        const priceStatus = analyzePriceStatus(
          currentPrice.buy,
          currentPrice.sell,
          cachedMarketData.xauUsd,
          cachedMarketData.usdIdr.rate
        )
        if (priceStatus.status === 'ABNORMAL') {
          pushLog(`⚠️ INITIAL PRICE IS TIDAK NORMAL!`)
        }
      }
      return
    }
    
    const buyChanged = lastKnownPrice.buy !== currentPrice.buy
    const sellChanged = lastKnownPrice.sell !== currentPrice.sell

    // ⏱️ STALE PRICE DETECTION
    const now = Date.now()
    const timeSinceLastUpdate = now - lastPriceUpdateTime
    const isPriceStale = timeSinceLastUpdate >= STALE_PRICE_THRESHOLD

    // Check jika status berubah dari NORMAL ke TIDAK NORMAL atau sebaliknya
    let statusChanged = false
    let currentStatus = null
    let previousStatus = null

    if (cachedMarketData.xauUsd && cachedMarketData.usdIdr) {
      const currentPriceStatus = analyzePriceStatus(
        currentPrice.buy,
        currentPrice.sell,
        cachedMarketData.xauUsd,
        cachedMarketData.usdIdr.rate
      )
      currentStatus = currentPriceStatus.status

      const lastPriceStatus = analyzePriceStatus(
        lastKnownPrice.buy,
        lastKnownPrice.sell,
        cachedMarketData.xauUsd,
        cachedMarketData.usdIdr.rate
      )
      previousStatus = lastPriceStatus.status

      statusChanged = currentStatus !== previousStatus

      if (statusChanged) {
        if (currentStatus === 'ABNORMAL') {
          pushLog(`⚠️ STATUS CHANGED: NORMAL → TIDAK NORMAL!`)
        } else if (currentStatus === 'NORMAL') {
          pushLog(`✅ STATUS CHANGED: TIDAK NORMAL → NORMAL`)
        }
      }
    }

    if (!buyChanged && !sellChanged) {
      // Tidak ada perubahan harga
      if (isPriceStale) {
        // Log setiap menit jika harga stale
        const minutes = Math.floor(timeSinceLastUpdate / 60000)
        if (minutes % 1 === 0) {
          pushLog(`⏱️  Harga tidak berubah selama ${minutes} menit`)
        }
      }
      return
    }
    
    // 🔥 ADA PERUBAHAN HARGA!
    const buyChangeSinceBroadcast = Math.abs(currentPrice.buy - (lastBroadcastedPrice?.buy || currentPrice.buy))
    const sellChangeSinceBroadcast = Math.abs(currentPrice.sell - (lastBroadcastedPrice?.sell || currentPrice.sell))
    
    if (buyChangeSinceBroadcast < MIN_PRICE_CHANGE && sellChangeSinceBroadcast < MIN_PRICE_CHANGE) {
      lastKnownPrice = currentPrice
      lastPriceUpdateTime = now  // Update timestamp meskipun perubahan kecil
      return
    }
    
    const timeSinceLastBroadcast = now - lastBroadcastTime
    
    // Cek apakah sudah ganti menit
    const lastBroadcastDate = new Date(lastBroadcastTime)
    const currentDate = new Date(now)
    const lastMinute = lastBroadcastDate.getHours() * 60 + lastBroadcastDate.getMinutes()
    const currentMinute = currentDate.getHours() * 60 + currentDate.getMinutes()
    const isNewMinute = currentMinute !== lastMinute
    
    // 🎯 LOGIKA BROADCAST:
    // 1. Jika status berubah ke TIDAK NORMAL → BROADCAST LANGSUNG (prioritas tinggi!)
    // 2. Jika harga stale (5+ menit tidak update) → BROADCAST LANGSUNG saat ada update baru
    // 3. Jika harga tidak stale → ikuti cooldown normal (50 detik ATAU ganti menit)

    const shouldBroadcast = statusChanged && currentStatus === 'ABNORMAL'
      ? true  // Langsung broadcast jika status berubah ke TIDAK NORMAL
      : isPriceStale
      ? true  // Langsung broadcast jika harga baru setelah 5 menit stale
      : (timeSinceLastBroadcast >= BROADCAST_COOLDOWN || isNewMinute)
    
    if (!shouldBroadcast) {
      const priceChange = {
        buyChange: currentPrice.buy - lastKnownPrice.buy,
        sellChange: currentPrice.sell - lastKnownPrice.sell
      }
      
      lastKnownPrice = currentPrice
      lastPriceUpdateTime = now  // Update timestamp
      
      const time = new Date().toISOString().substring(11, 19)
      const buyIcon = priceChange.buyChange > 0 ? '📈' : '📉'
      const sellIcon = priceChange.sellChange > 0 ? '📈' : '📉'
      
      pushLog(`🔔 ${time} PRICE CHANGE! ${buyIcon} Buy: ${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)} ${sellIcon} Sell: ${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)} (⏳ Wait ${Math.round((BROADCAST_COOLDOWN - timeSinceLastBroadcast)/1000)}s or next minute)`)
      return
    }
    
    const priceChange = {
      buyChange: currentPrice.buy - lastKnownPrice.buy,
      sellChange: currentPrice.sell - lastKnownPrice.sell
    }
    
    lastKnownPrice = currentPrice
    lastPriceUpdateTime = now  // Update timestamp saat broadcast
    
    const time = new Date().toISOString().substring(11, 19)
    const buyIcon = priceChange.buyChange > 0 ? '📈' : '📉'
    const sellIcon = priceChange.sellChange > 0 ? '📈' : '📉'
    
    let reason = ''
    if (isPriceStale) {
      reason = `(🎯 Update setelah ${Math.floor(timeSinceLastUpdate/60000)}m stale)`
    } else if (isNewMinute) {
      reason = '(New minute)'
    } else {
      reason = '(50s passed)'
    }
    
    pushLog(`🔔 ${time} PRICE CHANGE! ${buyIcon} Buy: ${priceChange.buyChange > 0 ? '+' : ''}${formatRupiah(priceChange.buyChange)} ${sellIcon} Sell: ${priceChange.sellChange > 0 ? '+' : ''}${formatRupiah(priceChange.sellChange)} ${reason}`)
    
    // CRITICAL FIX: Hitung finalPriceChange SEBELUM update lastBroadcastedPrice
    const finalPriceChange = {
      buyChange: currentPrice.buy - lastBroadcastedPrice.buy,
      sellChange: currentPrice.sell - lastBroadcastedPrice.sell
    }
    
    // ✅ VALIDASI: Hanya broadcast jika harga masih di menit yang sama
    const priceFetchTime = new Date(currentPrice.fetchedAt)
    const nowTime = new Date(Date.now())
    const priceMinute = priceFetchTime.getHours() * 60 + priceFetchTime.getMinutes()
    const nowMinute = nowTime.getHours() * 60 + nowTime.getMinutes()
    
    if (priceMinute !== nowMinute && !isPriceStale) {
      pushLog(`⚠️  Price dari menit lain (${priceMinute} vs ${nowMinute}), skip broadcast`)
      lastBroadcastedPrice = {
        buy: currentPrice.buy,
        sell: currentPrice.sell,
        fetchedAt: currentPrice.fetchedAt
      }
      return
    }
    
    // Update timestamp dan price SEBELUM broadcast dimulai
    lastBroadcastTime = now
    lastBroadcastedPrice = {
      buy: currentPrice.buy,
      sell: currentPrice.sell,
      fetchedAt: currentPrice.fetchedAt
    }
    
    // INSTANT BROADCAST - Fire and forget with error handling
    doBroadcast(finalPriceChange, currentPrice).catch(e => {
      pushLog(`❌ Broadcast promise error: ${e.message}`)
    })
    
  } catch (e) {
    // Silent fail
  }
}

setInterval(checkPriceUpdate, PRICE_CHECK_INTERVAL)

console.log(`✅ Broadcast: 50s cooldown OR new minute OR stale price (5m+)`)
console.log(`📊 Price check: every ${PRICE_CHECK_INTERVAL/1000}s (ULTRA REAL-TIME!)`)
console.log(`📊 Min price change: ±Rp${MIN_PRICE_CHANGE}`)
console.log(`⏱️  Stale price threshold: ${STALE_PRICE_THRESHOLD/60000} minutes`)
console.log(`🔧 XAU/USD cache: ${XAU_CACHE_DURATION/1000}s`)
console.log(`📅 Economic calendar: USD High-Impact (auto-hide 3hrs, WIB)`)
console.log(`⚡ Batch size: ${BATCH_SIZE} messages`)
console.log(`⚡ Batch delay: ${BATCH_DELAY}ms`)
console.log(`🌍 XAU/USD: TradingView → Investing → Google`)
console.log(`🐛 Race condition: FIXED`)
console.log(`⏰ Timestamp validation: ACTIVE\n`)

const app = express()
app.use(express.json())

app.get('/', (_req, res) => {
  res.status(200).send('✅ Bot Running')
})

app.get('/health', (_req, res) => {
  res.status(200).json({ 
    status: 'ok',
    timestamp: Date.now(),
    uptime: Math.floor(process.uptime()),
    ready: isReady,
    subscriptions: subscriptions.size,
    wsConnected: sock?.ws?.readyState === 1
  })
})

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
  const now = Date.now()
  const timeSinceLastUpdate = lastPriceUpdateTime > 0 ? now - lastPriceUpdateTime : null
  const isPriceStale = timeSinceLastUpdate ? timeSinceLastUpdate >= STALE_PRICE_THRESHOLD : false
  
  res.json({
    status: isReady ? '🟢' : '🔴',
    uptime: Math.floor(process.uptime()),
    subs: subscriptions.size,
    lastPrice: lastKnownPrice,
    lastBroadcasted: lastBroadcastedPrice,
    broadcastCount: broadcastCount,
    lastBroadcastTime: lastBroadcastTime > 0 ? new Date(lastBroadcastTime).toISOString() : null,
    timeSinceLastBroadcast: lastBroadcastTime > 0 ? Math.floor((now - lastBroadcastTime) / 1000) : null,
    lastPriceUpdateTime: lastPriceUpdateTime > 0 ? new Date(lastPriceUpdateTime).toISOString() : null,
    timeSinceLastPriceUpdate: timeSinceLastUpdate ? Math.floor(timeSinceLastUpdate / 1000) : null,
    isPriceStale: isPriceStale,
    staleThreshold: STALE_PRICE_THRESHOLD / 60000,
    cachedXAUUSD: cachedXAUUSD,
    cachedEconomicEvents: cachedEconomicEvents,
    wsConnected: sock?.ws?.readyState === 1,
    logs: logs.slice(-20)
  })
})

app.get('/calendar', async (_req, res) => {
  try {
    const events = await fetchEconomicCalendar()
    res.json({
      success: true,
      count: events?.length || 0,
      events: events || [],
      formatted: formatEconomicCalendar(events)
    })
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    })
  }
})

app.listen(PORT, () => {
  console.log(`🌐 Server: http://localhost:${PORT}`)
  console.log(`📊 Stats: http://localhost:${PORT}/stats`)
  console.log(`💊 Health: http://localhost:${PORT}/health`)
  console.log(`📅 Calendar: http://localhost:${PORT}/calendar\n`)
})

// KEEP-ALIVE SYSTEM
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 
                 process.env.RAILWAY_STATIC_URL || 
                 `http://localhost:${PORT}`

console.log(`🏓 Keep-alive target: ${SELF_URL}`)
console.log(`🏓 Keep-alive interval: 60 seconds\n`)

setInterval(async () => {
  try {
    const response = await fetch(`${SELF_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    
    if (response.ok) {
      const data = await response.json()
      pushLog(`🏓 Ping OK (uptime: ${Math.floor(data.uptime/60)}m, subs: ${data.subscriptions})`)
    } else {
      pushLog(`⚠️  Ping HTTP ${response.status}`)
    }
  } catch (e) {
    pushLog(`⚠️  Ping failed: ${e.message}`)
  }
}, 60 * 1000)

setTimeout(async () => {
  try {
    const response = await fetch(`${SELF_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    })
    if (response.ok) {
      pushLog('🏓 Initial ping successful')
    }
  } catch (e) {
    pushLog(`⚠️  Initial ping failed: ${e.message}`)
  }
}, 30000)

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
      pushLog('📱 QR ready at /qr')
    }
    
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode
      pushLog(`❌ Connection closed: ${reason}`)
      
      if (reason === DisconnectReason.loggedOut) {
        pushLog('🚪 LOGGED OUT - Manual login required')
        return
      }
      
      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        const delay = BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts)
        reconnectAttempts++
        pushLog(`🔄 Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`)
        setTimeout(() => start(), delay)
      } else {
        pushLog('❌ Max reconnect attempts reached')
      }
      
    } else if (connection === 'open') {
      lastQr = null
      reconnectAttempts = 0
      pushLog('✅ WhatsApp connected')
      
      isReady = false
      pushLog('⏳ Warming up 15s...')
      
      setTimeout(() => {
        isReady = true
        pushLog('🚀 Bot ready!')
        checkPriceUpdate()
        
        fetchEconomicCalendar().then(events => {
          if (events && events.length > 0) {
            pushLog(`📅 Loaded ${events.length} economic events`)
          }
        })
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
        
        if (/\bmulai\b|\bstart\b|\bsubscribe\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            await sock.sendMessage(sendTarget, {
              text: '✅ Sudah aktif!\n\n📢 Update otomatis saat harga berubah\n⏰ Broadcast setiap ganti menit atau per 50 detik\n📅 Termasuk kalender ekonomi USD (auto-hide 3 jam)\n⚡ Ultra real-time (1 detik check interval)'
            }, { quoted: msg })
          } else {
            subscriptions.add(sendTarget)
            pushLog(`➕ New sub: ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)

            await sock.sendMessage(sendTarget, {
              text: '🎉 Berhasil Dimulai!\n\n📢 Notifikasi otomatis saat harga berubah\n⏰ Broadcast setiap ganti menit atau per 50 detik\n📅 Termasuk kalender ekonomi USD high-impact (auto-hide 3 jam)\n⚡ Ultra real-time (1 detik check interval)\n\n_Ketik "berhenti" untuk stop._'
            }, { quoted: msg })
          }
          continue
        }

        if (/\bberhenti\b|\bunsubscribe\b|\bstop\b/.test(text)) {
          if (subscriptions.has(sendTarget)) {
            subscriptions.delete(sendTarget)
            pushLog(`➖ Unsub: ${sendTarget.substring(0, 15)} (total: ${subscriptions.size})`)
            await sock.sendMessage(sendTarget, { text: '👋 Notifikasi dihentikan.' }, { quoted: msg })
          } else {
            await sock.sendMessage(sendTarget, { text: '❌ Belum aktif.' }, { quoted: msg })
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
          const [treasury, usdIdr, xauUsd, economicEvents] = await Promise.all([
            fetchTreasury(),
            fetchUSDIDRFromGoogle(), // Only use Google Finance
            fetchXAUUSDCached(),
            fetchEconomicCalendar()
          ])
          replyText = formatMessage(treasury, usdIdr.rate, xauUsd, null, economicEvents)
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
        pushLog(`❌ Message error: ${e.message}`)
      }
    }
  })
}

start().catch(e => {
  console.error('💀 Fatal error:', e)
  process.exit(1)
})
