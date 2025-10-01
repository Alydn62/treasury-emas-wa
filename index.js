import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import fetch from "node-fetch"
import express from "express"
import qrcode from "qrcode"

const app = express()
let latestQR = null
let msgCounter = 0

// ====== QR Page ======
app.get("/qr", (req, res) => {
  if (!latestQR) {
    return res.send("📭 QR belum tersedia, tunggu koneksi WA...")
  }
  qrcode.toDataURL(latestQR, (err, url) => {
    if (err) return res.send("❌ Error generate QR")
    res.send(`
      <h3>Scan QR dengan WhatsApp</h3>
      <img src="${url}" style="width:300px"/>
    `)
  })
})

app.listen(8000, () => {
  console.log("🌐 Healthcheck server listen on :8000")
})

// ====== Ambil Harga Treasury ======
async function getGoldPrice() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    })
    const json = await res.json()
    if (json?.data) {
      const { buying_rate, selling_rate, updated_at } = json.data
      return `Harga Treasury 📊 :\nBuy : Rp ${buying_rate.toLocaleString("id-ID")}\nSel : Rp ${selling_rate.toLocaleString("id-ID")}\nJam : ${updated_at}`
    } else {
      return "❌ Data harga emas tidak tersedia."
    }
  } catch (err) {
    console.error("API Error:", err)
    return "❌ Gagal ambil harga emas"
  }
}

// ====== Mulai Bot ======
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")

  const sock = makeWASocket({
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { qr, connection } = update
    if (qr) {
      latestQR = qr
      console.log("📲 QR diterima, buka /qr untuk scan")
    }
    if (connection === "open") {
      console.log("✅ Bot WhatsApp siap!")
    } else if (connection === "close") {
      console.log("❌ Koneksi terputus, mencoba reconnect...")
      startBot()
    }
  })

  // ====== Listener Pesan Masuk ======
  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages[0]
      if (!msg.message) return

      const sender = msg.key.remoteJid
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase()

      console.log("📨 Pesan masuk dari", sender, ":", text)

      // Hanya balas sekali per pesan
      if (text.includes("emas")) {
        const reply = await getGoldPrice()
        await sock.sendMessage(sender, { text: reply })
      }

      // Clear log tiap 100 pesan
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

startBot()
