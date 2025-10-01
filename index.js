import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import express from "express"
import fetch from "node-fetch"
import pino from "pino"

const PORT = process.env.PORT || 8000
let msgCounter = 0

// Fungsi ambil harga emas dari API Treasury
async function getGoldPrice() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", { method: "POST" })
    const json = await res.json()
    if (json?.meta?.code === 200) {
      const data = json.data
      return `Harga Treasury 📊 :
Buy : Rp ${data.buying_rate.toLocaleString("id-ID")}
Sel : Rp ${data.selling_rate.toLocaleString("id-ID")}
Jam : ${data.updated_at}`
    } else {
      return "❌ Gagal ambil harga emas"
    }
  } catch (e) {
    console.error("❌ Error fetch API:", e)
    return "❌ Gagal ambil harga emas"
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const sock = makeWASocket({
    printQRInTerminal: false,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  })

  // QR ditampilkan di /qr
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      latestQR = qr
      console.log("📲 QR diterima, buka /qr untuk scan")
    }
    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("❌ Koneksi terputus,", shouldReconnect ? "reconnect..." : "logout.")
      if (shouldReconnect) startBot()
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap!")
    }
  })

  sock.ev.on("creds.update", saveCreds)

  // Handler pesan masuk
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0]
      if (!msg.message) return

      // skip pesan dari diri sendiri
      if (msg.key.fromMe) return

      const sender = msg.key.remoteJid
      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""

      console.log("📨 Pesan masuk dari", sender, ":", text)

      if (text.toLowerCase().includes("emas")) {
        const reply = await getGoldPrice()
        await sock.sendMessage(sender, { text: reply })
      }

      // log reset setiap 100 pesan
      msgCounter++
      if (msgCounter >= 100) {
        console.clear()
        msgCounter = 0
        console.log("🧹 Log dibersihkan")
      }
    } catch (err) {
      console.error("❌ Error handle message:", err)
    }
  })
}

// ====== HTTP Server untuk QR Scan ======
let latestQR = null
const app = express()
app.get("/qr", (req, res) => {
  if (latestQR) {
    res.send(`<pre>${latestQR}</pre>`)
  } else {
    res.send("Bot is running")
  }
})
app.listen(PORT, () => {
  console.log(`🌐 Healthcheck server listen on :${PORT}`)
})

// Start bot
startBot()
