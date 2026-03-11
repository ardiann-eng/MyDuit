// api/webhook.js
import { Bot, InlineKeyboard, session } from "grammy";
import { initDB, upsertUser, addAccount, getAccounts,
         getAccountById, deleteAccount, addTransaction,
         getRecentTransactions } from "../lib/db.js";
import { formatRupiah, formatDate, esc } from "../lib/format.js";
// ── INISIALISASI BOT ───────────────────────────────────────────
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Session in-memory (per request, cukup untuk conversation state)
// Untuk persistent session, bisa upgrade ke Turso session storage
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

function clearSession(chatId) {
  sessions.set(chatId, {});
}

// ── HELPER ────────────────────────────────────────────────────
function parseNominal(text) {
  // Support: "50000", "50rb", "50k", "1jt", "1.5jt"
  const clean = text.toLowerCase().trim().replace(/\./g, "").replace(/,/g, ".");
  if (clean.endsWith("jt"))  return parseFloat(clean) * 1_000_000;
  if (clean.endsWith("rb") || clean.endsWith("k")) return parseFloat(clean) * 1_000;
  return parseFloat(clean);
}

function isValidNominal(val) {
  return !isNaN(val) && val > 0;
}

// ── /start ────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const name = ctx.from.first_name || "Pengguna";
  await upsertUser(ctx.from.id, name);
  clearSession(ctx.chat.id);

  await ctx.reply(
    `👋 *Halo, ${esc(name)}\\!*\n\n` +
    `Selamat datang di *MyDuit* 💰\n` +
    `Bot pribadimu untuk mencatat saldo & transaksi keuangan\\.\n\n` +
    `*Menu Utama:*\n` +
    `🏦 /tambahbank — Tambah rekening baru\n` +
    `💳 /saldo — Lihat saldo semua rekening\n` +
    `📝 /catat — Catat pemasukan / pengeluaran\n` +
    `📋 /riwayat — 10 transaksi terakhir\n` +
    `🗑 /hapusbank — Hapus rekening\n\n` +
    `_Mulai dengan menambahkan rekening bankmu\\!_`,
    { parse_mode: "MarkdownV2" }
  );
});

// ── /tambahbank ───────────────────────────────────────────────
bot.command("tambahbank", async (ctx) => {
  clearSession(ctx.chat.id);
  getSession(ctx.chat.id).step = "tambahbank_nama";

  await ctx.reply(
    `🏦 *Tambah Rekening Baru*\n\n` +
    `Ketik nama bank atau dompet digitalmu\\.\n` +
    `_Contoh: BCA, Mandiri, GoPay, OVO, Dana_`,
    { parse_mode: "MarkdownV2" }
  );
});

// ── /saldo ────────────────────────────────────────────────────
bot.command("saldo", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);

  if (accounts.length === 0) {
    return ctx.reply(
      `💳 Belum ada rekening tercatat\\.\n\nGunakan /tambahbank untuk menambahkan rekening pertamamu\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  let total = 0;
  let text = `💰 *Saldo Rekening MyDuit*\n`;
  text += `─────────────────────\n`;

  for (const acc of accounts) {
    const icon = acc.balance >= 0 ? "🟢" : "🔴";
    text += `${icon} *${esc(acc.bank_name)}*\n`;
    text += `    ${esc(formatRupiah(acc.balance))}\n\n`;
    total += acc.balance;
  }

  text += `─────────────────────\n`;
  text += `📊 *Total Semua Rekening*\n`;
  text += `*${esc(formatRupiah(total))}*`;

  await ctx.reply(text, { parse_mode: "MarkdownV2" });
});

// ── /catat ────────────────────────────────────────────────────
bot.command("catat", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);

  if (accounts.length === 0) {
    return ctx.reply(
      `⚠️ Belum ada rekening\\. Tambah dulu dengan /tambahbank`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // Tampilkan pilihan rekening sebagai inline keyboard
  const keyboard = new InlineKeyboard();
  for (const acc of accounts) {
    keyboard.text(
      `${acc.bank_name} (${formatRupiah(acc.balance)})`,
      `catat_akun_${acc.id}`
    ).row();
  }

  getSession(ctx.chat.id).step = "catat_pilih_akun";

  await ctx.reply(
    `📝 *Catat Transaksi*\n\nPilih rekening:`,
    { parse_mode: "MarkdownV2", reply_markup: keyboard }
  );
});

// ── /riwayat ──────────────────────────────────────────────────
bot.command("riwayat", async (ctx) => {
  clearSession(ctx.chat.id);
  const txs = await getRecentTransactions(ctx.from.id, 10);

  if (txs.length === 0) {
    return ctx.reply(
      `📋 Belum ada transaksi tercatat\\.\n\nGunakan /catat untuk mencatat transaksi pertama\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  let text = `📋 *10 Transaksi Terakhir*\n`;
  text += `─────────────────────\n`;

  for (const tx of txs) {
    const icon  = tx.type === "masuk" ? "⬆️" : "⬇️";
    const sign  = tx.type === "masuk" ? "\\+" : "\\-";
    const color = tx.type === "masuk" ? "" : "";
    text += `${icon} ${sign}${esc(formatRupiah(tx.amount))}\n`;
    text += `   📂 ${esc(tx.bank_name)}`;
    if (tx.note) text += ` • _${esc(tx.note)}_`;
    text += `\n   🕐 ${esc(formatDate(tx.created_at))}\n\n`;
  }

  await ctx.reply(text, { parse_mode: "MarkdownV2" });
});

// ── /hapusbank ────────────────────────────────────────────────
bot.command("hapusbank", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);

  if (accounts.length === 0) {
    return ctx.reply(`⚠️ Tidak ada rekening untuk dihapus\\.`, { parse_mode: "MarkdownV2" });
  }

  const keyboard = new InlineKeyboard();
  for (const acc of accounts) {
    keyboard.text(`🗑 ${acc.bank_name}`, `hapus_${acc.id}`).row();
  }
  keyboard.text("❌ Batal", "batal");

  await ctx.reply(
    `🗑 *Hapus Rekening*\n\n⚠️ Semua transaksi di rekening tersebut juga akan terhapus\\.\n\nPilih rekening yang ingin dihapus:`,
    { parse_mode: "MarkdownV2", reply_markup: keyboard }
  );
});

// ── CALLBACK QUERY HANDLER ────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const sess = getSession(chatId);

  await ctx.answerCallbackQuery();

  // Batal
  if (data === "batal") {
    clearSession(chatId);
    return ctx.editMessageText("❌ Dibatalkan\\.", { parse_mode: "MarkdownV2" });
  }

  // ── Hapus rekening ──────────────────────────────────────────
  if (data.startsWith("hapus_")) {
    const accId = parseInt(data.replace("hapus_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    const keyboard = new InlineKeyboard()
      .text("✅ Ya, Hapus", `konfirmhapus_${accId}`)
      .text("❌ Batal", "batal");

    return ctx.editMessageText(
      `⚠️ *Konfirmasi Hapus*\n\nApakah kamu yakin ingin menghapus rekening *${esc(acc.bank_name)}*?\nSaldo: ${esc(formatRupiah(acc.balance))}`,
      { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
  }

  if (data.startsWith("konfirmhapus_")) {
    const accId = parseInt(data.replace("konfirmhapus_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    await deleteAccount(accId, ctx.from.id);
    return ctx.editMessageText(
      `✅ Rekening *${esc(acc.bank_name)}* berhasil dihapus\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // ── Pilih akun saat /catat ──────────────────────────────────
  if (data.startsWith("catat_akun_")) {
    const accId = parseInt(data.replace("catat_akun_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    sess.step = "catat_pilih_tipe";
    sess.accountId = accId;
    sess.accountName = acc.bank_name;

    const keyboard = new InlineKeyboard()
      .text("⬆️ Pemasukan", "catat_tipe_masuk")
      .text("⬇️ Pengeluaran", "catat_tipe_keluar");

    return ctx.editMessageText(
      `📝 Rekening: *${esc(acc.bank_name)}*\nSaldo saat ini: *${esc(formatRupiah(acc.balance))}*\n\nJenis transaksi?`,
      { parse_mode: "MarkdownV2", reply_markup: keyboard }
    );
  }

  // ── Pilih tipe transaksi ────────────────────────────────────
  if (data === "catat_tipe_masuk" || data === "catat_tipe_keluar") {
    const tipe = data === "catat_tipe_masuk" ? "masuk" : "keluar";
    sess.step = "catat_nominal";
    sess.type = tipe;

    const icon = tipe === "masuk" ? "⬆️ Pemasukan" : "⬇️ Pengeluaran";
    return ctx.editMessageText(
      `${icon} ke *${esc(sess.accountName)}*\n\nKetik nominal transaksi:\n_Contoh: 50000 / 50rb / 1jt_`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── TEXT MESSAGE HANDLER ──────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const sess = getSession(chatId);

  // ── Tambah bank: input nama ─────────────────────────────────
  if (sess.step === "tambahbank_nama") {
    sess.bankName = text;
    sess.step = "tambahbank_saldo";
    return ctx.reply(
      `💳 Nama rekening: *${esc(text)}*\n\nSekarang ketik *saldo awal* rekening ini:\n_Contoh: 500000 / 500rb / 2jt_`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // ── Tambah bank: input saldo awal ───────────────────────────
  if (sess.step === "tambahbank_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) {
      return ctx.reply(
        `⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`,
        { parse_mode: "MarkdownV2" }
      );
    }

    await addAccount(ctx.from.id, sess.bankName, nominal);
    clearSession(chatId);

    return ctx.reply(
      `✅ *Rekening Berhasil Ditambahkan\\!*\n\n` +
      `🏦 Bank: *${esc(sess.bankName)}*\n` +
      `💰 Saldo Awal: *${esc(formatRupiah(nominal))}*\n\n` +
      `Gunakan /catat untuk mulai mencatat transaksi\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // ── Catat: input nominal ─────────────────────────────────────
  if (sess.step === "catat_nominal") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) {
      return ctx.reply(
        `⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 50000 / 50rb / 1jt_`,
        { parse_mode: "MarkdownV2" }
      );
    }

    sess.amount = nominal;
    sess.step = "catat_keterangan";

    const icon = sess.type === "masuk" ? "⬆️ Pemasukan" : "⬇️ Pengeluaran";
    return ctx.reply(
      `${icon}: *${esc(formatRupiah(nominal))}*\n\nTambahkan keterangan \\(opsional\\):\n_Contoh: Gaji, Makan siang, Belanja_\n\nAtau ketik /skip untuk lewati`,
      { parse_mode: "MarkdownV2" }
    );
  }

  // ── Catat: input keterangan ──────────────────────────────────
  if (sess.step === "catat_keterangan") {
    const note = text === "/skip" ? "" : text;
    await addTransaction(ctx.from.id, sess.accountId, sess.type, sess.amount, note);

    // Ambil saldo terbaru
    const acc = await getAccountById(sess.accountId, ctx.from.id);
    const icon = sess.type === "masuk" ? "⬆️" : "⬇️";
    const label = sess.type === "masuk" ? "Pemasukan" : "Pengeluaran";

    clearSession(chatId);

    return ctx.reply(
      `✅ *Transaksi Dicatat\\!*\n\n` +
      `${icon} ${label}: *${esc(formatRupiah(sess.amount))}*\n` +
      `🏦 Rekening: *${esc(acc.bank_name)}*\n` +
      (note ? `📝 Keterangan: _${esc(note)}_\n` : "") +
      `\n💰 Saldo terkini: *${esc(formatRupiah(acc.balance))}*`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── VERCEL HANDLER ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ status: "MyDuit Bot is running 💰" });
  }

  try {
    await initDB();
    await bot.init();
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(200).json({ ok: false }); // Selalu 200 agar Telegram tidak retry
  }
}
