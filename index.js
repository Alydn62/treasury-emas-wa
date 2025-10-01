import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import fetch from "node-fetch"
import express from "express"
import qrcode from "qrcode"

const app = express()
let qrCodeData = ""

// === Ambil harga emas dari Treasury ===
async function getHargaEmas() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json"
      },
      body: "{}"
    })

    const data = await res.json()
    console.log("🔍 Data API Treasury:", JSON.stringify(data, null, 2))

    // Cari harga Buy / Sell di beberapa kemungkinan struktur JSON
    const buy =
      data?.data?.buy ||
      data?.data?.price?.buy ||
      data?.price?.buy ||
      data?.buy ||
      null

    const sell =
      data?.data?.sell ||
      data?.data?.price?.sell ||
      data?.price?.sell ||
      data?.sell ||
      null

    if (!buy || !sell) return "❌ Gagal ambil harga emas"

    const jam = new Date().toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })

    return `Harga Treasury 📊 :\nBuy : Rp ${Number(buy).toLocaleString("id-ID")}/gram\nSel : Rp ${Number(sell).toLocaleString("id-ID")}/gram\nJam : ${jam}`
  } catch (err) {
    console.error("API Error:", err)
    return "❌ Error ambil data emas"
  }
}

// === Bot WhatsApp ===
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  // Update koneksi / QR
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update
    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr)
      console.log("📲 QR diterima, buka http://localhost:8000/qr untuk scan")
    }
    if (connection === "close") {
      console.log("❌ Koneksi terputus, mencoba reconnect...")
      setTimeout(startBot, 20000) // auto reconnect 20 detik
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!")
    }
  })

  sock.ev.on("creds.update", saveCreds)

  // Listener pesan
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const from = msg.key.remoteJid
    const pesan =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      ""

    console.log("📨 Pesan masuk:", from, pesan)

    // Balas hanya untuk keyword "emas"
    if (pesan && pesan.toLowerCase().trim() === "emas") {
      const harga = await getHargaEmas()
      await sock.sendMessage(from, { text: harga })
    }
  })
}

startBot()

// === Web server untuk QR ===
app.get("/qr", (req, res) => {
  if (!qrCodeData) return res.send("Belum ada QR, tunggu sebentar...")
  res.send(`<h2>Scan QR WhatsApp</h2><img src="${qrCodeData}" />`)
})

app.listen(8000, () => console.log("🌐 Healthcheck server listen on :8000"))
