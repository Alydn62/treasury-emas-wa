import makeWASocket, { useMultiFileAuthState } from "@whiskeysockets/baileys"
import fetch from "node-fetch"
import express from "express"

const app = express()
app.get("/qr", (req, res) => {
  res.sendFile(process.cwd() + "/qr.html")
})
app.listen(8000, () => {
  console.log("🌐 Healthcheck server listen on :8000")
})

/**
 * Fungsi ambil harga emas dari API Treasury
 */
async function getHargaEmas() {
  try {
    const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    })
    const json = await res.json()

    if (json?.meta?.code !== 200) {
      return "❌ Gagal ambil harga emas"
    }

    const { buying_rate, selling_rate, updated_at } = json.data

    return `Harga Treasury 📊
💰 Buy  : Rp ${buying_rate.toLocaleString("id-ID")}/gram
💸 Sell : Rp ${selling_rate.toLocaleString("id-ID")}/gram
⏰ Jam  : ${updated_at}`
  } catch (err) {
    console.error("❌ Error API:", err)
    return "❌ Error ambil data emas"
  }
}

/**
 * Jalankan WhatsApp Bot
 */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")

  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ["Ubuntu", "Chrome", "22.04.4"],
  })

  sock.ev.on("creds.update", saveCreds)

  let msgCount = 0

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message) return

    const from = msg.key.remoteJid
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    console.log(`📨 Pesan masuk dari ${from}: ${text}`)

    // Filter pesan emas
    if (text.toLowerCase().includes("emas")) {
      const reply = await getHargaEmas()

      await sock.sendMessage(from, { text: reply }, { quoted: msg })
      console.log("✅ Balasan terkirim ke:", from)
    }

    // Auto clear log tiap 100 pesan
    msgCount++
    if (msgCount >= 100) {
      console.clear()
      console.log("🧹 Log dibersihkan otomatis")
      msgCount = 0
    }
  })

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update
    if (connection === "close") {
      console.log("❌ Koneksi terputus, mencoba reconnect...")
      startBot()
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!")
    }
  })
}

startBot()
