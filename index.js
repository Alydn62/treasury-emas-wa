import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import fetch from "node-fetch"
import express from "express"

const app = express()
const PORT = process.env.PORT || 8000

// Endpoint healthcheck + QR
let latestQR = null
app.get("/", (req, res) => res.send("Bot is running"))
app.get("/qr", (req, res) => {
    if (!latestQR) return res.send("QR belum tersedia, cek terminal")
    res.send(`<img src="https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(latestQR)}"/>`)
})
app.listen(PORT, () => console.log(`🌐 Server listen on :${PORT}`))

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("session")
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true
    })

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update
        if (qr) {
            latestQR = qr
            console.log("📲 QR diterima, buka /qr untuk scan")
        }
        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode
            if (reason !== DisconnectReason.loggedOut) {
                console.log("❌ Koneksi terputus, mencoba reconnect...")
                startBot()
            } else {
                console.log("❌ Anda logout, scan ulang QR.")
            }
        }
        if (connection === "open") {
            console.log("✅ Bot WhatsApp siap!")
        }
    })

    sock.ev.on("creds.update", saveCreds)

    // Fungsi ambil harga emas
    async function getHargaEmas() {
        try {
            const res = await fetch("https://api.treasury.id/api/v1/antigrvty/gold/rate", { method: "POST" })
            const json = await res.json()
            if (json?.meta?.code === 200) {
                const data = json.data
                return `📊 Harga Treasury 🇮🇩 :
💰 Buy : Rp ${data.buying_rate.toLocaleString("id-ID")}
💸 Sel : Rp ${data.selling_rate.toLocaleString("id-ID")}
🕒 Jam : ${data.updated_at}`
            } else {
                return "❌ Gagal ambil harga emas"
            }
        } catch (e) {
            return "❌ Error fetch harga emas"
        }
    }

    // Event pesan masuk
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0]
        if (!msg.message) return

        const pesan = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase()
        const from = msg.key.remoteJid // <<--- target balasan selalu ke pengirim/grup
        const isMe = msg.key.fromMe // apakah pesan dari diri sendiri

        console.log("📨 Pesan masuk dari", from, ":", pesan)

        // Hanya balas kalau bukan dari diri sendiri
        if (!isMe && pesan.includes("emas")) {
            const reply = await getHargaEmas()
            await sock.sendMessage(from, { text: reply })
        }
    })
}

startBot()
