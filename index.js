import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import express from "express"
import fetch from "node-fetch"
import qrcode from "qrcode"

const app = express()
let qrString = ""

// === API Treasury: Ambil Harga Emas ===
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

    const buy = data?.data?.buying_rate || null
    const sell = data?.data?.selling_rate || null
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

// === Mulai WhatsApp Bot ===
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })

  // QR Code muncul di /qr
  sock.ev.on("connection.update", async (update) => {
    const { connection, qr } = update
    if (qr) {
      qrString = await qrcode.toDataURL(qr)
      console.log("📲 QR diterima, buka http://localhost:8000/qr untuk scan")
    }
    if (connection === "close") {
      console.log("❌ Koneksi terputus, mencoba reconnect...")
      startBot()
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!")
    }
  })

  sock.ev.on("creds.update", saveCreds)

  // === Tangani pesan masuk ===
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return
    if (msg.key.fromMe) return // hindari balas pesan bot sendiri

    const from = msg.key.remoteJid
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || ""

    console.log(`📨 Pesan masuk dari ${from}: ${text}`)

    if (text.toLowerCase().includes("emas")) {
      const reply = await getHargaEmas()
      await sock.sendMessage(from, { text: reply }, { quoted: msg })
    }
  })
}

// === Web server untuk QR ===
app.get("/qr", (req, res) => {
  if (!qrString) {
    return res.send("❌ QR belum tersedia, tunggu sebentar...")
  }
  res.send(`<img src="${qrString}" style="width:300px"/>`)
})

app.listen(8000, () => {
  console.log("🌐 Healthcheck server listen on :8000")
})

startBot()
