// api/webhook.js
import { Bot, InlineKeyboard, session } from "grammy";
import {
  initDB, upsertUser, addAccount, getAccounts,
  getAccountById, deleteAccount, addTransaction,
  getRecentTransactions, addCustomCategory, getCustomCategories,
  getUserSettings, updateDailyLimit, getDailySpend, getWeeklySpend,
  getAlertLog, logAlert, getTransactionsByDateRange,
  getTransactionsForCurrentMonth, getTransactionsForCurrentWeek,
  getCategorySuggestions, upsertCategorySuggestion, updateSmartLimit,
  updateLimitRecalcTime, getAlertLogWithCooldown, getTransactionsByDayGrouped,
  getSessionData, setSessionData, clearSessionData,
  updateAccountBalance, updateAccountName
} from "../lib/db.js";
import { formatRupiah, formatDate, esc } from "../lib/format.js";

// ── SECURITY: VALIDATE REQUIRED ENV VARS ───────────────────────
const requiredEnvVars = [
  "TELEGRAM_BOT_TOKEN",
  "TURSO_DATABASE_URL", 
  "TURSO_AUTH_TOKEN"
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// ── INISIALISASI BOT ───────────────────────────────────────────
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Initialize bot once at module level (outside handler)
(async () => {
  try {
    await bot.init();
  } catch (err) {
    console.error("Bot init error:", err);
  }
})();

// ── SECURITY: OPTIONAL PRIVATE BOT WHITELIST ──────────────────
// Only apply if ALLOWED_USER_ID is set in env
bot.use(async (ctx, next) => {
  const allowedId = process.env.ALLOWED_USER_ID;
  if (!allowedId) return next(); // skip if not set (public mode)
  
  const userId = String(ctx.from?.id || "");
  const allowedIds = allowedId.split(",").map(id => id.trim());
  
  if (!allowedIds.includes(userId)) {
    if (ctx.message) {
      await ctx.reply("⛔ Bot ini bersifat pribadi.");
    } else if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery("⛔ Akses ditolak.");
    }
    return; // stop processing
  }
  
  return next();
});

// ── SECURITY: RATE LIMITING ────────────────────────────────────
// Max 1 message per second per user
const rateLimitMap = new Map();

function isRateLimited(telegramId) {
  const now = Date.now();
  const last = rateLimitMap.get(String(telegramId)) || 0;
  if (now - last < 1000) return true;
  rateLimitMap.set(String(telegramId), now);
  return false;
}

// DB Initialization caching
let dbInitialized = false;

async function ensureDB() {
  if (!dbInitialized) {
    await initDB();
    dbInitialized = true;
  }
}

// ── SESSION MANAGEMENT (Turso-backed) ──────────────────────────
async function getSession(chatId) {
  return await getSessionData(chatId);
}

async function saveSession(chatId, sess) {
  await setSessionData(chatId, sess);
}

async function clearSession(chatId) {
  await clearSessionData(chatId);
}

// ── CONSTANTS ─────────────────────────────────────────────────
const defaultExpenseCategories = [
  "🍔 Makanan", "🥤 Minuman", "🚗 Transport", "🏠 Tagihan",
  "👗 Gaya Hidup", "🎮 Hiburan", "💊 Kesehatan"
];

const defaultIncomeSources = [
  "💼 Gaji", "💰 Bonus", "🤝 Freelance", "📈 Investasi",
  "🏪 Usaha", "🎁 Hadiah", "📦 Lainnya"
];



const startKeyboard = new InlineKeyboard()
  .text("💰 Cek Saldo", "menu_saldo")
  .text("📝 Catat Transaksi", "menu_catat").row()
  .text("📋 Riwayat", "menu_riwayat")
  .text("🔮 Prediksi", "menu_prediksi").row()
  .text("🏦 Tambah Rekening", "menu_tambahbank")
  .text("✏️ Edit Rekening", "menu_editrekening").row()
  .text("📊 Laporan Bulan Ini", "menu_laporan");

const pengaturanKeyboard = new InlineKeyboard()
  .text("🗑 Hapus Rekening", "menu_hapusbank").row()
  .text("➕ Tambah Kategori Custom", "menu_tambahkategori").row()
  .text("🎯 Set Limit Harian", "menu_setlimit").row()
  .text("❌ Tutup", "menu_tutup");

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

// ── SCORE CALCULATION ──────────────────────────────────────────
async function calculateScore(telegramId, dailyLimit) {
  let score = 100;

  // Get stats
  const todaySpend = await getDailySpend(telegramId);
  const accounts = await getAccounts(telegramId);
  const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
  const totalInitialBalance = accounts.reduce((acc, a) => acc + (a.initial_balance || 0), 0);

  // Factor 1: Daily Limit Usage (30pts)
  let usageRatio = 0;
  if (dailyLimit > 0) {
    usageRatio = todaySpend / dailyLimit;
    if (usageRatio > 1.0) score -= 30;
    else if (usageRatio > 0.8) score -= 15;
    else if (usageRatio > 0.6) score -= 5;
  }

  // Factor 2: Balance Health (25pts)
  let balanceRatio = 1.0;
  if (totalInitialBalance > 0) {
    balanceRatio = totalBalance / totalInitialBalance;
    if (balanceRatio < 0.10) score -= 25;
    else if (balanceRatio < 0.25) score -= 15;
    else if (balanceRatio < 0.50) score -= 8;
  }

  // Factor 3: Weekly Trend (25pts)
  const thisWeek = await getWeeklySpend(telegramId, 0);
  const lastWeek = await getWeeklySpend(telegramId, 1);
  if (lastWeek > 0) {
    if (thisWeek > lastWeek * 1.3) score -= 25;
    else if (thisWeek > lastWeek * 1.1) score -= 10;
  }

  // Factor 4: Saving Behavior (20pts)
  const thisMonthTxs = await getTransactionsForCurrentMonth(telegramId);
  let monthIncome = 0;
  let monthSpend = 0;
  for (const tx of thisMonthTxs) {
    if (tx.type === "masuk") monthIncome += tx.amount;
    else monthSpend += tx.amount;
  }
  let savingRate = 0;
  if (monthIncome > 0) {
    savingRate = (monthIncome - monthSpend) / monthIncome;
    if (savingRate < 0) score -= 20;
    else if (savingRate < 0.1) score -= 10;
    else if (savingRate > 0.3) score += 5;
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Emoji Mapping
  let scoreEmoji = "🔴 Kritis";
  if (score >= 90) scoreEmoji = "💚 Sangat Sehat";
  else if (score >= 70) scoreEmoji = "🟡 Cukup Baik";
  else if (score >= 50) scoreEmoji = "🟠 Perlu Perhatian";

  return { score, scoreEmoji, savingRate, usageRatio, balanceRatio };
}

// ── ML SMART LIMIT ─────────────────────────────────────────────
async function calculateSmartLimit(telegramId) {
  const settings = await getUserSettings(telegramId);
  const now = new Date();

  // Recalculate only if > 7 days since last recalc AND not custom
  if (settings.limit_mode === 'custom') return settings.daily_limit;

  if (settings.last_recalc) {
    const lastDate = new Date(settings.last_recalc + "Z");
    const diffDays = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
    // If not first time and hasn't been 7 days, skip
    if (settings.daily_limit > 0 && diffDays < 7) {
      return settings.daily_limit;
    }
  }

  const grouped = await getTransactionsByDayGrouped(telegramId, 30);

  let smartLimit = 0;

  if (grouped.length < 7) {
    // Bootstrap mode
    const accounts = await getAccounts(telegramId);
    const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
    smartLimit = totalBalance * 0.20;
  } else {
    // ML mode
    const values = grouped.map(g => g.daily_total);
    const n = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    // Variance & Volatility (StdDev)
    const variance = values.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / n;
    const volatility = Math.sqrt(variance);

    let coeff = 0.95;
    // Need at least 21 days for 3 blocks of 7 days etc.
    // The instructions say 3 blocks of 10 days each -> needs 30 days total ideally
    // We will do our best with what we have
    if (grouped.length >= 21) {
      // Oldest to newest (grouped is ascending order)
      const b1 = values.slice(0, Math.floor(n / 3));
      const b2 = values.slice(Math.floor(n / 3), Math.floor(2 * n / 3));
      const b3 = values.slice(Math.floor(2 * n / 3));

      const avg1 = b1.reduce((a, b) => a + b, 0) / (b1.length || 1);
      const avg2 = b2.reduce((a, b) => a + b, 0) / (b2.length || 1);
      const avg3 = b3.reduce((a, b) => a + b, 0) / (b3.length || 1);

      if (avg3 > avg2 && avg2 > avg1) coeff = 0.85; // Rising -> tighten
      else if (avg3 < avg2 && avg2 < avg1) coeff = 1.05; // Falling -> loosen
    }

    let safetyMargin = 1 - (mean > 0 ? (volatility / mean * 0.3) : 0);
    safetyMargin = Math.max(0.7, Math.min(1.0, safetyMargin)); // Clamp 0.7 - 1.0

    smartLimit = mean * coeff * safetyMargin;
  }

  // ── MINIMUM FLOOR ──
  // Floor: minimum Rp 50.000/day
  const MINIMUM_DAILY_LIMIT = 50000;
  if (smartLimit < MINIMUM_DAILY_LIMIT) {
    smartLimit = MINIMUM_DAILY_LIMIT;
  }

  // Income ratio guard
  if (settings.monthly_income > 0) {
    const maxMonthlySpend = settings.monthly_income * 0.70;
    const incomeBasedLimit = maxMonthlySpend / 30;
    if (smartLimit > incomeBasedLimit) smartLimit = incomeBasedLimit;
  }

  await updateSmartLimit(telegramId, smartLimit);
  return smartLimit;
}

// ── SMART ALERT SYSTEM ─────────────────────────────────────────
async function analyzeAndAlert(ctx, telegramId) {
  try {
    // Always recalculate Smart Limit for up-to-date data
    const dailyLimit = await calculateSmartLimit(telegramId);

    // Get scorecard
    const scorecard = await calculateScore(telegramId, dailyLimit);
    const { score, scoreEmoji, savingRate, usageRatio, balanceRatio } = scorecard;

    // Get stats
    const accounts = await getAccounts(telegramId);
    const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
    const totalInitialBalance = accounts.reduce((acc, a) => acc + (a.initial_balance || 0), 0);
    const todaySpend = await getDailySpend(telegramId);
    const thisWeek = await getWeeklySpend(telegramId, 0);
    const lastWeek = await getWeeklySpend(telegramId, 1);

    // ── PROGRESS BAR ──
    const rawBarRatio = dailyLimit > 0 
      ? Math.min(1, todaySpend / Math.round(dailyLimit)) 
      : 0;
    const filled = Math.min(10, Math.round(rawBarRatio * 10));
    const barStr = '█'.repeat(filled) + '░'.repeat(10 - filled);
    const pctStr = dailyLimit > 0 ? Math.min(999, Math.round(rawBarRatio * 100)) : 0;

    // ── SMART ADVICE ──
    let advice = "Catat setiap transaksi untuk analisis yang lebih akurat.";
    if (score < 50) advice = "Kondisi keuanganmu kritis. Tunda pengeluaran non-esensial.";
    else if (score < 70 && lastWeek > 0 && thisWeek > lastWeek) advice = "Belanjamu meningkat pesat. Coba terapkan aturan 50/30/20.";
    else if (dailyLimit > 0 && todaySpend > dailyLimit) advice = "Limit harian terlampaui. Hindari pengeluaran sampai besok.";
    else if (totalInitialBalance > 0 && balanceRatio < 0.25) advice = "Saldo tinggal 25%. Prioritaskan kebutuhan pokok saja.";
    else if (savingRate > 0.3) advice = "Hebat! Tabunganmu bulan ini di atas 30%. Pertahankan!";
    else if (usageRatio < 0.5 && score > 80) advice = "Pengeluaran terkendali. Keuanganmu sehat hari ini.";

    // ── ALERTS CHECK ──
    let alertBlocks = "";

    // Limit Alert (daily cooldown)
    if (dailyLimit > 0 && todaySpend > dailyLimit * 0.8) {
      const type = `alert_limit_${new Date().toISOString().split('T')[0]}`;
      const logged = await getAlertLogWithCooldown(telegramId, type, 24);
      if (!logged) {
        await logAlert(telegramId, type);
        alertBlocks += `⚠️ *LIMIT HARIAN* hampir / sudah habis\\.\n`;
      }
    }

    // Balance Alert (6 hours cooldown)
    if (totalInitialBalance > 0 && balanceRatio < 0.25) {
      const type = `alert_balance`;
      const logged = await getAlertLogWithCooldown(telegramId, type, 6);
      if (!logged) {
        await logAlert(telegramId, type);
        alertBlocks += `🔴 *SALDO MENIPIS* \\(Sisa < 25%\\)\\.\n`;
      }
    }

    // Trend Alert (daily cooldown)
    if (lastWeek > 0 && thisWeek > lastWeek * 1.1) {
      const type = `alert_trend_${new Date().toISOString().split('T')[0]}`;
      const logged = await getAlertLogWithCooldown(telegramId, type, 24);
      if (!logged) {
        await logAlert(telegramId, type);
        alertBlocks += `📈 *TREN BOROS* naik pesat minggu ini\\.\n`;
      }
    }

    // ── MESSAGE CONSTRUCTION ──
    const limitDisplay = dailyLimit > 0 
      ? formatRupiah(Math.round(dailyLimit)) 
      : "Belum diatur";
    const remainingToSpend = dailyLimit > 0 
      ? Math.max(0, Math.round(dailyLimit) - todaySpend) 
      : 0;

    let msg = `📊 *Analisis Transaksi*\n─────────────────\n`;
    msg += `🏦 Skor Kesehatan: *${esc(score.toString())}/100* ${esc(scoreEmoji)}\n\n`;
    msg += `💸 Pengeluaran hari ini: *${esc(formatRupiah(todaySpend))}*\n`;
    msg += `🎯 Limit harian: ${esc(limitDisplay)}\n`;
    msg += `\\[${esc(barStr)} ${esc(pctStr.toString())}%\\]\n\n`;
    msg += `📅 Sisa hari ini: *${esc(formatRupiah(remainingToSpend))}*\n\n`;

    if (alertBlocks) {
      msg += `${esc(alertBlocks.trim())}\n\n`;
    }
    msg += `💡 *SARAN:* _${esc(advice)}_`;

    await ctx.reply(msg, { parse_mode: "MarkdownV2" });

  } catch (err) {
    console.error("Alert Error:", err);
  }
}

// ── COMMANDS MAIN ─────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const name = ctx.from.first_name || "Pengguna";
  await upsertUser(ctx.from.id, name);
  clearSession(ctx.chat.id);

  // One-time removal of persistent keyboard for old users
  await ctx.reply(".", {
    reply_markup: { remove_keyboard: true }
  }).then(msg => ctx.api.deleteMessage(ctx.chat.id, msg.message_id))
    .catch(() => { });

  await ctx.reply(
    `👋 *Halo, ${esc(name)}\\!*\n\n` +
    `Selamat datang di *MyDuit Ku* 💰\n` +
    `Bot pribadimu untuk mencatat saldo & transaksi keuangan\\.\n\n` +
    `Pilih menu di bawah ini untuk memulai:`,
    { parse_mode: "MarkdownV2", reply_markup: startKeyboard }
  );
});

async function handleSaldo(ctx) {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`💳 Belum ada rekening tercatat\\.\n\nGunakan /tambahbank untuk menambahkan rekening pertamamu\\.`, { parse_mode: "MarkdownV2" });

  let total = 0;
  let text = `💰 *Saldo Rekening MyDuit Ku*\n─────────────────────\n`;
  for (const acc of accounts) {
    const icon = acc.balance >= 0 ? "🟢" : "🔴";
    text += `${icon} *${esc(acc.bank_name)}*\n    ${esc(formatRupiah(acc.balance))}\n\n`;
    total += acc.balance;
  }
  text += `─────────────────────\n📊 *Total Semua Rekening*\n*${esc(formatRupiah(total))}*`;
  await ctx.reply(text, { parse_mode: "MarkdownV2" });
}

async function handleRiwayat(ctx) {
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
}

async function handleHapusBank(ctx) {
  clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`⚠️ Tidak ada rekening untuk dihapus\\.`, { parse_mode: "MarkdownV2" });

  const keyboard = new InlineKeyboard();
  for (const acc of accounts) {
    keyboard.text(`🗑 ${acc.bank_name}`, `hapus_${acc.id}`).row();
  }
  keyboard.text("❌ Batal", "batal");
  await ctx.reply(`🗑 *Hapus Rekening*\n\n⚠️ Semua transaksi di rekening tersebut juga akan terhapus\\.\n\nPilih rekening yang ingin dihapus:`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
}

async function handleTambahBank(ctx) {
  await clearSession(ctx.chat.id);
  const sess = await getSession(ctx.chat.id);
  sess.step = "tambahbank_nama";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`🏦 *Tambah Rekening Baru*\n\nKetik nama bank atau dompet digitalmu\\.\n_Contoh: BCA, Mandiri, GoPay, Dana_`, { parse_mode: "MarkdownV2" });
}

async function handleEditRekening(ctx) {
  try {
    await clearSession(ctx.chat.id);
    const sess = await getSession(ctx.chat.id);
    const accounts = await getAccounts(ctx.from.id);
    
    if (accounts.length === 0) {
      return ctx.reply(`⚠️ Belum ada rekening\\. Gunakan /tambahbank untuk menambah rekening\\.`, { parse_mode: "MarkdownV2" });
    }
    
    sess.step = "editrek_pilih_akun";
    await saveSession(ctx.chat.id, sess);
    
    const kb = new InlineKeyboard();
    for (const acc of accounts) {
      kb.text(`🏦 ${esc(acc.bank_name)} — ${esc(formatRupiah(acc.balance))}`, `editrek_akun_${acc.id}`).row();
    }
    kb.text("❌ Batal", "batal");
    
    await ctx.reply(`✏️ *Edit Rekening*\n\nPilih rekening yang ingin diubah:`, { parse_mode: "MarkdownV2", reply_markup: kb });
  } catch (err) {
    console.error("handleEditRekening error:", err);
    await ctx.reply(`⚠️ Terjadi kesalahan\\.`, { parse_mode: "MarkdownV2" });
  }
}

async function handleTambahKategori(ctx) {
  await clearSession(ctx.chat.id);
  const sess = await getSession(ctx.chat.id);
  sess.step = "tambahkategori_nama";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`🏷 *Tambah Kategori Baru*\n\nKetik nama kategori pengeluaran kustom Anda beserta emojinya \\(opsional\\)\\.\n_Contoh: 🐶 Peliharaan_`, { parse_mode: "MarkdownV2" });
}
bot.command("tambahkategori", handleTambahKategori);

async function handleSetLimit(ctx) {
  await clearSession(ctx.chat.id);
  const sess = await getSession(ctx.chat.id);
  sess.step = "setlimit_nominal";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`⚠️ *Atur Batas Harian*\n\nKetik nominal batas pengeluaran harian Anda:\n_Contoh: 150000 / 150rb_\n\nKetik 0 untuk mematikan peringatan batas harian kustom\\.`, { parse_mode: "MarkdownV2" });
}
bot.command("setlimit", handleSetLimit);

bot.command("settings", async (ctx) => {
  clearSession(ctx.chat.id);
  await ctx.reply(`⚙️ *Pengaturan MyDuit Ku*\n\nPilih opsi yang ingin diatur:`, { parse_mode: "MarkdownV2", reply_markup: pengaturanKeyboard });
});

async function handlePrediksi(ctx) {
  clearSession(ctx.chat.id);
  const txs = await getTransactionsByDateRange(ctx.from.id, 'keluar', 30);
  if (txs.length === 0) return ctx.reply(`🔮 Belum ada data pengeluaran 30 hari terakhir\\.`, { parse_mode: "MarkdownV2" });

  // Get Smart Limit which already calculates ML background
  const smartDailyLimit = await calculateSmartLimit(ctx.from.id);

  let total30 = 0, last7 = 0, prev7 = 0;
  const categoryMap = new Map();
  const now = new Date();

  for (const tx of txs) {
    total30 += tx.amount;
    const cat = tx.category || "Lainnya";
    categoryMap.set(cat, (categoryMap.get(cat) || 0) + tx.amount);

    const txDate = new Date(tx.created_at + "Z");
    const diffDays = Math.floor((now - txDate) / (1000 * 60 * 60 * 24));

    if (diffDays < 7) last7 += tx.amount;
    else if (diffDays >= 7 && diffDays < 14) prev7 += tx.amount;
  }

  const avg30 = total30 / 30;
  const last7Avg = last7 / 7;
  const prev7Avg = prev7 / 7;

  let trendStr = "stabil";
  let trendEmoji = "➖";
  let multiplier = 1.0;
  if (prev7Avg > 0) {
    if (last7Avg > prev7Avg) { trendStr = "meningkat"; trendEmoji = "📈"; multiplier = 1.1; }
    else if (last7Avg < prev7Avg) { trendStr = "menurun"; trendEmoji = "📉"; multiplier = 0.9; }
  }

  const accounts = await getAccounts(ctx.from.id);
  const totalBalance = accounts.reduce((sum, acc) => sum + acc.balance, 0);

  // Exact Days to empty using Smart Limit (adjusted)
  const daysUntilEmpty = smartDailyLimit > 0 ? Math.floor(totalBalance / smartDailyLimit) : 999;
  const predictedDate = new Date();
  predictedDate.setDate(predictedDate.getDate() + daysUntilEmpty);

  const sortedCats = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);

  // Calculate Score using shared function
  const scorecard = await calculateScore(ctx.from.id, smartDailyLimit);
  const { score, scoreEmoji: scoreEmojiBase } = scorecard;
  let scoreEmoji = "🔴";
  if (score >= 90) scoreEmoji = "💚";
  else if (score >= 70) scoreEmoji = "🟡";
  else if (score >= 50) scoreEmoji = "🟠";

  // Get data for advice
  const todaySpend = await getDailySpend(ctx.from.id);
  const thisMonthTxs = await getTransactionsForCurrentMonth(ctx.from.id);
  let monthIncome = 0;
  let monthSpend = 0;
  for (const tx of thisMonthTxs) {
    if (tx.type === "masuk") monthIncome += tx.amount;
    else monthSpend += tx.amount;
  }
  let savingRate = 0;
  if (monthIncome > 0) {
    savingRate = (monthIncome - monthSpend) / monthIncome;
  }

  let advice = "Catat setiap transaksi untuk analisis yang lebih akurat.";
  if (score < 50) advice = "Kondisi keuanganmu kritis. Tunda pengeluaran non-esensial.";
  else if (score < 70 && trendStr === "meningkat") advice = "Belanjamu meningkat pesat. Coba terapkan aturan 50/30/20.";
  else if (smartDailyLimit > 0 && todaySpend > smartDailyLimit) advice = "Limit harian terlampaui. Hindari pengeluaran sampai besok.";
  else if (totalInitialBalance > 0 && (totalBalance / totalInitialBalance) < 0.25) advice = "Saldo tinggal 25%. Prioritaskan kebutuhan pokok saja.";
  else if (savingRate > 0.3) advice = "Hebat! Tabunganmu bulan ini di atas 30%. Pertahankan!";
  else if (smartDailyLimit > 0 && (todaySpend / smartDailyLimit) < 0.5 && score > 80) advice = "Pengeluaran terkendali. Keuanganmu sehat hari ini.";

  let text = `🔮 *Prediksi Keuangan MyDuit Ku*\n─────────────────\n`;
  text += `💰 Total saldo: *${esc(formatRupiah(totalBalance))}*\n`;
  text += `💸 Rata\\-rata harian: *${esc(formatRupiah(avg30))}*\n`;
  text += `📈 Tren: *${esc(trendStr)}* ${esc(trendEmoji)}\n\n`;

  text += `📅 Estimasi saldo habis:\n*${esc(predictedDate.toLocaleDateString("id-ID", { day: "2-digit", month: "long", year: "numeric" }))}* \\(${esc(daysUntilEmpty.toString())} hari lagi\\)\n\n`;

  text += `🏆 *Top 3 Pengeluaran Bulan Ini:*\n`;
  for (let i = 0; i < Math.min(3, sortedCats.length); i++) {
    const [name, amt] = sortedCats[i];
    const pct = Math.round((amt / total30) * 100);
    text += `${i + 1}\\. ${esc(name)} — ${esc(formatRupiah(amt))} \\(${esc(pct.toString())}%\\)\n`;
  }

  text += `\n🎯 Skor Kesehatan: *${esc(score.toString())}/100* ${esc(scoreEmoji)}\n`;
  text += `💡 _${esc(advice)}_`;

  await ctx.reply(text, { parse_mode: "MarkdownV2" });
}

async function generateReport(ctx, isMonthly) {
  clearSession(ctx.chat.id);
  const telegramId = ctx.from.id;
  const txs = isMonthly ? await getTransactionsForCurrentMonth(telegramId) : await getTransactionsForCurrentWeek(telegramId);

  if (txs.length === 0) return ctx.reply(`📊 Belum ada transaksi untuk periode ini\\.`, { parse_mode: "MarkdownV2" });

  let totalIn = 0, totalOut = 0;
  const cats = new Map();

  // Get Period Start/End Dates safely formatting
  let periodStart = new Date();
  let periodEnd = new Date();
  if (txs.length > 0) {
    const dates = txs.map(t => new Date(t.created_at + "Z"));
    periodStart = new Date(Math.min(...dates));
    periodEnd = new Date(Math.max(...dates));
  }

  for (const tx of txs) {
    if (tx.type === "masuk") {
      totalIn += tx.amount;
    } else {
      totalOut += tx.amount;
      const c = tx.category || "Lainnya";
      cats.set(c, (cats.get(c) || 0) + tx.amount);
    }
  }

  const diff = totalIn - totalOut;
  const title = isMonthly ? "Bulan" : "Minggu";
  const savingRate = totalIn > 0 ? ((totalIn - totalOut) / totalIn) : 0;

  // Calculate Score for Report using shared function
  const smartDailyLimit = await calculateSmartLimit(telegramId);
  const scorecard = await calculateScore(telegramId, smartDailyLimit);
  const { score } = scorecard;

  // Period Advice based on Savings from report period
  let msgAdvice = "Coba simpan uangmu lebih baik lagi periode depan.";
  if (savingRate > 0.3) msgAdvice = "Pengelolaan uang yang sangat baik! Lanjutkan di periode berikutnya.";
  else if (savingRate > 0.1) msgAdvice = "Cukup baik, tapi kamu masih bisa lebih efisien!";
  else if (savingRate < 0) msgAdvice = "Pengeluaran membengkak dari pemasukan. Segera perbaiki keuanganmu!";

  let text = `📊 *Laporan ${title} MyDuit Ku*\n`;
  text += `Periode: ${esc(formatDate(periodStart.toISOString().split('T')[0]))} \\- ${esc(formatDate(periodEnd.toISOString().split('T')[0]))}\n─────────────────\n`;
  text += `💰 Pemasukan:    *${esc(formatRupiah(totalIn))}*\n`;
  text += `💸 Pengeluaran:  *${esc(formatRupiah(totalOut))}*\n`;
  text += `📈 Selisih:      *${esc(formatRupiah(diff))}*\n`;
  const svPct = Math.round(savingRate * 100);
  text += `💾 Saving rate:  *${esc(svPct.toString())}%*\n\n`;

  if (cats.size > 0) {
    text += `📂 *Per Kategori:*\n`;
    const sortedCats = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, amt] of sortedCats) {
      const pct = Math.round((amt / totalOut) * 100);
      text += `• ${esc(name)}    ${esc(formatRupiah(amt))} \\(${esc(pct.toString())}%\\)\n`;
    }
    text += `\n`;
  }

  text += `🎯 Skor Rata\\-rata: *${esc(score.toString())}/100*\n`;
  text += `💡 _${esc(msgAdvice)}_`;

  await ctx.reply(text, { parse_mode: "MarkdownV2" });
}

// ── COMMAND BINDINGS ──────────────────────────────────────────
bot.command("saldo", handleSaldo);
bot.hears("💰 Saldo", handleSaldo);

bot.command("catat", handleCatat);
bot.hears("📝 Catat", handleCatat);

bot.command("riwayat", handleRiwayat);
bot.hears("📋 Riwayat", handleRiwayat);

bot.command("prediksi", handlePrediksi);
bot.hears("🔮 Prediksi", handlePrediksi);

bot.command("laporanminggu", (ctx) => generateReport(ctx, false));
bot.command("laporanbulan", (ctx) => generateReport(ctx, true));
bot.hears("📊 Laporan", (ctx) => generateReport(ctx, true));

bot.hears("➕ Tambah Kategori", handleTambahKategori);

bot.hears("🎯 Set Limit", handleSetLimit);

bot.command("tambahbank", handleTambahBank);
bot.hears("🏦 Tambah Bank", handleTambahBank);

bot.command("editrekening", handleEditRekening);
bot.hears("✏️ Edit Rekening", handleEditRekening);

bot.command("hapusbank", handleHapusBank);
bot.hears("🗑 Hapus Bank", handleHapusBank);

// ── CATAT ──────────────────────────────────────────────────
async function handleCatat(ctx) {
  await clearSession(ctx.chat.id); // Prevents session conflict
  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) return ctx.reply(`⚠️ Belum ada rekening\\. Tambah dulu dengan /tambahbank`, { parse_mode: "MarkdownV2" });

  const keyboard = new InlineKeyboard();
  for (const acc of accounts) keyboard.text(`🏦 ${acc.bank_name} (${formatRupiah(acc.balance)})`, `catat_akun_${acc.id}`).row();
  keyboard.text("❌ Batal", "batal");

  const sess = await getSession(ctx.chat.id);
  sess.step = "catat_pilih_akun";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`📝 *Catat Transaksi*\n\nPilih rekening:`, { parse_mode: "MarkdownV2", reply_markup: keyboard });
}

// ── CATAT HELPERS ─────────────────────────────────────────────
async function sendCatatPreview(ctx, sess) {
  // Guard: if session is empty/corrupt, restart flow
  if (!sess.accountId || !sess.accountName || !sess.type) {
    await clearSession(ctx.chat.id);
    return ctx.reply(
      "⚠️ Sesi habis\\. Silakan mulai /catat ulang\\.",
      { parse_mode: "MarkdownV2" }
    );
  }
  
  sess.step = "catat_konfirmasi";
  await saveSession(ctx.chat.id, sess);
  
  const labelKategori = sess.type === "masuk" 
    ? (sess.source || "Lainnya") 
    : (sess.category || "Lainnya");
  const noteCat = sess.note ? esc(sess.note) : "\\-";
  const icon = sess.type === "masuk" ? "⬆️ Pemasukan" : "⬇️ Pengeluaran";
  
  const text = 
    `🔍 *Konfirmasi Transaksi*\n` +
    `──────────────────\n` +
    `🏦 Rekening : *${esc(sess.accountName)}*\n` +
    `📂 Jenis    : *${esc(icon)}*\n` +
    `🏷 Kategori : *${esc(labelKategori)}*\n` +
    `💵 Nominal  : *${esc(formatRupiah(sess.amount))}*\n` +
    `📝 Keterangan: ${noteCat}\n` +
    `──────────────────\n` +
    `Pastikan data sudah benar sebelum menyimpan\\.`;
  
  const kb = new InlineKeyboard()
    .text("✅ Simpan", "catat_simpan")
    .text("✏️ Ubah Nominal", "catat_ubah_nominal").row()
    .text("❌ Batal", "batal");

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { 
      parse_mode: "MarkdownV2", reply_markup: kb 
    });
  }
  return ctx.reply(text, { 
    parse_mode: "MarkdownV2", reply_markup: kb 
  });
}

// ── CALLBACK QUERY HANDLER ────────────────────────────────────
bot.on("callback_query:data", async (ctx) => {
  // Security: Rate limiting
  if (isRateLimited(ctx.from.id)) {
    await ctx.answerCallbackQuery("⏳ Terlalu cepat, tunggu sebentar.");
    return;
  }

  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;
  const sess = await getSession(chatId);
  await ctx.answerCallbackQuery();

  if (data === "batal" || data === "menu_tutup") {
    await clearSession(chatId);
    if (data === "menu_tutup") {
      await ctx.deleteMessage().catch(() => { });
    } else {
      await ctx.editMessageText("❌ Transaksi dibatalkan\\.", { parse_mode: "MarkdownV2" });
    }
    return;
  }

  if (data.startsWith("menu_")) {
    try { await ctx.deleteMessage(); } catch (e) { }

    if (data === "menu_start") {
      const name = ctx.from.first_name || "Pengguna";
      return ctx.reply(
        `👋 *Halo, ${esc(name)}\\!*\n\nSelamat datang di *MyDuit Ku* 💰\n\nPilih menu di bawah ini:`,
        { parse_mode: "MarkdownV2", reply_markup: startKeyboard }
      );
    }
    if (data === "menu_saldo") return handleSaldo(ctx);
    if (data === "menu_catat") return handleCatat(ctx);
    if (data === "menu_riwayat") return handleRiwayat(ctx);
    if (data === "menu_prediksi") return handlePrediksi(ctx);
    if (data === "menu_tambahbank") return handleTambahBank(ctx);
    if (data === "menu_laporan") return generateReport(ctx, true);
    if (data === "menu_hapusbank") return handleHapusBank(ctx);
    if (data === "menu_tambahkategori") return handleTambahKategori(ctx);
    if (data === "menu_setlimit") return handleSetLimit(ctx);
    return;
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
    const kb = new InlineKeyboard()
      .text("🏠 Menu Utama", "menu_start");
    return ctx.editMessageText(`✅ Rekening *${esc(acc.bank_name)}* berhasil dihapus\\.`, { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data.startsWith("catat_akun_")) {
    const accId = parseInt(data.replace("catat_akun_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    sess.step = "catat_pilih_tipe";
    sess.accountId = accId;
    sess.accountName = acc.bank_name;
    await saveSession(chatId, sess);
    const kb = new InlineKeyboard()
      .text("⬆️ Pemasukan", "catat_tipe_masuk")
      .text("⬇️ Pengeluaran", "catat_tipe_keluar").row()
      .text("❌ Batal", "batal");
    return ctx.editMessageText(`📝 *Catat Transaksi*\n🏦 Rekening: *${esc(acc.bank_name)}*\n💰 Saldo: *${esc(formatRupiah(acc.balance))}*\n\nPilih jenis transaksi:`, { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data === "catat_tipe_masuk" || data === "catat_tipe_keluar") {
    const tipe = data === "catat_tipe_masuk" ? "masuk" : "keluar";
    sess.type = tipe;

    if (tipe === "keluar") {
      sess.step = "catat_pilih_kategori";
      const customCats = await getCustomCategories(ctx.from.id);
      const suggestionsRows = await getCategorySuggestions(ctx.from.id);

      const allCats = [...defaultExpenseCategories, ...customCats.map(c => `${c.emoji} ${c.name}`)];
      const suggestions = suggestionsRows.filter(s => s.count >= 3).map(c => c.name);

      const kb = new InlineKeyboard();
      let rowCnt = 0;
      for (const c of allCats) {
        kb.text(c, `catat_kategori_${c}`);
        rowCnt++;
        if (rowCnt % 2 === 0) kb.row();
      }
      if (rowCnt % 2 !== 0) kb.row();

      for (const s of suggestions) {
        kb.text(`⭐ ${s}`, `catat_kategori_${s}`);
        kb.row();
      }

      kb.text("✏️ Lainnya", "catat_kategori_✏️ Lainnya").text("❌ Batal", "batal");
      await saveSession(chatId, sess);
      return ctx.editMessageText(`Pilih kategori pengeluaran:`, { parse_mode: "MarkdownV2", reply_markup: kb });
    } else {
      sess.step = "catat_pilih_sumber";
      const kb = new InlineKeyboard();
      let rowCnt = 0;
      for (const s of defaultIncomeSources) {
        kb.text(s, `catat_sumber_${s}`);
        rowCnt++;
        if (rowCnt % 2 === 0) kb.row();
      }
      if (rowCnt % 2 !== 0) kb.row();
      kb.text("❌ Batal", "batal");
      await saveSession(chatId, sess);
      return ctx.editMessageText(`Pemasukan dari mana?`, { parse_mode: "MarkdownV2", reply_markup: kb });
    }
  }

  if (data.startsWith("catat_sumber_") || data.startsWith("catat_kategori_")) {
    const isSumber = data.startsWith("catat_sumber_");
    const chosen = data.replace(isSumber ? "catat_sumber_" : "catat_kategori_", "");

    if (!isSumber && chosen === "✏️ Lainnya") {
      sess.step = "catat_input_kategori";
      await saveSession(chatId, sess);
      return ctx.editMessageText(`Ketik nama kategori pengeluaran Anda:\n_Contoh: Sedekah_`, { parse_mode: "MarkdownV2" });
    }

    if (isSumber) sess.source = chosen;
    else sess.category = chosen;

    sess.step = "catat_nominal";
    await saveSession(chatId, sess);
    return ctx.editMessageText(`💵 Masukkan nominal:\n_Contoh: 25000 / 25rb / 1jt_`, { parse_mode: "MarkdownV2" });
  }

  if (data === "catat_isi_keterangan") {
    sess.step = "catat_keterangan";
    await saveSession(chatId, sess);
    return ctx.editMessageText(`Ketik keterangan:`, { parse_mode: "MarkdownV2" });
  }

  if (data === "catat_skip_keterangan") {
    sess.note = "";
    await saveSession(chatId, sess);
    return sendCatatPreview(ctx, sess);
  }

  if (data === "catat_ubah_nominal") {
    sess.step = "catat_nominal";
    await saveSession(chatId, sess);
    return ctx.editMessageText(`💵 Masukkan nominal:\n_Contoh: 25000 / 25rb / 1jt_`, { parse_mode: "MarkdownV2" });
  }

  if (data === "catat_simpan") {
    await addTransaction(ctx.from.id, sess.accountId, sess.type, sess.amount, sess.note, sess.category, sess.source);

    const acc = await getAccountById(sess.accountId, ctx.from.id);
    const icon = sess.type === "masuk" ? "⬆️" : "⬇️";
    const labelKategori = sess.type === "masuk" ? sess.source : sess.category;

    await clearSession(chatId);

    const msg = `✅ *Transaksi Berhasil Dicatat\\!*\n──────────────────\n🏦 *${esc(acc.bank_name)}*\n${esc(icon)} ${esc(labelKategori)} — ${esc(formatRupiah(sess.amount))}\n${sess.note ? `📝 _${esc(sess.note)}_\n\n` : "\n"}💰 Saldo terkini: *${esc(formatRupiah(acc.balance))}*`;

    await ctx.editMessageText(msg, { parse_mode: "MarkdownV2" });

    return analyzeAndAlert(ctx, ctx.from.id);
  }

  // ── EDIT REKENING ─────────────────────────────────────────
  if (data.startsWith("editrek_akun_")) {
    const accId = parseInt(data.replace("editrek_akun_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    
    sess.step = "editrek_pilih_aksi";
    sess.accountId = accId;
    sess.accountName = acc.bank_name;
    sess.currentBalance = acc.balance;
    await saveSession(chatId, sess);
    
    const kb = new InlineKeyboard()
      .text("💰 Koreksi Saldo", "editrek_koreksi_saldo").row()
      .text("🏷 Ganti Nama Rekening", "editrek_ganti_nama").row()
      .text("❌ Batal", "batal");
    
    return ctx.editMessageText(
      `✏️ *Edit Rekening*\n────────────────\n🏦 Rekening: *${esc(acc.bank_name)}*\n💰 Saldo saat ini: *${esc(formatRupiah(acc.balance))}*\n\nApa yang ingin diubah?`,
      { parse_mode: "MarkdownV2", reply_markup: kb }
    );
  }

  if (data === "editrek_koreksi_saldo") {
    sess.step = "editrek_input_saldo";
    await saveSession(chatId, sess);
    return ctx.editMessageText(
      `💰 *Masukkan saldo yang BENAR:*\n_Saldo saat ini: ${esc(formatRupiah(sess.currentBalance))}_\n\n_Contoh: 500000 / 500rb / 2jt_`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (data === "editrek_ganti_nama") {
    sess.step = "editrek_input_nama";
    await saveSession(chatId, sess);
    return ctx.editMessageText(
      `🏷 *Masukkan nama rekening yang baru:*\n_Nama saat ini: ${esc(sess.accountName)}_\n\n_Contoh: BCA Utama, Dana Darurat_`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (data === "editrek_simpan_saldo") {
    const oldBalance = sess.currentBalance;
    const newBalance = sess.newBalance;
    
    if (newBalance === oldBalance) {
      await clearSession(chatId);
      return ctx.editMessageText(`ℹ️ Saldo tidak berubah\\.`, { parse_mode: "MarkdownV2" });
    }
    
    // Update account balance
    await updateAccountBalance(sess.accountId, ctx.from.id, newBalance);
    
    // Record correction transaction
    const diff = newBalance - oldBalance;
    const type = diff > 0 ? "masuk" : "keluar";
    const amount = Math.abs(diff);
    await addTransaction(ctx.from.id, sess.accountId, type, amount, "Koreksi saldo manual", "⚙️ Koreksi", "");
    
    await clearSession(chatId);
    
    return ctx.editMessageText(
      `✅ *Saldo Berhasil Diperbarui\\!*\n────────────────\n🏦 ${esc(sess.accountName)}\n💰 Saldo baru: *${esc(formatRupiah(newBalance))}*`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (data === "editrek_simpan_nama") {
    const oldName = sess.accountName;
    const newName = sess.newName;
    
    await updateAccountName(sess.accountId, ctx.from.id, newName);
    await clearSession(chatId);
    
    return ctx.editMessageText(
      `✅ *Nama Rekening Berhasil Diubah\\!*\n────────────────\n💳 ${esc(oldName)} → *${esc(newName)}*`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── TEXT MESSAGE HANDLER ──────────────────────────────────────
bot.on("message:text", async (ctx) => {
  // Security: Rate limiting
  if (isRateLimited(ctx.from.id)) return;

  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const sess = await getSession(chatId);

  // Security: Input length validation
  const MAX_LENGTHS = {
    tambahbank_nama:       50,
    tambahbank_saldo:      20,
    tambahkategori_nama:   30,
    setlimit_nominal:      20,
    catat_input_kategori:  30,
    catat_nominal:         20,
    catat_keterangan:     100,
    editrek_input_saldo:   20,
    editrek_input_nama:    50,
  };

  const maxLen = MAX_LENGTHS[sess.step];
  if (maxLen && text.length > maxLen) {
    return ctx.reply(
      `⚠️ Terlalu panjang\\. Maksimal ${maxLen} karakter\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (sess.step === "tambahbank_nama") {
    sess.bankName = text;
    sess.step = "tambahbank_saldo";
    await saveSession(chatId, sess);
    return ctx.reply(`💳 Nama rekening: *${esc(text)}*\n\nSekarang ketik *saldo awal* rekening ini:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "tambahbank_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
    await addAccount(ctx.from.id, sess.bankName, nominal);
    await clearSession(chatId);
    return ctx.reply(`✅ *Rekening Berhasil Ditambahkan\\!*\n\n🏦 Bank: *${esc(sess.bankName)}*\n💰 Saldo Awal: *${esc(formatRupiah(nominal))}*\n\nGunakan /catat untuk mulai mencatat transaksi\\.`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "tambahkategori_nama") {
    await addCustomCategory(ctx.from.id, text);
    await clearSession(chatId);
    return ctx.reply(`✅ Kategori *${esc(text)}* berhasil ditambahkan\\!`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "setlimit_nominal") {
    const nominal = parseNominal(text);
    if (text === "0" || isValidNominal(nominal)) {
      await updateDailyLimit(ctx.from.id, text === "0" ? 0 : nominal);
      await clearSession(chatId);
      return ctx.reply(`✅ Batas pengeluaran harian berhasil diatur ke: *${esc(text === "0" ? "Tidak Terbatas" : formatRupiah(nominal))}*`, { parse_mode: "MarkdownV2" });
    }
    return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 150000 / 150rb_`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "catat_input_kategori") {
    sess.category = text;
    sess.step = "catat_nominal";
    await saveSession(chatId, sess);
    await upsertCategorySuggestion(ctx.from.id, text);
    return ctx.reply(`💵 Masukkan nominal:\n_Contoh: 25000 / 25rb / 1jt_`, { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "catat_nominal") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 25000 / 25rb / 1jt_`, { parse_mode: "MarkdownV2" });

    sess.amount = nominal;
    sess.step = "catat_keterangan_prompt";
    await saveSession(chatId, sess);

    const kb = new InlineKeyboard()
      .text("✏️ Tambah Keterangan", "catat_isi_keterangan")
      .text("⏭ Lewati", "catat_skip_keterangan");
    return ctx.reply(`📝 Tambah keterangan? \\(opsional\\)`, { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (sess.step === "catat_keterangan") {
    sess.note = text;
    await saveSession(chatId, sess);
    return sendCatatPreview(ctx, sess);
  }

  // ── EDIT REKENING TEXT INPUTS ──────────────────────────────
  if (sess.step === "editrek_input_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal) && nominal !== 0) {
      return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
    }
    
    sess.newBalance = nominal;
    const oldBalance = sess.currentBalance;
    const diff = nominal - oldBalance;
    const selisih = diff >= 0 ? `\\+${esc(formatRupiah(diff))}` : `\\-${esc(formatRupiah(Math.abs(diff)))}`;
    
    sess.step = "editrek_konfirmasi_saldo";
    await saveSession(chatId, sess);
    
    const kb = new InlineKeyboard()
      .text("✅ Ya, Ubah Saldo", "editrek_simpan_saldo").row()
      .text("❌ Batal", "batal");
    
    return ctx.reply(
      `🔍 *Konfirmasi Perubahan Saldo*\n────────────────\n🏦 Rekening: *${esc(sess.accountName)}*\n💰 Saldo Lama: *${esc(formatRupiah(oldBalance))}*\n✅ Saldo Baru: *${esc(formatRupiah(nominal))}*\n📊 Selisih: ${selisih}`,
      { parse_mode: "MarkdownV2", reply_markup: kb }
    );
  }

  if (sess.step === "editrek_input_nama") {
    if (text.length < 2 || text.length > 50) {
      return ctx.reply(`⚠️ Nama harus 2\\-50 karakter\\.`, { parse_mode: "MarkdownV2" });
    }
    
    sess.newName = text;
    sess.step = "editrek_konfirmasi_nama";
    await saveSession(chatId, sess);
    
    const kb = new InlineKeyboard()
      .text("✅ Ya, Ubah Nama", "editrek_simpan_nama").row()
      .text("❌ Batal", "batal");
    
    return ctx.reply(
      `🔍 *Konfirmasi Perubahan Nama*\n────────────────\n💳 Nama Lama: *${esc(sess.accountName)}*\n✅ Nama Baru: *${esc(text)}*`,
      { parse_mode: "MarkdownV2", reply_markup: kb }
    );
  }
});

// ── VERCEL HANDLER ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ status: "MyDuit Ku Bot is running 💰" });
  }

  // Security: Validate request is from Telegram
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    console.warn("Unauthorized webhook request blocked");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await ensureDB();
    await bot.handleUpdate(req.body);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(200).json({ ok: false });
  }
}
