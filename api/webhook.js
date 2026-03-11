// api/webhook.js
import { Bot, InlineKeyboard } from "grammy";
import {
  initDB, upsertUser, addAccount, getAccounts,
  getAccountById, deleteAccount, addTransaction,
  getRecentTransactions, addCustomCategory, getCustomCategories,
  getUserSettings, updateDailyLimit, getDailySpend, getWeeklySpend,
  getAlertLog, logAlert, getTransactionsByDateRange,
  getTransactionsForCurrentMonth, getTransactionsForCurrentWeek
} from "../lib/db.js";
import { formatRupiah, formatDate, esc } from "../lib/format.js";

// ── INISIALISASI BOT ───────────────────────────────────────────
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Session in-memory
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) sessions.set(chatId, {});
  return sessions.get(chatId);
}

function clearSession(chatId) {
  sessions.set(chatId, {});
}

// ── CONSTANTS ─────────────────────────────────────────────────
const defaultExpenseCategories = [
  "🍔 Makanan", "🥤 Minuman", "🚗 Transport", "👗 Gaya Hidup",
  "🏠 Tagihan", "🎮 Hiburan", "💊 Kesehatan", "📦 Lainnya"
];

const defaultIncomeSources = [
  "💼 Gaji", "💰 Bonus", "🤝 Freelance", "📈 Investasi",
  "🏪 Usaha", "🎁 Hadiah", "📦 Lainnya"
];

// ── HELPER ────────────────────────────────────────────────────
function parseNominal(text) {
  const clean = text.toLowerCase().trim().replace(/\./g, "").replace(/,/g, ".");
  if (clean.endsWith("jt")) return parseFloat(clean) * 1_000_000;
  if (clean.endsWith("rb") || clean.endsWith("k")) return parseFloat(clean) * 1_000;
  return parseFloat(clean);
}

function isValidNominal(val) {
  return !isNaN(val) && val > 0;
}

// ── SMART ALERT SYSTEM ─────────────────────────────────────────
async function checkAndSendAlerts(ctx, telegramId) {
  try {
    const todaySpend = await getDailySpend(telegramId);
    const settings = await getUserSettings(telegramId);

    // Alert 1: Daily Overspend
    let dailyLimit = settings.daily_limit;
    if (!dailyLimit || dailyLimit === 0) {
      const last30 = await getTransactionsByDateRange(telegramId, 'keluar', 30);
      const sum30 = last30.reduce((acc, tx) => acc + tx.amount, 0);
      const avg30 = sum30 / 30;
      dailyLimit = avg30 * 1.5;
    }

    if (dailyLimit > 0 && todaySpend > dailyLimit) {
      const alertedText = `daily_overspend_${new Date().toISOString().split('T')[0]}`;
      const hasAlerted = await getAlertLog(telegramId, alertedText);
      if (!hasAlerted) {
        await logAlert(telegramId, alertedText);
        await ctx.reply(
          `⚠️ *Alert Pengeluaran Harian\\!*\n` +
          `Pengeluaran hari ini: *${esc(formatRupiah(todaySpend))}*\n` +
          `Batas harian kamu: *${esc(formatRupiah(dailyLimit))}*\n` +
          `Kamu sudah melebihi batas *${esc(formatRupiah(dailyLimit))}*`,
          { parse_mode: "MarkdownV2" }
        );
      }
    }

    // Alert 2: Low balance
    const accounts = await getAccounts(telegramId);
    for (const acc of accounts) {
      if (acc.initial_balance > 0 && acc.balance < acc.initial_balance * 0.2) {
        const alertedText = `low_balance_${acc.id}_${new Date().toISOString().split('T')[0]}`;
        const hasAlerted = await getAlertLog(telegramId, alertedText);
        if (!hasAlerted) {
          await logAlert(telegramId, alertedText);
          const pct = Math.round((acc.balance / acc.initial_balance) * 100);
          await ctx.reply(
            `🔴 *Saldo Menipis\\!*\n` +
            `Rekening *${esc(acc.bank_name)}*: *${esc(formatRupiah(acc.balance))}*\n` +
            `Hanya tersisa ${esc(pct.toString())}% dari saldo awal`,
            { parse_mode: "MarkdownV2" }
          );
        }
      }
    }

    // Alert 3: Weekly overspend
    const thisWeek = await getWeeklySpend(telegramId, 0);
    const lastWeek = await getWeeklySpend(telegramId, 1);

    if (lastWeek > 0 && thisWeek > lastWeek * 1.2) {
      const weeklyAlertText = `weekly_overspend_${new Date().toISOString().split('T')[0]}`;
      const hasAlerted = await getAlertLog(telegramId, weeklyAlertText);
      if (!hasAlerted) {
        await logAlert(telegramId, weeklyAlertText);
        const limitStr = Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
        await ctx.reply(
          `📊 *Pengeluaran Minggu Ini Melonjak\\!*\n` +
          `Minggu ini: *${esc(formatRupiah(thisWeek))}*\n` +
          `Minggu lalu: *${esc(formatRupiah(lastWeek))}*\n` +
          `Naik ${esc(limitStr.toString())}% — coba lebih hemat ya\\!`,
          { parse_mode: "MarkdownV2" }
        );
      }
    }
  } catch (err) {
    console.error("Alert Error:", err);
  }
}

// ── COMMANDS MAIN ─────────────────────────────────────────────
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
    `*Fitur Pintar:*\n` +
    `🏷 /tambahkategori — Buat kategori pengeluaran\n` +
    `🔮 /prediksi — Prediksi saldo habis & tren belanja\n` +
    `⚠️ /setlimit — Atur batas pengeluaran harian\n` +
    `📊 /laporanminggu — Laporan pengeluaran minggu ini\n` +
    `📑 /laporanbulan — Laporan bulan ini\n`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.command("saldo", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`💳 Belum ada rekening tercatat\\.\n\nGunakan /tambahbank untuk menambahkan rekening pertamamu\\.`, { parse_mode: "MarkdownV2" });

  let total = 0;
  let text = `💰 *Saldo Rekening MyDuit*\n─────────────────────\n`;
  for (const acc of accounts) {
    const icon = acc.balance >= 0 ? "🟢" : "🔴";
    text += `${icon} *${esc(acc.bank_name)}*\n    ${esc(formatRupiah(acc.balance))}\n\n`;
    total += acc.balance;
  }
  text += `─────────────────────\n📊 *Total Semua Rekening*\n*${esc(formatRupiah(total))}*`;
  await ctx.reply(text, { parse_mode: "MarkdownV2" });
});

bot.command("riwayat", async (ctx) => {
  clearSession(ctx.chat.id);
  const txs = await getRecentTransactions(ctx.from.id, 10);
  if (txs.length === 0) return ctx.reply(`📋 Belum ada transaksi tercatat\\.\n\nGunakan /catat untuk mencatat transaksi pertama\\.`, { parse_mode: "MarkdownV2" });

  let text = `📋 *10 Transaksi Terakhir*\n─────────────────────\n`;
  for (const tx of txs) {
    const icon = tx.type === "masuk" ? "⬆️" : "⬇️";
    const sign = tx.type === "masuk" ? "\\+" : "\\-";
    const label = tx.type === "masuk" ? tx.source || "" : tx.category || "";

    text += `${icon} ${sign}${esc(formatRupiah(tx.amount))}\n`;
    text += `   📂 ${esc(tx.bank_name)} ` + (label ? `\\- ${esc(label)}` : "");
    if (tx.note) text += ` • _${esc(tx.note)}_`;
    text += `\n   🕐 ${esc(formatDate(tx.created_at))}\n\n`;
  }
  await ctx.reply(text, { parse_mode: "MarkdownV2" });
});

bot.command("hapusbank", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`⚠️ Tidak ada rekening untuk dihapus\\.`, { parse_mode: "MarkdownV2" });

  const keyboard = new InlineKeyboard();
  for (const acc of accounts) {
    keyboard.text(`🗑 ${acc.bank_name}`, `hapus_${acc.id}`).row();
  }
  keyboard.text("❌ Batal", "batal");
  await ctx.reply(`🗑 *Hapus Rekening*\n\n⚠️ Semua transaksi di rekening tersebut juga akan terhapus\\.\n\nPilih rekening yang ingin dihapus:`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
});

bot.command("tambahbank", async (ctx) => {
  clearSession(ctx.chat.id);
  getSession(ctx.chat.id).step = "tambahbank_nama";
  await ctx.reply(`🏦 *Tambah Rekening Baru*\n\nKetik nama bank atau dompet digitalmu\\.\n_Contoh: BCA, Mandiri, GoPay, Dana_`, { parse_mode: "MarkdownV2" });
});

bot.command("tambahkategori", async (ctx) => {
  clearSession(ctx.chat.id);
  getSession(ctx.chat.id).step = "tambahkategori_nama";
  await ctx.reply(`🏷 *Tambah Kategori Baru*\n\nKetik nama kategori pengeluaran kustom Anda beserta emojinya \\(opsional\\)\\.\n_Contoh: 🐶 Peliharaan_`, { parse_mode: "MarkdownV2" });
});

bot.command("setlimit", async (ctx) => {
  clearSession(ctx.chat.id);
  getSession(ctx.chat.id).step = "setlimit_nominal";
  await ctx.reply(`⚠️ *Atur Batas Harian*\n\nKetik nominal batas pengeluaran harian Anda:\n_Contoh: 150000 / 150rb_\n\nKetik 0 untuk mematikan peringatan batas harian kustom\\.`, { parse_mode: "MarkdownV2" });
});

bot.command("prediksi", async (ctx) => {
  clearSession(ctx.chat.id);
  const txs = await getTransactionsByDateRange(ctx.from.id, 'keluar', 30);
  if (txs.length === 0) return ctx.reply(`🔮 Belum ada data pengeluaran 30 hari terakhir\\.`, { parse_mode: "MarkdownV2" });

  let total30 = 0, last7 = 0, prev7 = 0;
  const categoryMap = new Map();
  const now = new Date();

  for (const tx of txs) {
    total30 += tx.amount;
    const cat = tx.category || "Lainnya";
    categoryMap.set(cat, (categoryMap.get(cat) || 0) + tx.amount);

    // approximate difference in days
    const txDate = new Date(tx.created_at + "Z");
    const diffDays = Math.floor((now - txDate) / (1000 * 60 * 60 * 24));

    if (diffDays < 7) last7 += tx.amount;
    else if (diffDays >= 7 && diffDays < 14) prev7 += tx.amount;
  }

  const avg30 = total30 / 30;
  const last7Avg = last7 / 7;
  const prev7Avg = prev7 / 7;

  let trendStr = "stabil";
  let multiplier = 1.0;
  if (prev7Avg > 0) {
    if (last7Avg > prev7Avg) { trendStr = "meningkat"; multiplier = 1.1; }
    else if (last7Avg < prev7Avg) { trendStr = "menurun"; multiplier = 0.9; }
  }

  const adjustedDaily = avg30 * multiplier || 1;
  const accounts = await getAccounts(ctx.from.id);
  const totalBalance = accounts.reduce((sum, acc) => sum + acc.balance, 0);

  const daysUntilEmpty = Math.floor(totalBalance / adjustedDaily);
  const predictedDate = new Date();
  predictedDate.setDate(predictedDate.getDate() + daysUntilEmpty);

  const sortedCats = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);

  let advice = "Keuanganmu dalam kondisi aman\\. Pertahankan\\!";
  if (daysUntilEmpty < 7) advice = "Saldo kamu kritis\\! Kurangi pengeluaran segera\\.";
  else if (daysUntilEmpty < 14) advice = "Saldo akan habis dalam 2 minggu\\. Hati\\-hati\\!";
  else if (trendStr === "meningkat" && multiplier > 1.05) advice = "Pengeluaranmu meningkat pesat minggu ini\\.";

  let text = `🔮 *Prediksi Keuangan MyDuit*\n──────────────────\n`;
  text += `💸 Rata\\-rata pengeluaran harian: *${esc(formatRupiah(avg30))}*\n`;
  text += `📈 Tren belanja: *${esc(trendStr)}*\n`;
  text += `📅 Estimasi saldo habis: *${esc(formatDate(predictedDate.toISOString().split('T')[0]))}* \\(${esc(daysUntilEmpty.toString())} hari lagi\\)\n\n`;

  text += `🏆 *Top 3 kategori pengeluaran:*\n`;
  for (let i = 0; i < Math.min(3, sortedCats.length); i++) {
    const [name, amt] = sortedCats[i];
    const pct = Math.round((amt / total30) * 100);
    text += `${i + 1}\\. ${esc(name)} — ${esc(formatRupiah(amt))} \\(${esc(pct.toString())}%\\)\n`;
  }

  text += `\n⚠️ _${esc(advice)}_`;
  await ctx.reply(text, { parse_mode: "MarkdownV2" });
});

async function generateReport(ctx, isMonthly) {
  clearSession(ctx.chat.id);
  const telegramId = ctx.from.id;
  const txs = isMonthly ? await getTransactionsForCurrentMonth(telegramId) : await getTransactionsForCurrentWeek(telegramId);

  if (txs.length === 0) return ctx.reply(`📊 Belum ada transaksi untuk periode ini\\.`, { parse_mode: "MarkdownV2" });

  let totalIn = 0, totalOut = 0;
  const cats = new Map();
  const sources = new Map();

  for (const tx of txs) {
    if (tx.type === "masuk") {
      totalIn += tx.amount;
      const s = tx.source || "Lainnya";
      sources.set(s, (sources.get(s) || 0) + tx.amount);
    } else {
      totalOut += tx.amount;
      const c = tx.category || "Lainnya";
      cats.set(c, (cats.get(c) || 0) + tx.amount);
    }
  }

  const diff = totalIn - totalOut;
  const title = isMonthly ? "Bulan" : "Minggu";
  const emojiSummary = diff > 0 ? "👍 Bagus\\! Kamu berhasil menabung periode ini\\." : (diff < 0 ? "⚠️ Pengeluaranmu lebih besar dari pemasukan\\." : "⚖️ Pemasukan dan pengeluaran seimbang\\.");

  let text = `📊 *Laporan ${title} MyDuit*\n──────────────────\n`;
  text += `💰 Total Pemasukan:  *${esc(formatRupiah(totalIn))}*\n`;
  text += `💸 Total Pengeluaran: *${esc(formatRupiah(totalOut))}*\n`;
  text += `📈 Selisih \\(Nabung\\):  *${esc(formatRupiah(diff))}*\n\n`;

  if (cats.size > 0) {
    text += `📂 *Pengeluaran per Kategori:*\n`;
    const sortedCats = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, amt] of sortedCats) {
      const pct = Math.round((amt / totalOut) * 100);
      text += `• ${esc(name)}    ${esc(formatRupiah(amt))}  \\(${esc(pct.toString())}%\\)\n`;
    }
    text += `\n`;
  }

  if (sources.size > 0) {
    text += `📥 *Sumber Pemasukan:*\n`;
    const sortedSources = Array.from(sources.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, amt] of sortedSources) {
      text += `• ${esc(name)}    ${esc(formatRupiah(amt))}\n`;
    }
    text += `\n`;
  }

  text += `${esc(emojiSummary)}`;
  await ctx.reply(text, { parse_mode: "MarkdownV2" });
}

bot.command("laporanminggu", (ctx) => generateReport(ctx, false));
bot.command("laporanbulan", (ctx) => generateReport(ctx, true));

// ── CATAT ──────────────────────────────────────────────────
bot.command("catat", async (ctx) => {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`⚠️ Belum ada rekening\\. Tambah dulu dengan /tambahbank`, { parse_mode: "MarkdownV2" });

  const keyboard = new InlineKeyboard();
  for (const acc of accounts) keyboard.text(`${acc.bank_name} (${formatRupiah(acc.balance)})`, `catat_akun_${acc.id}`).row();

  getSession(ctx.chat.id).step = "catat_pilih_akun";
  await ctx.reply(`📝 *Catat Transaksi*\n\nPilih rekening:`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
});

// ── CALLBACK QUERY HANDLER ────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const sess = getSession(chatId);
  await ctx.answerCallbackQuery();

  if (data === "batal") {
    clearSession(chatId);
    return ctx.editMessageText("❌ Dibatalkan\\.", { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("hapus_")) {
    const accId = parseInt(data.replace("hapus_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    const kb = new InlineKeyboard().text("✅ Ya, Hapus", `konfirmhapus_${accId}`).text("❌ Batal", "batal");
    return ctx.editMessageText(`⚠️ *Konfirmasi Hapus*\n\nApakah kamu yakin ingin menghapus rekening *${esc(acc.bank_name)}*?\nSaldo: ${esc(formatRupiah(acc.balance))}`, { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data.startsWith("konfirmhapus_")) {
    const accId = parseInt(data.replace("konfirmhapus_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    await deleteAccount(accId, ctx.from.id);
    return ctx.editMessageText(`✅ Rekening *${esc(acc.bank_name)}* berhasil dihapus\\.`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("catat_akun_")) {
    const accId = parseInt(data.replace("catat_akun_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    sess.step = "catat_pilih_tipe";
    sess.accountId = accId;
    sess.accountName = acc.bank_name;
    const kb = new InlineKeyboard().text("⬆️ Pemasukan", "catat_tipe_masuk").text("⬇️ Pengeluaran", "catat_tipe_keluar");
    return ctx.editMessageText(`📝 Rekening: *${esc(acc.bank_name)}*\nSaldo saat ini: *${esc(formatRupiah(acc.balance))}*\n\nJenis transaksi?`, { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data === "catat_tipe_masuk" || data === "catat_tipe_keluar") {
    const tipe = data === "catat_tipe_masuk" ? "masuk" : "keluar";
    sess.step = "catat_nominal";
    sess.type = tipe;
    const icon = tipe === "masuk" ? "⬆️ Pemasukan" : "⬇️ Pengeluaran";
    return ctx.editMessageText(`${icon} ke *${esc(sess.accountName)}*\n\nKetik nominal transaksi:\n_Contoh: 50000 / 50rb / 1jt_`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("catat_sumber_")) {
    sess.source = data.replace("catat_sumber_", "");
    sess.step = "catat_keterangan";
    return ctx.editMessageText(`Pemasukan dari: *${esc(sess.source)}*\n\nTambahkan keterangan \\(opsional\\):\n_Contoh: Gaji bulan ini_\n\nAtau ketik /skip untuk lewati`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("catat_kategori_")) {
    sess.category = data.replace("catat_kategori_", "");
    sess.step = "catat_keterangan";
    return ctx.editMessageText(`Kategori: *${esc(sess.category)}*\n\nTambahkan keterangan \\(opsional\\):\n_Contoh: Makan siang_\n\nAtau ketik /skip untuk lewati`, { parse_mode: "MarkdownV2" });
  }
});

// ── TEXT MESSAGE HANDLER ──────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const sess = getSession(chatId);

  if (sess.step === "tambahbank_nama") {
    sess.bankName = text;
    sess.step = "tambahbank_saldo";
    return ctx.reply(`💳 Nama rekening: *${esc(text)}*\n\nSekarang ketik *saldo awal* rekening ini:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "tambahbank_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
    await addAccount(ctx.from.id, sess.bankName, nominal);
    clearSession(chatId);
    return ctx.reply(`✅ *Rekening Berhasil Ditambahkan\\!*\n\n🏦 Bank: *${esc(sess.bankName)}*\n💰 Saldo Awal: *${esc(formatRupiah(nominal))}*\n\nGunakan /catat untuk mulai mencatat transaksi\\.`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "tambahkategori_nama") {
    await addCustomCategory(ctx.from.id, text);
    clearSession(chatId);
    return ctx.reply(`✅ Kategori *${esc(text)}* berhasil ditambahkan\\!`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "setlimit_nominal") {
    const nominal = parseNominal(text);
    if (text === "0" || isValidNominal(nominal)) {
      await updateDailyLimit(ctx.from.id, text === "0" ? 0 : nominal);
      clearSession(chatId);
      return ctx.reply(`✅ Batas pengeluaran harian berhasil diatur ke: *${esc(text === "0" ? "Tidak Terbatas" : formatRupiah(nominal))}*`, { parse_mode: "MarkdownV2" });
    }
    return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 150000 / 150rb_`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "catat_nominal") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 50000 / 50rb / 1jt_`, { parse_mode: "MarkdownV2" });
    sess.amount = nominal;

    if (sess.type === "masuk") {
      sess.step = "catat_sumber_pilih";
      const kb = new InlineKeyboard();
      let rowCnt = 0;
      for (const s of defaultIncomeSources) {
        kb.text(s, `catat_sumber_${s}`);
        rowCnt++;
        if (rowCnt % 2 === 0) kb.row();
      }
      return ctx.reply(`Pemasukan dari mana?`, { parse_mode: "MarkdownV2", reply_markup: kb });
    } else {
      sess.step = "catat_kategori_pilih";
      const customCats = await getCustomCategories(ctx.from.id);
      const allCats = [...defaultExpenseCategories, ...customCats.map(c => `${c.emoji} ${c.name}`)];
      const kb = new InlineKeyboard();
      let rowCnt = 0;
      for (const c of allCats) {
        kb.text(c, `catat_kategori_${c}`);
        rowCnt++;
        if (rowCnt % 2 === 0) kb.row();
      }
      return ctx.reply(`Pilih kategori pengeluaran:`, { parse_mode: "MarkdownV2", reply_markup: kb });
    }
  }

  if (sess.step === "catat_keterangan") {
    const note = text === "/skip" ? "" : text;
    await addTransaction(ctx.from.id, sess.accountId, sess.type, sess.amount, note, sess.category, sess.source);

    const acc = await getAccountById(sess.accountId, ctx.from.id);
    const icon = sess.type === "masuk" ? "⬆️" : "⬇️";
    const label = sess.type === "masuk" ? "Pemasukan" : "Pengeluaran";
    const sub = sess.type === "masuk" ? (sess.source ? `📥 Sumber: *${esc(sess.source)}*\n` : "") : (sess.category ? `📂 Kategori: *${esc(sess.category)}*\n` : "");

    clearSession(chatId);

    // Check and send alerts after transaction
    await checkAndSendAlerts(ctx, ctx.from.id);

    return ctx.reply(
      `✅ *Transaksi Dicatat\\!*\n\n` +
      `${icon} ${label}: *${esc(formatRupiah(sess.amount))}*\n` +
      `🏦 Rekening: *${esc(acc.bank_name)}*\n` +
      sub +
      (note ? `📝 Keterangan: _${esc(note)}_\n` : "") +
      `\n💰 Saldo terkini: *${esc(formatRupiah(acc.balance))}*`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── VERCEL HANDLER ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).json({ status: "MyDuit Bot is running 💰" });
  try {
    await initDB();
    await bot.init();
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(200).json({ ok: false });
  }
}
