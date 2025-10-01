import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import express from "express"
import P from "pino"

// ========== EXPRESS UNTUK QR ==========
const app = express()
let qrCodeImage = null

app.get("/qr", (req, res) => {
  if (qrCodeImage) {
    res.type("html").send(`<h2>Scan QR WhatsApp</h2><img src="${qrCodeImage}" />`)
  } else {
    res.send("QR belum tersedia atau sudah discan.")
  }
})

app.get("/", (req, res) => {
  res.send("🌐 WhatsApp Bot Treasury Emas Aktif")
})

app.listen(8000, () => console.log("🌐 Healthcheck server listen on :8000"))

// ========== FUNCTION START WA ==========
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: "silent" })
  })

  // Handle QR
  sock.ev.on("connection.update", (update) => {
    const { qr, connection, lastDisconnect } = update
    if (qr) {
      console.log("📲 QR diterima, buka http://localhost:8000/qr untuk scan")
      // ubah jadi data:image/png untuk QR di /qr
      import("qrcode").then(QR => {
        QR.toDataURL(qr, (err, url) => {
          if (!err) qrCodeImage = url
        })
      })
    }
    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("connection closed. reconnect:", shouldReconnect)
      if (shouldReconnect) startBot()
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp siap dengan Baileys!")
    }
  })

  // Simpan sesi
  sock.ev.on("creds.update", saveCreds)

  // Listener Pesan
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0]
    if (!msg.message) return

    const from = msg.key.remoteJid
    const pesan = msg.message.conversation || msg.message.extendedTextMessage?.text || ""

    console.log("📨", from, pesan)

    // Balas kalau pesan mengandung kata "Emas"
    if (pesan.toLowerCase().includes("emas")) {
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

        const buy = data?.data?.price?.buy ?? "-"
        const sell = data?.data?.price?.sell ?? "-"

        const reply = `📊 Harga Emas Treasury:\n💰 Buy: Rp ${buy}/gram\n💸 Sell: Rp ${sell}/gram`

        await sock.sendMessage(from, { text: reply }, { quoted: msg })
      } catch (err) {
        console.error("❌ Gagal ambil harga emas:", err)
        await sock.sendMessage(from, { text: "⚠️ Gagal ambil harga emas" }, { quoted: msg })
      }
    }
  })
}

// ========== JALANKAN ==========
startBot()
