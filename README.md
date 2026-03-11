# 💰 MyDuit — Telegram Bot Tracking Keuangan

Bot Telegram untuk mencatat saldo, pemasukan, dan pengeluaran pribadi.
Dibangun dengan **Vercel** (serverless) + **Turso** (SQLite cloud) — 100% gratis.

---

## 🚀 Cara Deploy (Step by Step)

### Langkah 1 — Buat Bot Telegram
1. Buka Telegram, cari **@BotFather**
2. Kirim `/newbot`
3. Ikuti instruksi (isi nama dan username bot)
4. Simpan **token** yang diberikan → ini `TELEGRAM_BOT_TOKEN`

---

### Langkah 2 — Buat Database di Turso
1. Daftar di [turso.tech](https://turso.tech) (gratis, pakai GitHub)
2. Install Turso CLI:
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   ```
3. Login:
   ```bash
   turso auth login
   ```
4. Buat database:
   ```bash
   turso db create myduit-db
   ```
5. Ambil URL database:
   ```bash
   turso db show myduit-db --url
   # Contoh output: libsql://myduit-db-username.turso.io
   ```
6. Buat auth token:
   ```bash
   turso db tokens create myduit-db
   ```
7. Simpan URL dan token → ini `TURSO_DATABASE_URL` dan `TURSO_AUTH_TOKEN`

---

### Langkah 3 — Deploy ke Vercel
1. Push project ini ke GitHub
2. Buka [vercel.com](https://vercel.com), login, klik **"Add New Project"**
3. Import repo dari GitHub
4. Di bagian **Environment Variables**, tambahkan:
   ```
   TELEGRAM_BOT_TOKEN  = (token dari BotFather)
   TURSO_DATABASE_URL  = (url dari Turso)
   TURSO_AUTH_TOKEN    = (token dari Turso)
   ```
5. Klik **Deploy**
6. Setelah deploy, salin URL project → contoh: `https://myduit-bot.vercel.app`

---

### Langkah 4 — Daftarkan Webhook ke Telegram
Buka browser atau gunakan curl, akses URL berikut (ganti `TOKEN` dan `URL`):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<URL_VERCEL>/api/webhook
```

Contoh:
```
https://api.telegram.org/bot123456:ABC-xyz/setWebhook?url=https://myduit-bot.vercel.app/api/webhook
```

Kalau berhasil, Telegram akan membalas:
```json
{"ok": true, "description": "Webhook was set"}
```

---

## ✅ Cek Webhook Aktif

```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

---

## 🤖 Fitur Bot

| Perintah | Fungsi |
|---|---|
| `/start` | Mulai bot & lihat menu |
| `/tambahbank` | Tambah rekening baru + saldo awal |
| `/saldo` | Lihat saldo semua rekening |
| `/catat` | Catat pemasukan atau pengeluaran |
| `/riwayat` | Lihat 10 transaksi terakhir |
| `/hapusbank` | Hapus rekening beserta riwayatnya |

**Format nominal yang didukung:**
- `50000` → Rp50.000
- `50rb` atau `50k` → Rp50.000
- `1jt` → Rp1.000.000
- `1.5jt` → Rp1.500.000

---

## 🗂 Struktur Project

```
myduit/
├── api/
│   └── webhook.js      ← Vercel serverless function (otak bot)
├── lib/
│   ├── db.js           ← Koneksi & query Turso database
│   └── format.js       ← Helper format Rupiah & tanggal
├── .env.example        ← Template environment variables
├── package.json
├── vercel.json
└── README.md
```

---

## 🔧 Development Lokal

```bash
# Install dependencies
npm install

# Salin env
cp .env.example .env.local
# Isi nilai di .env.local

# Jalankan lokal
npx vercel dev

# Gunakan ngrok untuk expose localhost ke internet
npx ngrok http 3000
# Lalu set webhook ke URL ngrok
```

---

## 📦 Tech Stack

| Teknologi | Fungsi | Harga |
|---|---|---|
| Telegram Bot API | Platform bot | Gratis |
| Vercel Serverless | Hosting & webhook handler | Gratis (100k req/bulan) |
| Turso (SQLite) | Database cloud | Gratis (9GB storage) |
| grammy | Library bot Telegram | Open source |
| @libsql/client | Koneksi Turso | Open source |
