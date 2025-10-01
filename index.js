import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import fetch from "node-fetch"
import express from "express"
import qrcode from "qrcode"

const PORT = process.env.PORT || 8000
const app = express()

let qrString = ""
app.get("/qr", async (req, res) => {
  if (!qrString) return res.send("QR belum tersedia")
  const qrImage = await qrcode.toDataURL(qrString)
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${qrImage}"/>`)
})

app.listen(PORT, () => console.log(`🌐 Healthcheck server listen on :${PORT}`))

// Ambil harga emas dari Treasury API
async function getHargaEmas() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      }
    })
    const data = await res.json()
    const buy = data?.data?.price?.buy
    const sell = data?.data?.price?.sell

    if (!buy || !sell) return "❌ Gagal ambil harga emas"

    const jam = new Date().toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" })

    return `Harga Treasury 📊:\nBuy : Rp ${buy.toLocaleString("id-ID")}/gram\nSel : Rp ${sell.toLocaleString("id-ID")}/gram\nJam : ${jam}`
  } catch (e) {
    console.error("API Error:", e)
    return "❌ Error ambil data emas"
  }
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("session")

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  // Update koneksi
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update
    if (qr) {
      qrString = qr
      console.log("📲 QR diterima, buka http://localhost:" + PORT + "/qr untuk scan")
    }
    if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!")
    }
    if (connection === "close") {
      console.log("❌ Koneksi terputus, mencoba reconnect...")
      setTimeout(startSock, 20000)
    }
  })

  sock.ev.on("creds.update", saveCreds)

  // Pesan masuk
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0]
    if (!msg.message) return
    if (m.type !== "notify") return

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      ""

    if (text.toLowerCase() === "emas") {
      const harga = await getHargaEmas()
      await sock.sendMessage(msg.key.remoteJid, { text: harga })
    }
  })
}

startSock()
