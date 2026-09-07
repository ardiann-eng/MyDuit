// api/webhook.js
import { Bot, InlineKeyboard, InputFile } from "grammy";
import {
  initDB, upsertUser, addAccount, getAccounts,
  getAccountById, deleteAccount, addTransaction, addTransactions, correctAccountBalance,
  createTransfer, getTransactionById, deleteTransaction, deleteTransfer, updateTransactionNote, updateTransactionAmount,
  addSolWallet, getSolWallets, getSolWalletById, updateSolWalletBalance, setSolWalletError, renameSolWallet, replaceSolWalletAddress, deleteSolWallet,
  addEthWallet, getEthWallets, getEthWalletById, updateEthWalletBalance, setEthWalletError, renameEthWallet, replaceEthWalletAddress, deleteEthWallet,
  getRecentTransactions, addCustomCategory, getCustomCategories,
  getUserSettings, updateDailyLimit, getDailySpend, getWeeklySpend,
  logAlert, getTransactionsByDateRange,
  getTransactionsForCurrentMonth, getTransactionsForCurrentWeek, getTransactionsForMonth,
  getCategorySuggestions, upsertCategorySuggestion, updateSmartLimit,
  getAlertLogWithCooldown,
  getSessionData, setSessionData, clearSessionData,
  updateAccountBalance, updateAccountName
} from "../lib/db.js";
import { formatRupiah, formatDate, esc } from "../lib/format.js";
import { isValidSolanaAddress, getNativeSolBalances, formatSol, shortenSolAddress } from "../lib/solana.js";
import { isValidEthereumAddress, getNativeEthBalances, formatEth, shortenEthAddress } from "../lib/ethereum.js";

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
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN, {
  botInfo: {
    id: 8639267051,
    is_bot: true,
    first_name: "MyDuit Ku",
    username: "my_duitbot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
  }
});

// Force Webhook Reply to eliminate network round-trip for ctx.reply
bot.api.config.canUseWebhookReply = (method) => true;

let dbInitialized = false;
const initPromise = initDB()
  .then(() => { dbInitialized = true; })
  .catch(err => console.error("DB init error:", err));

let solPriceCache = { value: null, expiresAt: 0 };



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
  .text("↔️ Transfer", "menu_transfer")
  .text("📋 Riwayat", "menu_riwayat").row()
  .text("☰ Menu Lainnya", "menu_lainnya");

const moreMenuKeyboard = new InlineKeyboard()
  .text("🔮 Proyeksi Saldo", "menu_prediksi")
  .text("📊 Laporan", "menu_laporan").row()
  .text("📥 Export CSV", "menu_export")
  .text("📸 Scan Screenshot", "menu_scan").row()
  .text("🏦 Tambah Rekening", "menu_tambahbank")
  .text("✏️ Edit Rekening", "menu_editrekening").row()
  .text("👛 Wallet", "menu_wallet")
  .text("⚙️ Pengaturan", "menu_settings")
  .text("🏠 Menu Utama", "menu_start");

const pengaturanKeyboard = new InlineKeyboard()
  .text("🗑 Hapus Rekening", "menu_hapusbank").row()
  .text("➕ Tambah Kategori Custom", "menu_tambahkategori").row()
  .text("🎯 Set Limit Harian", "menu_setlimit").row()
  .text("🏠 Menu Utama", "menu_start");

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

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
}

function getWibDateKey(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === "year").value);
  const month = Number(parts.find((part) => part.type === "month").value) - 1;
  const day = Number(parts.find((part) => part.type === "day").value);
  return new Date(Date.UTC(year, month, day + offsetDays)).toISOString().slice(0, 10);
}

function getTransactionWibDateKey(createdAt) {
  return new Date(`${createdAt.replace(' ', 'T')}Z`)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
}

function createOperationId() {
  return globalThis.crypto.randomUUID();
}

function createNavigationKeyboard(...actions) {
  const keyboard = new InlineKeyboard();
  for (const [label, callback] of actions) keyboard.text(label, callback);
  if (actions.length > 1) keyboard.row();
  return keyboard.text("🏠 Menu Utama", "menu_start");
}

function createReportKeyboard() {
  return new InlineKeyboard()
    .text("📅 Minggu Ini", "laporan_minggu")
    .text("📊 Bulan Ini", "laporan_bulan").row()
    .text("📥 Export CSV", "menu_export")
    .text("🏠 Menu Utama", "menu_start");
}

function parseCallbackId(data, prefix) {
  const raw = data.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

async function syncSolWallet(wallet) {
  try {
    const [lamports] = await getNativeSolBalances([wallet.address]);
    await updateSolWalletBalance(wallet.id, lamports);
    return lamports;
  } catch (error) {
    await setSolWalletError(wallet.id, error.message);
    throw error;
  }
}

async function syncEthWallet(wallet) {
  try {
    const [wei] = await getNativeEthBalances([wallet.address]);
    await updateEthWalletBalance(wallet.id, wei);
    return wei;
  } catch (error) {
    await setEthWalletError(wallet.id, error.message);
    throw error;
  }
}

function createEthWalletActions(wallet) {
  return new InlineKeyboard()
    .text("🔄 Sinkronkan", `eth_wallet_sync_${wallet.id}`)
    .text("✏️ Ganti Nama", `eth_wallet_rename_${wallet.id}`).row()
    .text("🔗 Ganti Address", `eth_wallet_address_${wallet.id}`).row()
    .text("🗑 Hapus Wallet", `eth_wallet_delete_${wallet.id}`).row()
    .text("⬅️ Semua Wallet", "menu_wallet");
}

async function handleEthWallet(ctx) {
  await clearSession(ctx.chat.id);
  const wallets = await getEthWallets(ctx.from.id);
  let text = "⟠ *Wallet ETH Robinhood*\n_Pantau saldo ETH dari public address Robinhood_\n\n";
  if (!wallets.length) text += "Belum ada wallet aktif\\. Tambahkan public address untuk mulai memantau saldo\\.\n";
  for (const wallet of wallets) {
    text += `⟠ *${esc(wallet.label)}*\n💰 ${esc(wallet.last_balance_wei ? formatEth(wallet.last_balance_wei) : "Belum disinkronkan")}\n🔗 \`${shortenEthAddress(wallet.address)}\`\n\n`;
  }
  const kb = new InlineKeyboard().text("➕ Tambah Wallet", "wallet_add");
  for (const wallet of wallets) kb.row().text(`⟠ ${wallet.label}`, `eth_wallet_pick_${wallet.id}`);
  kb.row().text("🏠 Menu Utama", "menu_start");
  return ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

function getWalletBalance(wallet) {
  return wallet.last_balance_lamports ? formatSol(wallet.last_balance_lamports) : "Belum disinkronkan";
}

function createWalletActions(wallet) {
  return new InlineKeyboard()
    .text("🔄 Sinkronkan", `wallet_sync_${wallet.id}`)
    .text("✏️ Ganti Nama", `wallet_rename_${wallet.id}`).row()
    .text("🔗 Ganti Address", `wallet_address_${wallet.id}`).row()
    .text("🗑 Hapus Wallet", `wallet_delete_${wallet.id}`).row()
    .text("⬅️ Semua Wallet", "menu_wallet");
}

async function formatWalletDetail(wallet) {
  const lamports = wallet.last_balance_lamports;
  const balance = lamports ? formatSolEstimate(BigInt(lamports), await getSolPrices()) : "Belum disinkronkan";
  return `🪙 *${esc(wallet.label)}*\n\n` +
    `🟣 *Your Solana Wallet Address*\n` +
    `├ \`${wallet.address}\`\n` +
    `└ *${esc(balance)}*`;
}

async function getSolPrices() {
  if (solPriceCache.expiresAt > Date.now()) return solPriceCache.value;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
     const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd,idr", { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`SOL price HTTP ${response.status}`);
     const body = await response.json();
     const solana = body?.solana;
     const ethereum = body?.ethereum;
     const prices = {
       usd: Number(solana?.usd),
       idr: Number(solana?.idr),
       ethUsd: Number(ethereum?.usd),
       ethIdr: Number(ethereum?.idr),
     };
     if (!Number.isFinite(prices.usd) || prices.usd <= 0 || !Number.isFinite(prices.idr) || prices.idr <= 0) throw new Error("Crypto price response invalid");
    solPriceCache = { value: prices, expiresAt: Date.now() + 5 * 60 * 1000 };
    return prices;
  } catch (error) {
    console.warn("SOL price unavailable:", error.message);
    solPriceCache = { value: null, expiresAt: Date.now() + 60 * 1000 };
    return null;
  }
}

function formatSolEstimate(lamports, solPrices) {
  const sol = Number(lamports) / 1_000_000_000;
  if (!solPrices?.usd || !Number.isFinite(sol)) return `${formatSol(lamports)} (estimasi USD belum tersedia)`;
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(sol * solPrices.usd);
  return `${formatSol(lamports)} (≈ ${usd})`;
}

function formatEthEstimate(wei, solPrices) {
  const eth = Number(wei) / 1_000_000_000_000_000_000;
  if (!solPrices?.ethUsd || !Number.isFinite(eth)) return `${formatEth(wei)} (estimasi USD belum tersedia)`;
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(eth * solPrices.ethUsd);
  return `${formatEth(wei)} (≈ ${usd})`;
}

async function syncAllUserWallets(telegramId) {
  const [solWallets, ethWallets] = await Promise.all([getSolWallets(telegramId), getEthWallets(telegramId)]);
  const solTasks = solWallets.map(w => syncSolWallet(w).catch(() => {}));
  const ethTasks = ethWallets.map(w => syncEthWallet(w).catch(() => {}));
  await Promise.all([...solTasks, ...ethTasks]);
}

async function handleWallet(ctx) {
  await clearSession(ctx.chat.id);
  const [solWallets, ethWallets] = await Promise.all([getSolWallets(ctx.from.id), getEthWallets(ctx.from.id)]);
  const totalCount = solWallets.length + ethWallets.length;
  let text = "👛 *Multi\\-Wallet Manager*\n_Pantau saldo semua wallet Solana & ETH Robinhood_\n\n";
  if (!totalCount) text += "Belum ada wallet aktif\\. Tambahkan public address untuk mulai memantau saldo\\.\n";
  else text += `📊 *Total Wallet Aktif: ${totalCount}*\n\n`;

  for (const wallet of solWallets) {
    text += `🪙 *${esc(wallet.label)}* ${esc("(Solana)")}\n💰 ${esc(getWalletBalance(wallet))}\n🔗 \`${shortenSolAddress(wallet.address)}\`\n\n`;
  }
  for (const wallet of ethWallets) {
    text += `⟠ *${esc(wallet.label)}* ${esc("(ETH Robinhood)")}\n💰 ${esc(wallet.last_balance_wei ? formatEth(wallet.last_balance_wei) : "Belum disinkronkan")}\n🔗 \`${shortenEthAddress(wallet.address)}\`\n\n`;
  }
  const kb = new InlineKeyboard();
  kb.text("➕ Tambah Wallet", "wallet_add");
  if (totalCount > 0) kb.text("🔄 Sinkronkan Semua", "wallet_sync_all");
  kb.row();
  for (const wallet of solWallets) kb.row().text(`🪙 ${wallet.label}`, `wallet_pick_${wallet.id}`);
  for (const wallet of ethWallets) kb.row().text(`⟠ ${wallet.label}`, `eth_wallet_pick_${wallet.id}`);
  kb.row().text("🏠 Menu Utama", "menu_start");

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: "MarkdownV2", reply_markup: kb }).catch(() => ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb }));
  }
  return ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

async function handleTransfer(ctx, editMessage = false) {
  await clearSession(ctx.chat.id);
  const accounts = await getAccounts(ctx.from.id);
  const reply = editMessage ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
  if (accounts.length < 2) return reply("↔️ Kamu butuh minimal dua rekening untuk transfer\\.", {
    parse_mode: "MarkdownV2",
    reply_markup: createNavigationKeyboard(["🏦 Tambah Rekening", "menu_tambahbank"]),
  });
  await saveSession(ctx.chat.id, { step: "transfer_from" });
  const kb = new InlineKeyboard();
  for (const account of accounts) kb.text(`🏦 ${account.bank_name} (${formatRupiah(account.balance)})`, `transfer_from_${account.id}`).row();
  kb.text("❌ Batal", "batal");
  return reply("↔️ *Transfer Antar Rekening*\n\nPilih rekening sumber\\.", { parse_mode: "MarkdownV2", reply_markup: kb });
}

async function sendTransferPreview(ctx, sess) {
  const text = `↔️ *Konfirmasi Transfer*\n\n🏦 ${esc(sess.fromAccountName)}\n⬇️ *${esc(formatRupiah(sess.transferAmount))}*\n🏦 ${esc(sess.toAccountName)}\n⬆️ *${esc(formatRupiah(sess.transferAmount))}*${sess.transferNote ? `\n📝 _${esc(sess.transferNote)}_` : ""}`;
  const kb = new InlineKeyboard()
    .text("✅ Transfer", "transfer_save")
    .text("✏️ Ubah Nominal", "transfer_edit_amount").row()
    .text("📝 Ubah Catatan", "transfer_edit_note")
    .text("❌ Batal", "batal");
  return ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
}

function getYearMonth(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function formatExportMonth(yearMonth) {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("id-ID", {
    month: "long",
    year: "numeric",
  });
}

function escapeCsvCell(value) {
  let text = String(value ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildTransactionsCsv(txs) {
  const header = ["Tanggal", "Jenis", "Nominal", "Rekening", "Kategori", "Sumber", "Keterangan"];
  const rows = txs.map((tx) => [
    tx.created_at,
    tx.is_transfer ? "Transfer" : tx.type === "masuk" ? "Pemasukan" : "Pengeluaran",
    tx.amount,
    tx.bank_name,
    tx.category || "Lainnya",
    tx.source || "",
    tx.note || "",
  ]);
  return "\uFEFF" + [header, ...rows]
    .map((row) => row.map(escapeCsvCell).join(","))
    .join("\r\n");
}

function createExportKeyboard() {
  const keyboard = new InlineKeyboard().text("📥 Export Bulan Ini", "export_csv_current").row();
  const now = new Date();
  for (let offset = 1; offset < 6; offset++) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const yearMonth = getYearMonth(date);
    keyboard.text(formatExportMonth(yearMonth), `export_csv_${yearMonth}`).row();
  }
  return keyboard;
}

async function showExportMenu(ctx) {
  await clearSession(ctx.chat.id);
  return ctx.reply("📥 *Export Transaksi CSV*\n\nPilih periode transaksi untuk diunduh\\.", {
    parse_mode: "MarkdownV2",
    reply_markup: createExportKeyboard(),
  });
}

async function exportTransactionsCsv(ctx, yearMonth) {
  const txs = await getTransactionsForMonth(ctx.from.id, yearMonth);
  const monthLabel = formatExportMonth(yearMonth);

  if (txs.length === 0) {
    return ctx.reply(`📥 Belum ada transaksi pada ${esc(monthLabel)}\\.`, { parse_mode: "MarkdownV2" });
  }

  const filename = `myduit-transaksi-${yearMonth}.csv`;
  await ctx.replyWithDocument(new InputFile(Buffer.from(buildTransactionsCsv(txs), "utf8"), filename), {
    caption: `📥 Export ${monthLabel}: ${txs.length} transaksi.`,
  });
}

// ── SCORE CALCULATION ──────────────────────────────────────────
async function calculateScore(telegramId, dailyLimit, prefetchedData = null) {
  try {
    let score = 50; // Base score starts at 50

    // Fetch user settings for Factor 1 (use prefetched if available)
    const settings = prefetchedData?.settings
      ? prefetchedData.settings
      : await getUserSettings(telegramId);

    // Use prefetched data if available, otherwise fetch from DB
    let todaySpend, accounts, thisMonthTxs, thisWeek, lastWeek;
    if (prefetchedData) {
      todaySpend = prefetchedData.todaySpend;
      accounts = prefetchedData.accounts;
      thisMonthTxs = prefetchedData.thisMonthTxs;
      thisWeek = prefetchedData.thisWeek;
      lastWeek = prefetchedData.lastWeek;
    } else {
      const [spend, accts, txs, tw, lw] = await Promise.all([
        getDailySpend(telegramId),
        getAccounts(telegramId),
        getTransactionsForCurrentMonth(telegramId),
        getWeeklySpend(telegramId, 0),
        getWeeklySpend(telegramId, 1),
      ]);
      todaySpend = spend;
      accounts = accts;
      thisMonthTxs = txs;
      thisWeek = tw;
      lastWeek = lw;
    }

    const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
    const totalInitialBalance = accounts.reduce((acc, a) => acc + (a.initial_balance || 0), 0);

    // ── FACTOR 1: Daily Limit Usage (range: -15 to +20) ──
    let factor1 = 0;
    let usageRatio = 0;

    let limitReference = 0;
    // Check for manual limit
    if (settings?.limit_mode === 'custom' && settings?.daily_limit > 0) {
      limitReference = settings.daily_limit;
    } else if (!prefetchedData) {
      // Calculate from weekly spend if not prefetched
      const weekSpend = await getWeeklySpend(telegramId, 0);
      limitReference = weekSpend > 0 ? weekSpend / 7 : 0;
    } else if (prefetchedData?.thisWeek) {
      limitReference = prefetchedData.thisWeek / 7;
    }

    if (limitReference > 0) {
      usageRatio = todaySpend / limitReference;
      if (todaySpend < limitReference * 0.5) factor1 = 20;
      else if (todaySpend < limitReference * 0.8) factor1 = 10;
      else if (todaySpend <= limitReference) factor1 = 0;
      else factor1 = -15;
    }

    score += factor1;

    // ── FACTOR 2: Balance Health (range: -20 to +15) ──
    let factor2 = 0;
    let balanceRatio = 1.0;

    if (totalInitialBalance > 0) {
      balanceRatio = totalBalance / totalInitialBalance;
      if (balanceRatio > 0.75) factor2 = 15;
      else if (balanceRatio >= 0.5) factor2 = 10;
      else if (balanceRatio >= 0.25) factor2 = 0;
      else if (balanceRatio >= 0.1) factor2 = -10;
      else factor2 = -20;
    }

    score += factor2;

    // ── FACTOR 3: Weekly Trend (range: -15 to +10) ──
    let factor3 = 0;

    if (lastWeek > 0) {
      if (thisWeek < lastWeek * 0.9) factor3 = 10;
      else if (thisWeek <= lastWeek * 1.1) factor3 = 5;
      else if (thisWeek <= lastWeek * 1.3) factor3 = -5;
      else factor3 = -15;
    }

    score += factor3;

    // ── FACTOR 4: Saving Rate (range: -20 to +15) ──
    let factor4 = 0;
    let savingRate = 0;

    const allTxsForSaving = await Promise.all([
      getTransactionsByDateRange(telegramId, 'masuk', 30),
      getTransactionsByDateRange(telegramId, 'keluar', 30),
    ]).then(([masuk, keluar]) => [...masuk, ...keluar]);

    // Deduplicate by id:
    const seenIds = new Set();
    const dedupedTxs = [];
    for (const tx of allTxsForSaving) {
      if (!seenIds.has(tx.id)) {
        seenIds.add(tx.id);
        dedupedTxs.push(tx);
      }
    }

    // Count distinct dates
    const distinctDates = new Set();
    let totalIncome30 = 0;
    let totalSpend30 = 0;
    for (const tx of dedupedTxs) {
      // Extract date portion from created_at
      const dateStr = tx.created_at ? tx.created_at.split(' ')[0] : '';
      if (dateStr) distinctDates.add(dateStr);

      if (tx.type === 'masuk') totalIncome30 += tx.amount;
      else if (tx.type === 'keluar') totalSpend30 += tx.amount;
    }

    // Check if sufficient data (7+ days worth)
    if (distinctDates.size >= 7 && totalIncome30 > 0) {
      savingRate = (totalIncome30 - totalSpend30) / totalIncome30;
      if (savingRate > 0.3) factor4 = 15;
      else if (savingRate >= 0.1) factor4 = 10;
      else if (savingRate >= 0) factor4 = 0;
      else factor4 = -20; // spending > income
    }

    score += factor4;

    // ── CLAMP SCORE ──
    score = Math.max(0, Math.min(100, score));

    // ── EMOJI MAPPING ──
    let scoreEmoji = "🔴 Kritis";
    if (score >= 85) scoreEmoji = "💚 Sangat Sehat";
    else if (score >= 70) scoreEmoji = "🟡 Cukup Baik";
    else if (score >= 50) scoreEmoji = "🟠 Perlu Perhatian";

    return { score, scoreEmoji, savingRate, usageRatio, balanceRatio };
  } catch (err) {
    console.error("calculateScore error:", err);
    return { score: 50, scoreEmoji: "🟠 Perlu Perhatian", savingRate: 0, usageRatio: 0, balanceRatio: 1 };
  }
}

// ── PURE LIMIT CALCULATOR (no DB calls) ───────────────────────
// Hitung limit dari data yang sudah di-fetch, tanpa DB call tambahan
function computeLimitFromData(settings, accounts) {
  if (settings?.limit_mode === 'custom' && settings?.daily_limit > 0) {
    return settings.daily_limit;
  }
  const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
  let dailyLimit = totalBalance > 0 ? totalBalance * 0.20 : 0;
  if (settings?.monthly_income > 0) {
    const incomeBasedLimit = (settings.monthly_income * 0.70) / 30;
    dailyLimit = dailyLimit > 0 ? Math.min(dailyLimit, incomeBasedLimit) : incomeBasedLimit;
    return Math.round(dailyLimit / 100) * 100;
  }
  if (dailyLimit > 0 && dailyLimit < 10000) dailyLimit = 10000;
  return Math.round(dailyLimit / 100) * 100;
}
// ── OCR: EXTRACT TEXT FROM IMAGE ──────────────────────────────
async function extractTextFromImage(imageUrl) {
  try {
    const formData = new URLSearchParams();
    formData.append('url', imageUrl);
    formData.append('apikey', process.env.OCRSPACE_API_KEY || 'helloworld');
    formData.append('language', 'eng');
    formData.append('isOverlayRequired', 'false');
    formData.append('detectOrientation', 'true');
    formData.append('scale', 'true');
    formData.append('OCREngine', '2'); // Engine 2 lebih akurat untuk screenshot
    formData.append('filetype', 'JPG');

    const response = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    const data = await response.json();
    console.log("OCR response:", JSON.stringify(data).substring(0, 500));
    if (data.IsErroredOnProcessing) {
      console.log("OCR error:", data.ErrorMessage);
      return null;
    }
    if (!data.ParsedResults || data.ParsedResults.length === 0) {
      console.log("OCR no results");
      return null;
    }
    return data.ParsedResults[0].ParsedText || null;

  } catch (err) {
    console.error("OCR API error:", err);
    return null;
  }
}

// ── OCR: PARSE TRANSACTION FROM TEXT ──────────────────────────
function parseTransactionFromText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const transactions = [];

  // Cari semua nominal Rp di teks
  const nominalRegex = /Rp\.?\s*([\d.,]+)/gi;
  let match;
  const nominalMatches = [];
  while ((match = nominalRegex.exec(text)) !== null) {
    const raw = match[1].replace(/\./g, '').replace(',', '.');
    const nominal = parseFloat(raw);
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEnd = text.indexOf('\n', match.index);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).toLowerCase();
    const isNonTransactionValue = /\b(saldo|total|subtotal|biaya|admin|limit|referensi|ref\.?|nomor rekening)\b/.test(line);
    if (!isNaN(nominal) && nominal >= 1000 && !isNonTransactionValue) {
      nominalMatches.push({ nominal, index: match.index });
    }
  }

  // Kalau tidak ada nominal sama sekali, return kosong
  if (nominalMatches.length === 0) return [];

  // Kalau hanya 1 nominal, gunakan parser lama (single transaction)
  if (nominalMatches.length === 1) {
    const lowerText = text.toLowerCase();
    const masukKeywords = ['terima', 'masuk', 'kredit', 'top up', 'topup',
      'isi saldo', 'transfer masuk', 'menerima', 'diterima'];
    const keluarKeywords = ['transfer', 'kirim', 'pembayaran', 'pembelian',
      'qris', 'tarik', 'debit', 'bayar', 'belanja'];
    const hasMasuk = masukKeywords.some(k => lowerText.includes(k));
    const hasKeluar = keluarKeywords.some(k => lowerText.includes(k));
    let type = "keluar";
    if (hasMasuk && !hasKeluar) type = "masuk";

    let merchant = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^Rp/i.test(line)) continue;
      if (/sukses|berhasil|gagal/i.test(line)) continue;
      if (/\d{2}\s+(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Ags|Sep|Okt|Nov|Des)/i.test(line)) continue;
      if (/\d{8,}/.test(line)) continue;
      if (/QRIS|Transfer|Pembelian|Pembayaran/i.test(line)) {
        if (lines[i + 1] && !/^Rp/i.test(lines[i + 1]) && !/\d{8,}/.test(lines[i + 1])) {
          merchant = lines[i + 1].trim();
        }
        continue;
      }
      if (/^[A-Z][A-Z\s\-]{2,30}$/.test(line) && !merchant) {
        merchant = line;
      }
    }

    const dateMatch = text.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|Mei|Jun|Jul|Ags|Sep|Okt|Nov|Des)\s+(\d{4}|\d{2})?/i);
    let category = "Lainnya";
    if (/alfamart|indomaret|supermarket|minimarket|warung/i.test(text)) category = "🍔 Makanan";
    else if (/grab|gojek|ojek|taxi|parkir|bensin|pertamina/i.test(text)) category = "🚗 Transport";
    else if (/listrik|pln|air|pdam|internet|telkom|wifi/i.test(text)) category = "🏠 Tagihan";
    else if (/shopee|tokopedia|lazada|bukalapak/i.test(text)) category = "👗 Gaya Hidup";
    else if (/game|steam|netflix|spotify|voucher/i.test(text)) category = "🎮 Hiburan";
    else if (/apotek|rumah sakit|dokter|klinik/i.test(text)) category = "💊 Kesehatan";
    else if (type === "masuk") category = "📦 Lainnya";

    return [{
      nominal: nominalMatches[0].nominal,
      type,
      merchant,
      date: dateMatch ? dateMatch[0] : null,
      category,
    }];
  }

  // Banyak nominal — coba parse per baris/blok
  // Strategi: setiap nominal, cari konteks di sekitarnya (3 baris sebelum)
  for (const { nominal, index } of nominalMatches) {
    // Ambil teks sekitar nominal ini (200 karakter sebelumnya)
    const contextStart = Math.max(0, index - 200);
    const context = text.substring(contextStart, index + 50).toLowerCase();

    // Detect type dari konteks lokal
    const masukKeywords = ['terima', 'masuk', 'kredit', 'top up', 'topup',
      'menerima', 'diterima', 'cr', 'credit'];
    const keluarKeywords = ['transfer', 'kirim', 'pembayaran', 'pembelian',
      'qris', 'tarik', 'debit', 'bayar', 'belanja', 'dr', 'debet'];
    const hasMasuk = masukKeywords.some(k => context.includes(k));
    const hasKeluar = keluarKeywords.some(k => context.includes(k));
    const type = (hasMasuk && !hasKeluar) ? "masuk" : "keluar";

    // Cari merchant dari baris sebelum nominal
    const contextLines = text.substring(contextStart, index)
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2);
    let merchant = null;
    for (let i = contextLines.length - 1; i >= 0; i--) {
      const line = contextLines[i];
      if (/^Rp/i.test(line)) continue;
      if (/sukses|berhasil|gagal|total|saldo/i.test(line)) continue;
      if (/\d{8,}/.test(line)) continue;
      if (/\d{2}[\/\-]\d{2}/.test(line)) continue;
      if (line.length > 3 && line.length < 40) {
        merchant = line;
        break;
      }
    }

    // Cari tanggal di konteks
    const dateMatch = context.match(/(\d{1,2})\s+(jan|feb|mar|apr|mei|jun|jul|ags|sep|okt|nov|des)/i);
    const date = dateMatch ? dateMatch[0] : null;

    // Auto-kategori dari konteks
    let category = "Lainnya";
    if (/alfamart|indomaret|supermarket|minimarket|warung/.test(context)) category = "🍔 Makanan";
    else if (/grab|gojek|ojek|taxi|parkir|bensin|pertamina/.test(context)) category = "🚗 Transport";
    else if (/listrik|pln|air|pdam|internet|telkom|wifi/.test(context)) category = "🏠 Tagihan";
    else if (/shopee|tokopedia|lazada|bukalapak/.test(context)) category = "👗 Gaya Hidup";
    else if (/game|steam|netflix|spotify|voucher/.test(context)) category = "🎮 Hiburan";
    else if (/apotek|rumah sakit|dokter|klinik/.test(context)) category = "💊 Kesehatan";
    else if (type === "masuk") category = "📦 Lainnya";

    transactions.push({ nominal, type, merchant, date, category });
  }

  return transactions;
}

async function showOcrKonfirmasi(ctx, sess, accounts) {
  const list = sess.ocrList || [];
  const i = sess.ocrIndex || 0;

  if (i >= list.length) {
    await clearSession(ctx.chat.id);
    return ctx.editMessageText(
      `✅ *Semua transaksi sudah dikonfirmasi\\!*`,
      { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🏠 Menu Utama", "menu_start") }
    );
  }

  const tx = list[i];
  const typeIcon = tx.type === "masuk" ? "⬆️" : "⬇️";
  const typeLabel = tx.type === "masuk" ? "Pemasukan" : "Pengeluaran";

  let text = `📸 *Transaksi ${i + 1} dari ${list.length}*\n\n`;
  text += `${esc(typeIcon)} Jenis    : *${esc(typeLabel)}*\n`;
  text += `💰 Nominal  : *${esc(formatRupiah(tx.nominal))}*\n`;
  if (tx.merchant) text += `🏪 Merchant : *${esc(tx.merchant)}*\n`;
  text += `📂 Kategori : *${esc(tx.category)}*\n`;
  text += `\nPeriksa detail sebelum simpan\\.`;

  const kb = new InlineKeyboard();
  if (tx.type === "keluar") {
    kb.text("🏷 Ubah Kategori", "ocr_ubah_kategori").row();
  }
  kb.text("✏️ Ubah Nominal", "ocr_ubah_nominal")
    .text("↕️ Ubah Jenis", "ocr_ubah_jenis").row();
  for (const acc of accounts) {
    kb.text(`🏦 ${acc.bank_name}`, `ocr_simpan1_${acc.id}`).row();
  }
  kb.text("⏭ Lewati", "ocr_lewati").text("❌ Batal Semua", "batal");

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: "MarkdownV2", reply_markup: kb });
  }
  return ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: kb });
}
// ── ML SMART LIMIT ─────────────────────────────────────────────
async function calculateSmartLimit(telegramId) {
  const settings = await getUserSettings(telegramId);

  // Respect custom limit
  if (settings.limit_mode === 'custom' && settings.daily_limit > 0) {
    return settings.daily_limit;
  }

  // Auto mode: always recalculate from current balance
  const accounts = await getAccounts(telegramId);
  const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);

  let dailyLimit = totalBalance * 0.20;

  if (settings.monthly_income > 0) {
    const incomeBasedLimit = (settings.monthly_income * 0.70) / 30;
    dailyLimit = Math.min(dailyLimit, incomeBasedLimit);
  }

  if (dailyLimit < 10000) dailyLimit = 10000;
  dailyLimit = Math.round(dailyLimit / 100) * 100;

  await updateSmartLimit(telegramId, dailyLimit);
  return dailyLimit;
}

// ── SMART ALERT SYSTEM ─────────────────────────────────────────
async function analyzeAndAlert(ctx, telegramId) {
  try {
    // FIX: fetch settings parallel bersama data lain
    // Jangan panggil calculateSmartLimit — dia punya 3 sequential DB calls!
    const [accounts, settings, todaySpend, thisWeek, lastWeek, thisMonthTxs] =
      await Promise.all([
        getAccounts(telegramId),
        getUserSettings(telegramId),
        getDailySpend(telegramId),
        getWeeklySpend(telegramId, 0),
        getWeeklySpend(telegramId, 1),
        getTransactionsForCurrentMonth(telegramId),
      ]);

    // Hitung limit dari data yang sudah ada — zero DB calls tambahan
    const dailyLimit = computeLimitFromData(settings, accounts);

    // Simpan limit ke DB tanpa menunggu (fire and forget)
    updateSmartLimit(telegramId, dailyLimit).catch(() => { });

    // Build prefetchedData — sertakan settings agar calculateScore
    // tidak fetch getUserSettings lagi di dalamnya
    const prefetchedData = {
      todaySpend,
      accounts,
      thisMonthTxs,
      thisWeek,
      lastWeek,
      settings,
    };

    // Get scorecard dengan prefetched data (zero redundant DB calls)
    const scorecard = await calculateScore(telegramId, dailyLimit, prefetchedData);
    const { score, scoreEmoji, savingRate, usageRatio, balanceRatio } = scorecard;

    // Compute derived stats from already-fetched data
    const totalBalance = accounts.reduce((acc, a) => acc + a.balance, 0);
    const totalInitialBalance = accounts.reduce((acc, a) => acc + (a.initial_balance || 0), 0);

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

    let msg = `📊 *Analisis Transaksi*\n\n`;
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
async function showMainMenu(ctx) {
  const name = ctx.from.first_name || "Pengguna";
  const t0 = Date.now();

  try {
    const t1 = Date.now();
    const [
      accounts,
      settings,
      todaySpend,
      thisWeek,
      lastWeek,
      thisMonthTxs,
       wallets,
       ethWallets,
    ] = await Promise.all([
      getAccounts(ctx.from.id),
      getUserSettings(ctx.from.id),
      getDailySpend(ctx.from.id),
      getWeeklySpend(ctx.from.id, 0),
      getWeeklySpend(ctx.from.id, 1),
      getTransactionsForCurrentMonth(ctx.from.id),
       getSolWallets(ctx.from.id),
       getEthWallets(ctx.from.id),
    ]);
    console.log(`⏱ /start step2 parallel fetch: ${Date.now() - t1}ms`);

    const dailyLimit = computeLimitFromData(settings, accounts);

    updateSmartLimit(ctx.from.id, dailyLimit).catch(err =>
      console.error("updateSmartLimit error:", err)
    );

    const prefetchedData = { todaySpend, accounts, thisMonthTxs, thisWeek, lastWeek, settings };

    const t2 = Date.now();
    const scorecard = await calculateScore(ctx.from.id, dailyLimit, prefetchedData);
    console.log(`⏱ /start step3 calculateScore: ${Date.now() - t2}ms`);
    const { score, scoreEmoji } = scorecard;

    const totalSaldo = accounts.reduce((sum, acc) => sum + acc.balance, 0);
    const syncedWallets = wallets.filter((wallet) => wallet.last_balance_lamports !== null && wallet.last_balance_lamports !== undefined);
    const totalLamports = syncedWallets.reduce((sum, wallet) => sum + BigInt(wallet.last_balance_lamports), 0n);
    const syncedEthWallets = ethWallets.filter((wallet) => wallet.last_balance_wei !== null && wallet.last_balance_wei !== undefined);
    const totalWei = syncedEthWallets.reduce((sum, wallet) => sum + BigInt(wallet.last_balance_wei), 0n);

    // --- DYNAMIC TIP (score-based, max 1 line) ---
    let tip;
    if (accounts.length === 0) {
      tip = "Tambah rekening pertamamu biar bisa mulai tracking\\!";
    } else if (score >= 85) {
      tip = "Keuanganmu sehat banget hari ini, pertahankan\\! 🔥";
    } else if (score >= 70) {
      tip = "Hampir sempurna\\! Terus jaga pengeluaranmu ya\\.";
    } else if (score >= 50) {
      tip = "Mulai waspada, cek kategori pengeluaran terbesarmu\\!";
    } else {
      tip = "Kondisi kritis\\! Tunda pengeluaran non\\-esensial dulu ya\\.";
    }

    const solPrices = syncedWallets.length || syncedEthWallets.length ? await getSolPrices() : null;
    const solValueIdr = solPrices?.idr ? Number(totalLamports) / 1_000_000_000 * solPrices.idr : 0;
    const ethValueIdr = solPrices?.ethIdr ? Number(totalWei) / 1_000_000_000_000_000_000 * solPrices.ethIdr : 0;
    const totalAset = totalSaldo + solValueIdr + ethValueIdr;

    let text = `👋 Halo, *${esc(name)}\\!*\nRingkasan kondisi keuangan & aset kamu hari ini:\n\n`;
    text += `💼 *Total Aset*\n└ *${esc(formatRupiah(totalAset))}*\n\n`;

    if (accounts.length > 0) {
      text += `🏦 *Rekening Bank*\n└ *${esc(formatRupiah(totalSaldo))}* ${esc(`(${accounts.length} rekening)`)}\n\n`;
    }

    const totalWalletCount = wallets.length + ethWallets.length;
    if (totalWalletCount > 0) {
      text += `🌐 *Web3 Wallet* ${esc(`(${totalWalletCount} aktif)`)}\n`;
      const solPart = syncedWallets.length ? formatSolEstimate(totalLamports, solPrices) : "Belum disinkronkan";
      const ethPart = syncedEthWallets.length ? formatEthEstimate(totalWei, solPrices) : "Belum disinkronkan";
      if (wallets.length && ethWallets.length) {
        text += `├ 🟣 Solana: *${esc(solPart)}*\n`;
        text += `└ 🔵 ETH Robinhood: *${esc(ethPart)}*\n\n`;
      } else if (wallets.length) {
        text += `└ 🟣 Solana: *${esc(solPart)}*\n\n`;
      } else if (ethWallets.length) {
        text += `└ 🔵 ETH Robinhood: *${esc(ethPart)}*\n\n`;
      }
    }

    text += `🎯 Skor Keuangan: *${esc((accounts.length ? score : 0).toString())}/100*${accounts.length ? ` ${esc(scoreEmoji)}` : ""}\n`;
    text += `💡 _${tip}_\n\nPilih aksi di bawah untuk mulai: 👇`;

    const t3 = Date.now();
    await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: startKeyboard });
    console.log(`⏱ /start step4 reply: ${Date.now() - t3}ms`);
    console.log(`⏱ /start TOTAL: ${Date.now() - t0}ms`);

  } catch (err) {
    console.error("showMainMenu error:", err);
    await ctx.reply(
      `👋 Hai, *${esc(name)}\\!*\n` +
      `Yuk cek kondisi keuanganmu hari ini\\! 🔍\n\n` +
      `Yuk mulai cek atau catat transaksi baru\\! 👇`,
      { parse_mode: "MarkdownV2", reply_markup: startKeyboard }
    );
  }
}

bot.command("start", async (ctx) => {
  await Promise.all([
    upsertUser(ctx.from.id, ctx.from.first_name || "Pengguna"),
    clearSession(ctx.chat.id),
  ]);
  return showMainMenu(ctx);
});

async function handleSaldo(ctx) {
  await clearSession(ctx.chat.id);
  const [accounts, wallets, ethWallets] = await Promise.all([getAccounts(ctx.from.id), getSolWallets(ctx.from.id), getEthWallets(ctx.from.id)]);
  if (!accounts.length && !wallets.length && !ethWallets.length) return ctx.reply(`💳 Belum ada rekening atau wallet tercatat\\.\n\nGunakan /tambahbank atau buka menu Wallet untuk menambahkan aset pertama\\.`, { parse_mode: "MarkdownV2" });

  let total = 0;
  let text = `💼 *Saldo & Aset*\n\n`;
  for (const acc of accounts) {
    const icon = acc.balance >= 0 ? "🟢" : "🔴";
    text += `${icon} *${esc(acc.bank_name)}*\n└ *${esc(formatRupiah(acc.balance))}*\n\n`;
    total += acc.balance;
  }
  const syncedWallets = wallets.filter((wallet) => wallet.last_balance_lamports !== null && wallet.last_balance_lamports !== undefined);
  const syncedEthWallets = ethWallets.filter((wallet) => wallet.last_balance_wei !== null && wallet.last_balance_wei !== undefined);
  if (wallets.length || ethWallets.length) {
    const totalLamports = syncedWallets.reduce((sum, wallet) => sum + BigInt(wallet.last_balance_lamports), 0n);
    const totalWei = syncedEthWallets.reduce((sum, wallet) => sum + BigInt(wallet.last_balance_wei), 0n);
    const solPrices = syncedWallets.length || syncedEthWallets.length ? await getSolPrices() : null;
    text += `👛 *Wallet*\n\n`;
    for (const wallet of wallets) {
      const balance = wallet.last_balance_lamports
        ? formatSolEstimate(BigInt(wallet.last_balance_lamports), solPrices)
        : "Belum disinkronkan";
      text += `🟣 *${esc(wallet.label)}*\n├ \`${shortenSolAddress(wallet.address)}\`\n└ *${esc(balance)}*\n\n`;
    }
    for (const wallet of ethWallets) {
      const balance = wallet.last_balance_wei
        ? formatEthEstimate(wallet.last_balance_wei, solPrices)
        : "Belum disinkronkan";
      text += `🔵 *${esc(wallet.label)}* ${esc("(ETH Robinhood)")}\n├ \`${shortenEthAddress(wallet.address)}\`\n└ *${esc(balance)}*\n\n`;
    }
    const solValueIdr = solPrices?.idr ? Number(totalLamports) / 1_000_000_000 * solPrices.idr : 0;
    const ethValueIdr = solPrices?.ethIdr ? Number(totalWei) / 1_000_000_000_000_000_000 * solPrices.ethIdr : 0;
    const totalAssets = total + solValueIdr + ethValueIdr;
    text += `📊 *Total Aset*\n└ *${esc(formatRupiah(totalAssets))}*`;
  } else {
    text += `📊 *Total Aset*\n└ *${esc(formatRupiah(total))}*`;
  }
  await ctx.reply(text, {
    parse_mode: "MarkdownV2",
    reply_markup: createNavigationKeyboard(["✏️ Edit Rekening", "menu_editrekening"], ["👛 Wallet", "menu_wallet"]),
  });
}

async function handleRiwayat(ctx, page = 0, edit = false) {
  await clearSession(ctx.chat.id);
  const pageSize = 10;
  const safePage = Math.max(0, parseInt(page) || 0);
  const txs = await getRecentTransactions(ctx.from.id, pageSize + 1, safePage * pageSize, 30);
  if (txs.length === 0) return ctx.reply(`📋 Belum ada transaksi tercatat\\.\n\nGunakan /catat untuk mencatat transaksi pertama\\.`, { parse_mode: "MarkdownV2" });
  const hasNextPage = txs.length > pageSize;
  const visibleTxs = txs.slice(0, pageSize);

  const [accounts, settings, todaySpend] = safePage === 0
    ? await Promise.all([
      getAccounts(ctx.from.id),
      getUserSettings(ctx.from.id),
      getDailySpend(ctx.from.id),
    ])
    : [[], null, 0];
  const dailyLimit = computeLimitFromData(settings, accounts);
  if (safePage === 0) updateSmartLimit(ctx.from.id, dailyLimit).catch(() => { });

  const totalSaldo = accounts.reduce((sum, a) => sum + a.balance, 0);

  let text = `*Riwayat Transaksi* · 30 Hari Terakhir\n\n`;
  for (const [index, tx] of visibleTxs.entries()) {
    const dateStrRaw = tx.created_at.split(' ')[0]; // "YYYY-MM-DD"
    const nextTx = visibleTxs[index + 1];
    const isLastInDate = !nextTx || nextTx.created_at.split(' ')[0] !== dateStrRaw;

    if (index === 0 || visibleTxs[index - 1].created_at.split(' ')[0] !== dateStrRaw) {
      const dateObj = new Date(dateStrRaw + 'T00:00:00');
      const dateLabel = dateObj.toLocaleDateString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      if (index > 0) text += '\n';
      text += `*${esc(dateLabel)}*\n`;
    }

    const icon = tx.is_transfer ? "🔄" : tx.type === "masuk" ? "💰" : "💸";
    const label = tx.is_transfer ? "Transfer antar rekening" : tx.type === "masuk" ? (tx.source || "Lainnya") : (tx.category || "Lainnya");
    const branch = isLastInDate ? "└ " : "├ ";
    const continuation = "   ";

    text += `${branch}${icon} *${esc(formatRupiah(tx.amount))}* · ${esc(label)}\n`;
    text += `${continuation}${esc(tx.bank_name)}${tx.note ? ` · _${esc(tx.note)}_` : ""}\n`;
  }

  if (safePage === 0) {
    const limitDisplay = dailyLimit > 0
      ? formatRupiah(Math.round(dailyLimit))
      : "Belum diatur";
    text = text.trimEnd() + '\n\n';
    text += `*Hari Ini*\n├ Keluar ${esc(formatRupiah(todaySpend))} / ${esc(limitDisplay)}\n└ Saldo *${esc(formatRupiah(totalSaldo))}*`;
  }

  const historyKeyboard = new InlineKeyboard()
    .text("📝 Catat", "menu_catat")
    .text("🏠 Menu Utama", "menu_start");
  if (safePage > 0 || hasNextPage) {
    historyKeyboard.row();
    if (safePage > 0) historyKeyboard.text("‹ Sebelumnya", `riwayat_page_${safePage - 1}`);
    if (hasNextPage) historyKeyboard.text("Berikutnya ›", `riwayat_page_${safePage + 1}`);
  }
  const options = {
    parse_mode: "MarkdownV2",
    reply_markup: historyKeyboard,
  };
  return edit ? ctx.editMessageText(text, options) : ctx.reply(text, options);
}

async function handleHapusBank(ctx) {
  await clearSession(ctx.chat.id);
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
  const sess = {};
  sess.step = "tambahbank_nama";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`🏦 *Tambah Rekening Baru*\n\nKetik nama rekeningmu\\.\n_Contoh: BCA, GoPay, Cash_`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("❌ Batal", "batal") });
}

async function handleEditRekening(ctx) {
  try {
    await clearSession(ctx.chat.id);
    const sess = {};
    const accounts = await getAccounts(ctx.from.id);

    if (accounts.length === 0) {
      return ctx.reply(`⚠️ Belum ada rekening\\. Gunakan /tambahbank untuk menambah rekening\\.`, { parse_mode: "MarkdownV2" });
    }

    sess.step = "editrek_pilih_akun";
    await saveSession(ctx.chat.id, sess);

    const kb = new InlineKeyboard();
    for (const acc of accounts) {
      kb.text(`🏦 ${acc.bank_name} — ${formatRupiah(acc.balance)}`, `editrek_akun_${acc.id}`).row();
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
  const sess = {};
  sess.step = "tambahkategori_nama";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`🏷 *Tambah Kategori Baru*\n\nKetik nama kategori pengeluaran beserta emoji \(opsional\)\.\n_Contoh: 🐶 Peliharaan_`, { parse_mode: "MarkdownV2" });
}
bot.command("tambahkategori", handleTambahKategori);

async function handleSetLimit(ctx) {
  await clearSession(ctx.chat.id);
  const sess = {};
  sess.step = "setlimit_nominal";
  await saveSession(ctx.chat.id, sess);
  await ctx.reply(`⚠️ *Atur Batas Harian*\n\nKetik nominal batas pengeluaran harian Anda:\n_Contoh: 150000 / 150rb_\n\nKetik 0 untuk mematikan peringatan batas harian kustom\\.`, { parse_mode: "MarkdownV2" });
}
bot.command("setlimit", handleSetLimit);

bot.command("settings", async (ctx) => {
  await clearSession(ctx.chat.id);
  await ctx.reply(`⚙️ *Pengaturan MyDuit Ku*\n\nPilih opsi yang ingin diatur:`, { parse_mode: "MarkdownV2", reply_markup: pengaturanKeyboard });
});

async function handlePrediksi(ctx) {
  await clearSession(ctx.chat.id);
  const txs = await getTransactionsByDateRange(ctx.from.id, 'keluar', 30);
  if (txs.length === 0) return ctx.reply(`🔮 Belum ada data pengeluaran 30 hari terakhir\\.`, { parse_mode: "MarkdownV2" });

  const activeDays = new Set(txs.map((tx) => getTransactionWibDateKey(tx.created_at))).size;
  const accounts = await getAccounts(ctx.from.id);
  const totalBalance = accounts.reduce((sum, account) => sum + account.balance, 0);
  const spendByDay = new Map();
  const categoryMap = new Map();
  for (const tx of txs) {
    const date = getTransactionWibDateKey(tx.created_at);
    spendByDay.set(date, (spendByDay.get(date) || 0) + tx.amount);
    const category = tx.category || "Lainnya";
    categoryMap.set(category, (categoryMap.get(category) || 0) + tx.amount);
  }

  const dailySpend = Array.from({ length: 30 }, (_, index) => spendByDay.get(getWibDateKey(-index)) || 0);
  const activeDailySpend = dailySpend.filter((amount) => amount > 0);
  const p90 = percentile(activeDailySpend, 0.9);
  const winsorizedDaily = dailySpend.map((amount) => Math.min(amount, p90));
  const robustDaily = winsorizedDaily.reduce((sum, amount) => sum + amount, 0) / 30;
  const recentDaily = dailySpend.slice(0, 7).reduce((sum, amount) => sum + amount, 0) / 7;
  const priorDaily = dailySpend.slice(7, 30).reduce((sum, amount) => sum + amount, 0) / 23;
  const trendFactor = priorDaily > 0 ? Math.max(0.8, Math.min(1.2, recentDaily / priorDaily)) : 1;
  const normalDaily = Math.round((robustDaily * 0.7 + median(activeDailySpend) * (activeDays / 30) * 0.3) * trendFactor);
  const scenarios = [
    { label: "Hemat", daily: Math.round(normalDaily * 0.8) },
    { label: "Normal", daily: normalDaily },
    { label: "Boros", daily: Math.round(normalDaily * 1.25) },
  ];
  const variation = median(activeDailySpend) > 0 ? p90 / median(activeDailySpend) : 1;
  const confidence = activeDays >= 20 && variation <= 2
    ? "tinggi"
    : activeDays >= 12 && variation <= 4
      ? "sedang"
      : activeDays >= 7
        ? "rendah"
        : "sangat rendah";
  const sortedCats = Array.from(categoryMap.entries()).sort((a, b) => b[1] - a[1]);
  const normalRunway = normalDaily > 0 ? Math.floor(totalBalance / normalDaily) : 0;

  let text = `📈 *Proyeksi Saldo*\n\n`;
  text += `💰 Saldo saat ini: *${esc(formatRupiah(totalBalance))}*\n`;
  text += `💸 Belanja harian normal: *${esc(formatRupiah(normalDaily))}*\n`;
  text += `📊 Keyakinan: *${esc(confidence)}* \\(${esc(activeDays.toString())} hari aktif dari 30 hari\\)\n\n`;
  text += `*30 hari ke depan*\n`;
  for (const scenario of scenarios) {
    const projected = totalBalance - scenario.daily * 30;
    text += `${esc(scenario.label)}: *${esc(formatRupiah(projected))}*\n`;
  }
  text += `\n*60 hari ke depan*\n`;
  for (const scenario of scenarios) {
    const projected = totalBalance - scenario.daily * 60;
    text += `${esc(scenario.label)}: *${esc(formatRupiah(projected))}*\n`;
  }
  text += `\n*90 hari ke depan*\n`;
  for (const scenario of scenarios) {
    const projected = totalBalance - scenario.daily * 90;
    text += `${esc(scenario.label)}: *${esc(formatRupiah(projected))}*\n`;
  }
  text += `\n📅 Dengan pola normal, saldo cukup sekitar *${esc(normalRunway.toString())} hari*\\.`;
  text += `\n_Proyeksi belum memasukkan pemasukan atau tagihan masa depan karena belum ada jadwal yang dicatat\\._`;
  if (activeDays < 7) text += `\n_Data masih sedikit\\. Catat pengeluaran pada lebih banyak hari agar proyeksi makin akurat\\._`;
  if (sortedCats.length) {
    const [topCategory, topAmount] = sortedCats[0];
    text += `\n\nPengeluaran terbesar: *${esc(topCategory)}* \\(${esc(formatRupiah(topAmount))}\\)`;
  }
  await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["📝 Catat", "menu_catat"]) });
}

async function generateReport(ctx, isMonthly) {
  await clearSession(ctx.chat.id);
  const telegramId = ctx.from.id;
  const txs = isMonthly ? await getTransactionsForCurrentMonth(telegramId) : await getTransactionsForCurrentWeek(telegramId);

  if (txs.length === 0) return ctx.reply(`📊 Belum ada transaksi untuk periode ini\\.`, {
    parse_mode: "MarkdownV2",
    reply_markup: createNavigationKeyboard(["📝 Catat Transaksi", "menu_catat"]),
  });

  let totalIn = 0, totalOut = 0;
  const cats = new Map();

  // Get Period Start/End Dates safely formatting
  let periodStart = new Date();
  let periodEnd = new Date();
  if (txs.length > 0) {
    const dates = txs.map(t => new Date(t.created_at.replace(' ', 'T')));
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
  const [reportAccounts, reportSettings] = await Promise.all([
    getAccounts(telegramId),
    getUserSettings(telegramId),
  ]);
  const smartDailyLimit = computeLimitFromData(reportSettings, reportAccounts);
  updateSmartLimit(telegramId, smartDailyLimit).catch(() => { });
  const scorecard = await calculateScore(telegramId, smartDailyLimit);
  const { score } = scorecard;

  // Period Advice based on Savings from report period
  let msgAdvice = "Coba simpan uangmu lebih baik lagi periode depan.";
  if (savingRate > 0.3) msgAdvice = "Pengelolaan uang yang sangat baik! Lanjutkan di periode berikutnya.";
  else if (savingRate > 0.1) msgAdvice = "Cukup baik, tapi kamu masih bisa lebih efisien!";
  else if (savingRate < 0) msgAdvice = "Pengeluaran membengkak dari pemasukan. Segera perbaiki keuanganmu!";

  const periodLabel = isMonthly
    ? new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", month: "long", year: "numeric" }).format(new Date())
    : "minggu ini";
  let text = `📊 *Laporan ${esc(periodLabel)}*\n`;
  text += `Transaksi tercatat: ${esc(formatDate(periodStart.toISOString().split('T')[0]))} \\- ${esc(formatDate(periodEnd.toISOString().split('T')[0]))}\n\n`;
  text += `💰 Pemasukan:    *${esc(formatRupiah(totalIn))}*\n`;
  text += `💸 Pengeluaran:  *${esc(formatRupiah(totalOut))}*\n`;
  text += `📈 Selisih:      *${esc(formatRupiah(diff))}*\n`;
  const svPct = Math.round(savingRate * 100);
  text += `💾 Tingkat tabungan: *${esc(svPct.toString())}%*\n\n`;

  if (cats.size > 0) {
    text += `📂 *Pengeluaran terbesar*\n`;
    const sortedCats = Array.from(cats.entries()).sort((a, b) => b[1] - a[1]);
    for (const [name, amt] of sortedCats.slice(0, 5)) {
      const pct = Math.round((amt / totalOut) * 100);
      text += `• ${esc(name)}    ${esc(formatRupiah(amt))} \\(${esc(pct.toString())}%\\)\n`;
    }
    if (sortedCats.length > 5) text += `• \+${esc((sortedCats.length - 5).toString())} kategori lainnya\n`;
    text += `\n`;
  }

  text += `🎯 Skor kesehatan saat ini: *${esc(score.toString())}/100*\n`;
  text += `💡 _${esc(msgAdvice)}_`;

  await ctx.reply(text, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["📥 Export CSV", "menu_export"]) });
}

// ── COMMAND BINDINGS ──────────────────────────────────────────
bot.command("saldo", handleSaldo);
bot.hears("💰 Saldo", handleSaldo);

bot.command("catat", handleCatat);
bot.hears("📝 Catat", handleCatat);

bot.command("transfer", handleTransfer);

bot.command("wallet", handleWallet);
bot.command("ethwallet", handleEthWallet);

bot.command("riwayat", handleRiwayat);
bot.hears("📋 Riwayat", handleRiwayat);

bot.command("prediksi", handlePrediksi);
bot.hears("🔮 Prediksi", handlePrediksi);

bot.command("laporanminggu", (ctx) => generateReport(ctx, false));
bot.command("laporanbulan", (ctx) => generateReport(ctx, true));
bot.hears("📊 Laporan", (ctx) => generateReport(ctx, true));
bot.command("exportcsv", showExportMenu);

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
  sess.operationId = createOperationId();
  await saveSession(ctx.chat.id, sess);

  const labelKategori = sess.type === "masuk"
    ? (sess.source || "Lainnya")
    : (sess.category || "Lainnya");
  const noteCat = sess.note ? esc(sess.note) : "\\-";
  const icon = sess.type === "masuk" ? "⬆️ Pemasukan" : "⬇️ Pengeluaran";

  const text =
    `${esc(icon)} · *${esc(formatRupiah(sess.amount))}*\n\n` +
    `🏷 ${esc(labelKategori)}\n` +
    `🏦 ${esc(sess.accountName)}\n` +
    `📝 ${noteCat}\n\n` +
    `Periksa detail sebelum menyimpan\\.`;

  const kb = new InlineKeyboard()
    .text("✅ Simpan", "catat_simpan")
    .text("✏️ Ubah Detail", "catat_ubah_detail").row()
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
// ── PHOTO HANDLER (OCR) ───────────────────────────────────────
bot.on("message:photo", async (ctx) => {
  if (isRateLimited(ctx.from.id)) return;

  const accounts = await getAccounts(ctx.from.id);
  if (accounts.length === 0) {
    return ctx.reply(
      `⚠️ Belum ada rekening\\. Tambah dulu dengan /tambahbank`,
      { parse_mode: "MarkdownV2" }
    );
  }

  const processingMsg = await ctx.reply(`📸 _Membaca screenshot\\.\\.\\._`, {
    parse_mode: "MarkdownV2"
  });

  try {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

    const ocrText = await extractTextFromImage(fileUrl);
    await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});

    if (!ocrText) {
      return ctx.reply(
        `❌ Gagal membaca gambar\\.\nPastikan screenshot jelas lalu coba lagi, atau gunakan /catat manual\\.`,
        { parse_mode: "MarkdownV2" }
      );
    }

    const parsedList = parseTransactionFromText(ocrText);

    if (!parsedList || parsedList.length === 0) {
      return ctx.reply(
        `❌ Tidak dapat menemukan transaksi\\.\nCoba screenshot yang lebih jelas, atau gunakan /catat manual\\.`,
        { parse_mode: "MarkdownV2" }
      );
    }

    // Simpan semua transaksi ke session
    const sess = {};
    sess.step = "ocr_pilih_rekening";
    sess.ocrOperationId = createOperationId();
    sess.ocrList = parsedList;         // array semua transaksi
    sess.ocrIndex = 0;                 // index yang sedang dikonfirmasi
    await saveSession(ctx.chat.id, sess);

    // Tampilkan draft. Bulk save always requires explicit second confirmation.
    let summary = `📸 *Draf ${parsedList.length} Transaksi*\n\n`;
    parsedList.forEach((tx, i) => {
      const icon = tx.type === "masuk" ? "⬆️" : "⬇️";
      const typeLabel = tx.type === "masuk" ? "Pemasukan" : "Pengeluaran";
      summary += `${i + 1}\\. ${esc(icon)} *${esc(formatRupiah(tx.nominal))}* — ${esc(typeLabel)}\n`;
      summary += `   ${esc(tx.category || "Lainnya")}`;
      if (tx.merchant) summary += ` · ${esc(tx.merchant)}`;
      summary += `\n`;
    });
    summary += `\nPilih rekening untuk meninjau atau simpan\\.`;

    const kb = new InlineKeyboard();
    for (const acc of accounts) {
      kb.text(`🏦 Tinjau untuk ${acc.bank_name}`, `ocr_bulk_${acc.id}`).row();
    }
    kb.text("📝 Edit Satu per Satu", "ocr_satu_satu").row();
    kb.text("❌ Batal", "batal");

    await ctx.reply(summary, { parse_mode: "MarkdownV2", reply_markup: kb });

  } catch (err) {
    console.error("OCR handler error:", err);
    await ctx.api.deleteMessage(ctx.chat.id, processingMsg.message_id).catch(() => {});
    await ctx.reply(
      `❌ Terjadi kesalahan\\. Gunakan /catat untuk input manual\\.`,
      { parse_mode: "MarkdownV2" }
    );
  }
});
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

  // Determine if this is a heavy operation that needs loading feedback
  const isHeavy =
    data === "catat_simpan" ||
    data === "editrek_simpan_saldo" ||
    data === "editrek_simpan_nama" ||
    data.startsWith("konfirmhapus_") ||
    data.startsWith("catat_akun_") ||
    data.startsWith("editrek_akun_");

  if (isHeavy) {
    await ctx.answerCallbackQuery("⏳ Memproses...");
  } else {
    await ctx.answerCallbackQuery();
  }

  if (data === "batal" || data === "menu_tutup") {
    await clearSession(chatId);
    if (data === "menu_tutup") {
      await ctx.deleteMessage().catch(() => { });
    } else {
      await ctx.editMessageText("❌ Proses dibatalkan\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard() });
    }
    return;
  }

  if (data.startsWith("riwayat_page_")) {
    const rawPage = data.slice("riwayat_page_".length);
    if (!/^\d+$/.test(rawPage)) return;
    const page = Number(rawPage);
    if (!Number.isSafeInteger(page)) return;
    return handleRiwayat(ctx, page, true);
  }

  if (data.startsWith("menu_")) {
    if (data !== "menu_lainnya" && data !== "menu_transfer") {
      try { await ctx.deleteMessage(); } catch (e) { }
    }

    if (data === "menu_start") {
      await clearSession(chatId);
      return showMainMenu(ctx);
    }
    if (data === "menu_saldo") return handleSaldo(ctx);
    if (data === "menu_catat") return handleCatat(ctx);
    if (data === "menu_transfer") return handleTransfer(ctx, true);
    if (data === "menu_riwayat") return handleRiwayat(ctx);
    if (data === "menu_prediksi") return handlePrediksi(ctx);
    if (data === "menu_tambahbank") return handleTambahBank(ctx);
    if (data === "menu_laporan") return ctx.reply("📊 *Pilih Periode Laporan*", {
      parse_mode: "MarkdownV2",
      reply_markup: createReportKeyboard(),
    });
    if (data === "menu_lainnya") return ctx.editMessageText("☰ *Menu Lainnya*\n\nFitur laporan, scan, rekening, dan pengaturan\\.", {
      parse_mode: "MarkdownV2",
      reply_markup: moreMenuKeyboard,
    });
    if (data === "menu_export") return showExportMenu(ctx);
    if (data === "menu_wallet") return handleWallet(ctx);
    if (data === "menu_eth_wallet") return handleWallet(ctx);
    if (data === "menu_settings") return ctx.reply("⚙️ *Pengaturan MyDuit Ku*", {
      parse_mode: "MarkdownV2",
      reply_markup: pengaturanKeyboard,
    });
    if (data === "menu_scan") return ctx.reply("📸 *Scan Screenshot*\n\nKirim screenshot transaksi ke chat ini\\. Periksa hasil scan sebelum menyimpan\\.", {
      parse_mode: "MarkdownV2",
      reply_markup: createNavigationKeyboard(),
    });
    if (data === "menu_hapusbank") return handleHapusBank(ctx);
    if (data === "menu_tambahkategori") return handleTambahKategori(ctx);
    if (data === "menu_setlimit") return handleSetLimit(ctx);
    if (data === "menu_editrekening") return handleEditRekening(ctx);
    return;
  }

  if (data === "laporan_minggu") return generateReport(ctx, false);
  if (data === "laporan_bulan") return generateReport(ctx, true);

  if (data === "wallet_sync_all") {
    await ctx.answerCallbackQuery("⏳ Menyinkronkan semua wallet...");
    await syncAllUserWallets(ctx.from.id);
    return handleWallet(ctx);
  }

  if (data === "wallet_add") {
    return ctx.reply("👛 *Tambah Wallet*\n\nPilih jaringan wallet:", { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🪙 Solana", "wallet_add_sol").text("⟠ ETH Robinhood", "wallet_add_eth").row().text("❌ Batal", "batal") });
  }

  if (data === "wallet_add_sol") {
    await saveSession(chatId, { step: "wallet_label", walletType: "sol" });
    return ctx.reply("🪙 *Tambah Wallet Solana*\n\nBeri nama agar mudah dikenali\\.\n_Contoh: Phantom Utama_", { parse_mode: "MarkdownV2" });
  }

  if (data === "wallet_add_eth" || data === "eth_wallet_add") {
    await saveSession(chatId, { step: "eth_wallet_label" });
    return ctx.reply("⟠ *Tambah Wallet ETH Robinhood*\n\nBeri nama agar mudah dikenali\\.\n_Contoh: Robinhood ETH_", { parse_mode: "MarkdownV2" });
  }

  if (data === "eth_wallet_save") {
    try {
      const walletId = await addEthWallet(ctx.from.id, sess.walletLabel, sess.walletAddress);
      const wallet = await getEthWalletById(walletId, ctx.from.id);
      await clearSession(chatId);
      try {
        const wei = await syncEthWallet(wallet);
        return ctx.editMessageText(`✅ *Wallet ETH berhasil ditambahkan*\n\n⟠ ${esc(wallet.label)}\n💰 *${esc(formatEth(wei))}*`, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
      } catch {
        return ctx.editMessageText("✅ Wallet ETH disimpan\\. Sinkronisasi awal gagal, coba lagi nanti\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
      }
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return ctx.reply("⚠️ Wallet ini sudah dipantau\\.", { parse_mode: "MarkdownV2" });
      throw error;
    }
  }

  if (data.startsWith("eth_wallet_pick_")) {
    const walletId = parseCallbackId(data, "eth_wallet_pick_");
    const wallet = walletId && await getEthWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    return ctx.editMessageText(`⟠ *${esc(wallet.label)}*\n\n🔵 *Ethereum Wallet Address*\n├ \`${wallet.address}\`\n└ *${esc(wallet.last_balance_wei ? formatEth(wallet.last_balance_wei) : "Belum disinkronkan")}*`, { parse_mode: "MarkdownV2", reply_markup: createEthWalletActions(wallet) });
  }

  if (data.startsWith("eth_wallet_sync_")) {
    const walletId = parseCallbackId(data, "eth_wallet_sync_");
    const wallet = walletId && await getEthWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    try {
      const wei = await syncEthWallet(wallet);
      return ctx.editMessageText(`⟠ *${esc(wallet.label)}*\n\n🔵 *Ethereum Wallet Address*\n├ \`${wallet.address}\`\n└ *${esc(formatEth(wei))}*`, { parse_mode: "MarkdownV2", reply_markup: createEthWalletActions({ ...wallet, last_balance_wei: wei }) });
    } catch {
      return ctx.reply("⚠️ Sync wallet ETH gagal\\. Saldo terakhir tetap disimpan\\.", { parse_mode: "MarkdownV2" });
    }
  }

  if (data.startsWith("eth_wallet_rename_")) {
    const walletId = parseCallbackId(data, "eth_wallet_rename_");
    if (!walletId || !await getEthWalletById(walletId, ctx.from.id)) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    await saveSession(chatId, { step: "eth_wallet_rename", walletId });
    return ctx.reply("✏️ Ketik nama baru wallet ETH\\.", { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("eth_wallet_address_")) {
    const walletId = parseCallbackId(data, "eth_wallet_address_");
    if (!walletId || !await getEthWalletById(walletId, ctx.from.id)) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    await saveSession(chatId, { step: "eth_wallet_replace_address", walletId });
    return ctx.reply("🔗 Kirim public address Ethereum baru\\. Jangan kirim private key atau seed phrase\\.", { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("eth_wallet_delete_confirm_")) {
    const walletId = parseCallbackId(data, "eth_wallet_delete_confirm_");
    if (!walletId || !await getEthWalletById(walletId, ctx.from.id)) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    await deleteEthWallet(walletId, ctx.from.id);
    return ctx.editMessageText("✅ Wallet ETH tidak lagi dipantau\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
  }

  if (data.startsWith("eth_wallet_delete_")) {
    const walletId = parseCallbackId(data, "eth_wallet_delete_");
    const wallet = walletId && await getEthWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet ETH tidak ditemukan.");
    return ctx.editMessageText(`⚠️ *Hapus wallet ETH ini?*\n\n⟠ ${esc(wallet.label)}\n🔗 \`${shortenEthAddress(wallet.address)}\``, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🗑 Ya, Hapus", `eth_wallet_delete_confirm_${wallet.id}`).text("❌ Batal", "batal") });
  }

  if (data === "wallet_save") {
    try {
      const walletId = await addSolWallet(ctx.from.id, sess.walletLabel, sess.walletAddress);
      const wallet = await getSolWalletById(walletId, ctx.from.id);
      await clearSession(chatId);
      try {
        const lamports = await syncSolWallet(wallet);
        return ctx.editMessageText(`✅ *Wallet berhasil ditambahkan*\n\n🪙 ${esc(wallet.label)}\n💰 *${esc(formatSol(lamports))}*`, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
      } catch {
      return ctx.editMessageText("✅ Wallet disimpan\\. Sinkronisasi awal gagal, coba lagi nanti\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
      }
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return ctx.reply("⚠️ Wallet ini sudah dipantau\.", { parse_mode: "MarkdownV2" });
      throw error;
    }
  }

  if (data.startsWith("wallet_pick_")) {
    const walletId = parseCallbackId(data, "wallet_pick_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    return ctx.editMessageText(await formatWalletDetail(wallet), { parse_mode: "MarkdownV2", reply_markup: createWalletActions(wallet) });
  }

  if (data.startsWith("wallet_sync_")) {
    const walletId = parseCallbackId(data, "wallet_sync_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    try {
      const lamports = await syncSolWallet(wallet);
      return ctx.editMessageText(await formatWalletDetail({ ...wallet, last_balance_lamports: lamports }), { parse_mode: "MarkdownV2", reply_markup: createWalletActions(wallet) });
    } catch (error) {
      return ctx.reply("⚠️ Sync wallet gagal\. Saldo terakhir tetap disimpan\. Coba lagi nanti\.", { parse_mode: "MarkdownV2" });
    }
  }

  if (data.startsWith("wallet_rename_")) {
    const walletId = parseCallbackId(data, "wallet_rename_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    await saveSession(chatId, { step: "wallet_rename", walletId });
    return ctx.reply(`✏️ *Ganti Nama Wallet*\n\nKetik nama baru untuk *${esc(wallet.label)}*\\.`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("wallet_address_")) {
    const walletId = parseCallbackId(data, "wallet_address_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    await saveSession(chatId, { step: "wallet_replace_address", walletId });
    return ctx.reply(`🔗 *Ganti Public Address*\n\nKirim public address Solana baru untuk *${esc(wallet.label)}*\\.\n\n⚠️ Riwayat saldo address lama akan dihapus agar data tidak tercampur\\. Jangan pernah kirim seed phrase atau private key\\.`, { parse_mode: "MarkdownV2" });
  }

  if (data.startsWith("wallet_delete_confirm_")) {
    const walletId = parseCallbackId(data, "wallet_delete_confirm_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    await deleteSolWallet(wallet.id, ctx.from.id);
    return ctx.editMessageText("✅ Wallet tidak lagi dipantau\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"])});
  }

  if (data.startsWith("wallet_delete_")) {
    const walletId = parseCallbackId(data, "wallet_delete_");
    const wallet = walletId && await getSolWalletById(walletId, ctx.from.id);
    if (!wallet) return ctx.answerCallbackQuery("Wallet tidak ditemukan.");
    return ctx.editMessageText(`⚠️ *Hapus wallet ini?*\n\n🪙 ${esc(wallet.label)}\n🔗 \`${shortenSolAddress(wallet.address)}\`\n\nTracking dan riwayat saldo akan dihapus\\.`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🗑 Ya, Hapus", `wallet_delete_confirm_${wallet.id}`).text("❌ Batal", "batal") });
  }

  if (data.startsWith("transfer_from_")) {
    const accountId = parseCallbackId(data, "transfer_from_");
    const account = accountId && await getAccountById(accountId, ctx.from.id);
    if (!account) return ctx.answerCallbackQuery("Rekening tidak valid.");
    sess.fromAccountId = account.id;
    sess.fromAccountName = account.bank_name;
    sess.step = "transfer_to";
    await saveSession(chatId, sess);
    const accounts = await getAccounts(ctx.from.id);
    const kb = new InlineKeyboard();
    for (const target of accounts) if (target.id !== account.id) kb.text(`🏦 ${target.bank_name}`, `transfer_to_${target.id}`).row();
    kb.text("⬅️ Kembali", "transfer_back_from").text("❌ Batal", "batal");
    return ctx.editMessageText("↔️ *Pilih rekening tujuan*", { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data === "transfer_back_from") {
    sess.step = "transfer_from";
    delete sess.fromAccountId;
    delete sess.fromAccountName;
    await saveSession(chatId, sess);
    const accounts = await getAccounts(ctx.from.id);
    const kb = new InlineKeyboard();
    for (const account of accounts) kb.text(`🏦 ${account.bank_name} (${formatRupiah(account.balance)})`, `transfer_from_${account.id}`).row();
    kb.text("❌ Batal", "batal");
    return ctx.editMessageText("↔️ *Transfer Antar Rekening*\n\nPilih rekening sumber\\.", { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data.startsWith("transfer_to_")) {
    const accountId = parseCallbackId(data, "transfer_to_");
    const account = accountId && await getAccountById(accountId, ctx.from.id);
    if (!account || account.id === sess.fromAccountId) return ctx.answerCallbackQuery("Rekening tujuan tidak valid.");
    sess.toAccountId = account.id;
    sess.toAccountName = account.bank_name;
    sess.step = "transfer_amount";
    await saveSession(chatId, sess);
    return ctx.editMessageText("💵 Masukkan nominal transfer\\.\n_Contoh: 50000 / 50rb_", { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("❌ Batal", "batal") });
  }

  if (data === "transfer_edit_amount" || data === "transfer_edit_note") {
    sess.step = data === "transfer_edit_amount" ? "transfer_amount" : "transfer_note";
    await saveSession(chatId, sess);
    return ctx.reply(data === "transfer_edit_amount" ? "💵 Masukkan nominal transfer baru\\." : "📝 Ketik catatan transfer, atau `-` untuk mengosongkan\\.", { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("❌ Batal", "batal") });
  }

  if (data === "tambahbank_ubah_saldo") {
    sess.step = "tambahbank_saldo";
    await saveSession(chatId, sess);
    return ctx.editMessageText("💳 *Tambah Rekening Baru*\n\nKetik saldo awal rekening ini\\.\n_Contoh: 500000 / 500rb / 2jt_", { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("❌ Batal", "batal") });
  }

  if (data === "tambahbank_simpan") {
    if (sess.step !== "tambahbank_konfirmasi" || !sess.bankName || !isValidNominal(sess.bankBalance)) {
      return ctx.editMessageText("⚠️ Konfirmasi rekening sudah tidak berlaku\\. Mulai lagi dari menu tambah rekening\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["🏦 Tambah Rekening", "menu_tambahbank"]) });
    }
    const accountId = await addAccount(ctx.from.id, sess.bankName, sess.bankBalance);
    if (!accountId) return ctx.editMessageText("⚠️ Rekening gagal ditambahkan\\. Coba lagi\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard() });
    await clearSession(chatId);
    return ctx.editMessageText(`✅ *Rekening berhasil ditambahkan\\!*\n\n🏦 *${esc(sess.bankName)}*\nSaldo awal: *${esc(formatRupiah(sess.bankBalance))}*`, {
      parse_mode: "MarkdownV2",
      reply_markup: createNavigationKeyboard(["📝 Catat", "menu_catat"], ["💰 Lihat Saldo", "menu_saldo"]),
    });
  }

  if (data === "transfer_note_skip") {
    sess.transferNote = "";
    sess.transferId = sess.transferId || createOperationId();
    sess.step = "transfer_confirm";
    await saveSession(chatId, sess);
    return sendTransferPreview(ctx, sess);
  }

  if (data === "transfer_save") {
    const saved = await createTransfer(ctx.from.id, sess.fromAccountId, sess.toAccountId, sess.transferAmount, sess.transferNote, sess.transferId);
    if (!saved) return ctx.answerCallbackQuery("Transfer ini sudah diproses.");
    const [from, to] = await Promise.all([getAccountById(sess.fromAccountId, ctx.from.id), getAccountById(sess.toAccountId, ctx.from.id)]);
    await clearSession(chatId);
    return ctx.editMessageText(`✅ *Transfer tercatat*\n\n${esc(sess.fromAccountName)} → ${esc(sess.toAccountName)}\n*${esc(formatRupiah(sess.transferAmount))}*\n\nSaldo ${esc(from.bank_name)}: *${esc(formatRupiah(from.balance))}*\nSaldo ${esc(to.bank_name)}: *${esc(formatRupiah(to.balance))}*`, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard() });
  }

  if (data.startsWith("tx_manage_")) {
    const txId = parseCallbackId(data, "tx_manage_");
    const tx = txId && await getTransactionById(txId, ctx.from.id);
    if (!tx) return ctx.answerCallbackQuery("Transaksi tidak ditemukan.");
    sess.txId = tx.id; sess.txRevision = tx.revision; sess.txAmount = tx.amount; sess.txNote = tx.note || ""; sess.transferId = tx.transfer_id || null;
    await saveSession(chatId, sess);
    if (tx.is_transfer) {
      return ctx.editMessageText(`↔️ *Kelola Transfer*\n\n*${esc(formatRupiah(tx.amount))}*\nMenghapus transfer akan membalikkan saldo pada kedua rekening\\.`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🗑 Hapus Transfer", "tx_delete_confirm").text("❌ Batal", "batal") });
    }
    return ctx.editMessageText(`⚙️ *Kelola Transaksi*\n\n${tx.type === "masuk" ? "⬆️" : "⬇️"} *${esc(formatRupiah(tx.amount))}*\n🏦 ${esc(tx.bank_name)}`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("💵 Ubah Nominal", "tx_edit_amount").text("📝 Ubah Catatan", "tx_edit_note").row().text("🗑 Hapus", "tx_delete_confirm").text("❌ Batal", "batal") });
  }

  if (data === "tx_edit_amount" || data === "tx_edit_note") {
    sess.step = data === "tx_edit_amount" ? "txedit_amount" : "txedit_note";
    await saveSession(chatId, sess);
    return ctx.reply(data === "tx_edit_amount" ? "💵 Masukkan nominal baru\\." : "📝 Ketik catatan baru, atau `-` untuk mengosongkan\\.", { parse_mode: "MarkdownV2" });
  }

  if (data === "tx_delete_confirm") {
    return ctx.editMessageText("⚠️ Hapus transaksi ini? Saldo rekening akan dikembalikan\\.", { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("🗑 Hapus Transaksi", "tx_delete").text("❌ Batal", "batal") });
  }

  if (data === "tx_delete") {
    const deleted = sess.transferId
      ? await deleteTransfer(sess.transferId, ctx.from.id, sess.txRevision)
      : await deleteTransaction(sess.txId, ctx.from.id, sess.txRevision);
    if (!deleted) return ctx.answerCallbackQuery("Transaksi sudah berubah atau terhapus.");
    await clearSession(chatId);
    return ctx.editMessageText("✅ Transaksi dihapus dan saldo dikembalikan\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["📋 Riwayat", "menu_riwayat"]) });
  }

  if (data === "export_csv_current") {
    return exportTransactionsCsv(ctx, getYearMonth());
  }

  if (data.startsWith("export_csv_")) {
    const yearMonth = data.replace("export_csv_", "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
      return ctx.reply("⚠️ Periode export tidak valid\\.", { parse_mode: "MarkdownV2" });
    }
    return exportTransactionsCsv(ctx, yearMonth);
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
      return ctx.editMessageText(`Ketik nama kategori pengeluaranmu:\n_Contoh: Sedekah_`, { parse_mode: "MarkdownV2" });
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

  if (data === "catat_ubah_detail") {
    const kb = new InlineKeyboard()
      .text("💵 Nominal", "catat_ubah_nominal")
      .text("📝 Catatan", "catat_ubah_catatan").row()
      .text("↕️ Jenis", "catat_ubah_jenis")
      .text("🏷 Kategori", "catat_ubah_kategori").row()
      .text("⬅️ Kembali", "catat_preview");
    return ctx.editMessageText("✏️ *Ubah Detail Transaksi*\n\nPilih data yang ingin diubah\\.", {
      parse_mode: "MarkdownV2",
      reply_markup: kb,
    });
  }

  if (data === "catat_preview") return sendCatatPreview(ctx, sess);

  if (data === "catat_ubah_catatan") {
    sess.step = "catat_keterangan";
    await saveSession(chatId, sess);
    return ctx.editMessageText("📝 Ketik catatan baru, atau kirim tanda `-` untuk mengosongkan\\.", { parse_mode: "MarkdownV2" });
  }

  if (data === "catat_ubah_jenis") {
    const kb = new InlineKeyboard()
      .text("⬆️ Pemasukan", "catat_edit_tipe_masuk")
      .text("⬇️ Pengeluaran", "catat_edit_tipe_keluar").row()
      .text("⬅️ Kembali", "catat_preview");
    return ctx.editMessageText("↕️ *Pilih jenis transaksi*", { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data === "catat_edit_tipe_masuk" || data === "catat_edit_tipe_keluar") {
    sess.type = data === "catat_edit_tipe_masuk" ? "masuk" : "keluar";
    if (sess.type === "masuk") {
      sess.source = sess.source || "📦 Lainnya";
      delete sess.category;
    } else {
      sess.category = sess.category || "Lainnya";
      delete sess.source;
    }
    await saveSession(chatId, sess);
    return sendCatatPreview(ctx, sess);
  }

  if (data === "catat_ubah_kategori") {
    if (sess.type !== "keluar") return ctx.answerCallbackQuery("Kategori hanya untuk pengeluaran.");
    const customCats = await getCustomCategories(ctx.from.id);
    const kb = new InlineKeyboard();
    for (const category of [...defaultExpenseCategories, ...customCats.map((cat) => `${cat.emoji} ${cat.name}`)]) {
      kb.text(category, `catat_edit_kategori_${category}`).row();
    }
    kb.text("⬅️ Kembali", "catat_preview");
    return ctx.editMessageText("🏷 *Pilih kategori*", { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data.startsWith("catat_edit_kategori_")) {
    sess.category = data.replace("catat_edit_kategori_", "");
    await saveSession(chatId, sess);
    return sendCatatPreview(ctx, sess);
  }

  if (data === "catat_simpan") {
    try {
      const saved = await addTransaction(
        ctx.from.id, sess.accountId, sess.type, sess.amount, sess.note,
        sess.category, sess.source, sess.operationId
      );
      if (!saved) return ctx.answerCallbackQuery("Transaksi ini sudah diproses.");

      const acc = await getAccountById(sess.accountId, ctx.from.id);
      const icon = sess.type === "masuk" ? "⬆️" : "⬇️";
      const labelKategori = sess.type === "masuk" ? sess.source : sess.category;

      await clearSession(chatId);

      const msg = `✅ *Transaksi tercatat*\n\n${esc(icon)} *${esc(formatRupiah(sess.amount))}* · ${esc(labelKategori)}\n🏦 ${esc(acc.bank_name)}\n${sess.note ? `📝 _${esc(sess.note)}_\n` : ""}💰 Saldo: *${esc(formatRupiah(acc.balance))}*`;

      const kbCatatLagi = new InlineKeyboard()
        .text("📝 Catat Lagi", "menu_catat")
        .text("🏠 Menu Utama", "menu_start");

      await ctx.editMessageText(msg, { parse_mode: "MarkdownV2", reply_markup: kbCatatLagi });

      // Call analyzeAndAlert separately without blocking the response
      analyzeAndAlert(ctx, ctx.from.id).catch(err => console.error("Analyze error:", err));
    } catch (err) {
      console.error("catat_simpan error:", err);
      await ctx.editMessageText(`❌ Gagal menyimpan transaksi\\. Silakan coba lagi\\.`, { parse_mode: "MarkdownV2" });
    }
    return;
  }
  // ── OCR BULK SIMPAN (semua sekaligus) ─────────────────────
  if (data.startsWith("ocr_bulk_")) {
    const accId = parseInt(data.replace("ocr_bulk_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    const list = sess.ocrList || [];
    if (list.length === 0) return ctx.editMessageText("⚠️ Data transaksi tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    sess.ocrBulkAccountId = accId;
    await saveSession(chatId, sess);
    return ctx.editMessageText(
      `⚠️ *Konfirmasi Simpan ${list.length} Transaksi*\n\nSemua draf akan dicatat ke *${esc(acc.bank_name)}* dan mengubah saldo\\. Pastikan detail sudah benar\\.`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: new InlineKeyboard()
          .text("✅ Simpan Semua", "ocr_bulk_confirm")
          .text("📝 Edit Satu per Satu", "ocr_satu_satu").row()
          .text("❌ Batal", "batal"),
      }
    );
  }

  if (data === "ocr_bulk_confirm") {
    const accId = sess.ocrBulkAccountId;
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    const list = sess.ocrList || [];
    if (list.length === 0) return ctx.editMessageText("⚠️ Data transaksi tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    await addTransactions(
      ctx.from.id,
      accId,
      list.map((tx) => ({
        type: tx.type,
        amount: tx.nominal,
        note: tx.merchant || "Via foto",
        category: tx.type === "keluar" ? tx.category : "Lainnya",
        source: tx.type === "masuk" ? (tx.category || "📦 Lainnya") : "",
      })),
      sess.ocrOperationId
    );

    await clearSession(chatId);
    const accAfter = await getAccountById(accId, ctx.from.id);

    let msg = `✅ *${list.length} transaksi tercatat*\n\n`;
    list.forEach((tx, i) => {
      const icon = tx.type === "masuk" ? "⬆️" : "⬇️";
      msg += `${i + 1}\\. ${esc(icon)} ${esc(formatRupiah(tx.nominal))}`;
      if (tx.merchant) msg += ` — ${esc(tx.merchant)}`;
      msg += `\n`;
    });
    msg += `\n💰 Saldo: *${esc(formatRupiah(accAfter.balance))}*`;

    const kb = new InlineKeyboard()
      .text("📝 Catat Lagi", "menu_catat")
      .text("🏠 Menu Utama", "menu_start");

    await ctx.editMessageText(msg, { parse_mode: "MarkdownV2", reply_markup: kb });
    analyzeAndAlert(ctx, ctx.from.id).catch(() => {});
    return;
  }

  // ── OCR SATU PER SATU ─────────────────────────────────────
  if (data === "ocr_satu_satu") {
    const list = sess.ocrList || [];
    if (list.length === 0) return ctx.editMessageText("⚠️ Data tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    sess.ocrIndex = 0;
    await saveSession(chatId, sess);

    const accountsList = await getAccounts(ctx.from.id);
    return showOcrKonfirmasi(ctx, sess, accountsList);
  }

  if (data === "ocr_ubah_kategori") {
    const list = sess.ocrList || [];
    const tx = list[sess.ocrIndex || 0];
    if (!tx || tx.type !== "keluar") {
      return ctx.answerCallbackQuery("Kategori hanya untuk pengeluaran.");
    }

    const customCats = await getCustomCategories(ctx.from.id);
    const categories = [...defaultExpenseCategories, ...customCats.map((cat) => `${cat.emoji} ${cat.name}`)];
    const kb = new InlineKeyboard();
    for (const category of categories) {
      kb.text(category, `ocr_kategori_${category}`).row();
    }
    kb.text("⬅️ Kembali", "ocr_kategori_batal");
    return ctx.editMessageText("🏷 *Pilih Kategori Transaksi*", {
      parse_mode: "MarkdownV2",
      reply_markup: kb,
    });
  }

  if (data === "ocr_ubah_nominal") {
    sess.step = "ocr_input_nominal";
    await saveSession(chatId, sess);
    return ctx.editMessageText("✏️ *Masukkan nominal yang benar*\n_Contoh: 25000 / 25rb / 1jt_", {
      parse_mode: "MarkdownV2",
    });
  }

  if (data === "ocr_ubah_jenis") {
    const kb = new InlineKeyboard()
      .text("⬆️ Pemasukan", "ocr_jenis_masuk")
      .text("⬇️ Pengeluaran", "ocr_jenis_keluar").row()
      .text("⬅️ Kembali", "ocr_kategori_batal");
    return ctx.editMessageText("↕️ *Pilih jenis transaksi*", { parse_mode: "MarkdownV2", reply_markup: kb });
  }

  if (data === "ocr_jenis_masuk" || data === "ocr_jenis_keluar") {
    const list = sess.ocrList || [];
    const index = sess.ocrIndex || 0;
    if (!list[index]) return ctx.editMessageText("⚠️ Data transaksi tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    list[index].type = data === "ocr_jenis_masuk" ? "masuk" : "keluar";
    if (list[index].type === "masuk") list[index].category = "📦 Lainnya";
    sess.ocrList = list;
    await saveSession(chatId, sess);
    return showOcrKonfirmasi(ctx, sess, await getAccounts(ctx.from.id));
  }

  if (data === "ocr_kategori_batal") {
    const accountsList = await getAccounts(ctx.from.id);
    return showOcrKonfirmasi(ctx, sess, accountsList);
  }

  if (data.startsWith("ocr_kategori_")) {
    const list = sess.ocrList || [];
    const index = sess.ocrIndex || 0;
    if (!list[index]) return ctx.editMessageText("⚠️ Data transaksi tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    list[index].category = data.replace("ocr_kategori_", "");
    sess.ocrList = list;
    await saveSession(chatId, sess);
    const accountsList = await getAccounts(ctx.from.id);
    return showOcrKonfirmasi(ctx, sess, accountsList);
  }

  if (data.startsWith("ocr_simpan1_")) {
    const accId = parseInt(data.replace("ocr_simpan1_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    const list = sess.ocrList || [];
    const i = sess.ocrIndex || 0;
    const tx = list[i];

    await addTransaction(
      ctx.from.id, accId, tx.type, tx.nominal,
      tx.merchant || "Via foto",
      tx.type === "keluar" ? tx.category : "Lainnya",
      tx.type === "masuk" ? (tx.category || "📦 Lainnya") : "",
      `${sess.ocrOperationId}-${i}`
    );

    sess.ocrIndex = i + 1;
    await saveSession(chatId, sess);

    const accountsList = await getAccounts(ctx.from.id);
    return showOcrKonfirmasi(ctx, sess, accountsList);
  }

  if (data === "ocr_lewati") {
    sess.ocrIndex = (sess.ocrIndex || 0) + 1;
    await saveSession(chatId, sess);
    const accountsList = await getAccounts(ctx.from.id);
    return showOcrKonfirmasi(ctx, sess, accountsList);
  }

  // ── OCR SIMPAN ────────────────────────────────────────────
  if (data.startsWith("ocr_simpan_")) {
    const accId = parseInt(data.replace("ocr_simpan_", ""));
    const acc = await getAccountById(accId, ctx.from.id);
    if (!acc) return ctx.editMessageText("⚠️ Rekening tidak ditemukan\\.", { parse_mode: "MarkdownV2" });

    await addTransaction(
      ctx.from.id,
      accId,
      sess.ocrType,
      sess.ocrNominal,
      sess.ocrMerchant || "Via foto",
      sess.ocrType === "keluar" ? sess.ocrCategory : "Lainnya",
      sess.ocrType === "masuk" ? (sess.ocrCategory || "📦 Lainnya") : "",
      sess.ocrOperationId
    );

    await clearSession(chatId);

    const icon = sess.ocrType === "masuk" ? "⬆️" : "⬇️";
    const accAfter = await getAccountById(accId, ctx.from.id);

    const msg =
      `✅ *Transaksi tercatat*\n\n` +
      `${esc(icon)} *${esc(formatRupiah(sess.ocrNominal))}*\n` +
      `🏦 ${esc(acc.bank_name)}\n` +
      `${sess.ocrMerchant ? `🏪 ${esc(sess.ocrMerchant)}\n` : ''}` +
      `💰 Saldo: *${esc(formatRupiah(accAfter.balance))}*`;

    const kb = new InlineKeyboard()
      .text("📝 Catat Lagi", "menu_catat")
      .text("🏠 Menu Utama", "menu_start");

    await ctx.editMessageText(msg, { parse_mode: "MarkdownV2", reply_markup: kb });

    analyzeAndAlert(ctx, ctx.from.id).catch(() => { });
    return;
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
      `✏️ *Edit Rekening*\n\n🏦 ${esc(acc.bank_name)}\n💰 Saldo: *${esc(formatRupiah(acc.balance))}*\n\nPilih yang ingin diubah\\.`,
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

    const corrected = await correctAccountBalance(
      ctx.from.id, sess.accountId, newBalance
    );
    if (!corrected) return ctx.answerCallbackQuery("Koreksi ini sudah diproses.");

    await clearSession(chatId);

    return ctx.editMessageText(
      `✅ *Saldo diperbarui*\n\n🏦 ${esc(sess.accountName)}\n💰 Saldo: *${esc(formatRupiah(newBalance))}*`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (data === "editrek_simpan_nama") {
    const oldName = sess.accountName;
    const newName = sess.newName;

    await updateAccountName(sess.accountId, ctx.from.id, newName);
    await clearSession(chatId);

    return ctx.editMessageText(
      `✅ *Nama rekening diperbarui*\n\n${esc(oldName)} → *${esc(newName)}*`,
      { parse_mode: "MarkdownV2" }
    );
  }
});

// ── TEXT MESSAGE HANDLER ──────────────────────────────────────
function parseMultiWalletInput(text, defaultLabel, isEth) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  const validator = isEth ? isValidEthereumAddress : isValidSolanaAddress;

  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    const dashIdx = line.indexOf("-");
    let label = "";
    let addrCandidate = line;

    if (colonIdx > 0 && colonIdx < line.length - 1) {
      label = line.slice(0, colonIdx).trim();
      addrCandidate = line.slice(colonIdx + 1).trim();
    } else if (dashIdx > 0 && dashIdx < line.length - 1) {
      label = line.slice(0, dashIdx).trim();
      addrCandidate = line.slice(dashIdx + 1).trim();
    }

    const tokens = addrCandidate.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);
    for (const token of tokens) {
      if (validator(token)) {
        items.push({
          label: label || defaultLabel,
          address: token,
        });
      }
    }
  }

  const uniqueMap = new Map();
  items.forEach(item => {
    if (!uniqueMap.has(item.address)) uniqueMap.set(item.address, item);
  });
  const uniqueItems = Array.from(uniqueMap.values());

  if (uniqueItems.length > 1) {
    uniqueItems.forEach((item, idx) => {
      if (item.label === defaultLabel) {
        item.label = `${defaultLabel} ${idx + 1}`;
      }
    });
  }

  return uniqueItems;
}

function parseQuickTransaction(text, accounts) {
  if (!accounts || !accounts.length) return null;
  const rawText = text.trim();
  if (rawText.startsWith("/")) return null;

  const nominalRegex = /(?:rp\.?\s*)?(\b\d+(?:[.,]\d+)?\s*(?:jt|juta|rb|ribu|k)?\b)/i;
  const nominalMatch = rawText.match(nominalRegex);
  if (!nominalMatch) return null;

  const rawNominalStr = nominalMatch[1];
  const amount = parseNominal(rawNominalStr);
  if (!isValidNominal(amount)) return null;

  const isExplicitMasuk = /\b(masuk|pemasukan|income|gaji|bonus|topup|terima|dapat)\b/i.test(rawText);
  const isExplicitKeluar = /\b(keluar|pengeluaran|expense|bayar|beli)\b/i.test(rawText);
  const type = isExplicitMasuk && !isExplicitKeluar ? "masuk" : "keluar";

  let remainder = rawText
    .replace(nominalMatch[0], "")
    .replace(/\b(keluar|pengeluaran|expense|masuk|pemasukan|income)\b/gi, "")
    .replace(/\b(dari|pakai|di|lewat|via|ke)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  let matchedAccount = null;
  for (const acc of accounts) {
    const accName = acc.bank_name.toLowerCase();
    const words = remainder.toLowerCase().split(/\s+/);
    if (words.includes(accName) || remainder.toLowerCase().includes(accName)) {
      matchedAccount = acc;
      const regex = new RegExp(`\\b${accName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "gi");
      remainder = remainder.replace(regex, "").trim();
      break;
    }
  }

  if (!matchedAccount) {
    if (accounts.length === 1) {
      matchedAccount = accounts[0];
    } else {
      if (isExplicitMasuk || isExplicitKeluar) {
        return { error: `Sebutkan nama rekening di chat\\. Contoh: \`${rawText} dari ${accounts[0].bank_name}\`` };
      }
      return null;
    }
  }

  const note = remainder.trim() || (type === "masuk" ? "Pemasukan" : "Pengeluaran");

  let category = "Lainnya";
  if (type === "keluar") {
    const lowerNote = note.toLowerCase();
    if (/makan|food|resto|warung|minum|kopi|bakso|nasi|gofood|grabfood/i.test(lowerNote)) category = "🍔 Makanan";
    else if (/bensin|grab|gojek|ojek|parkir|pertamina|taksi|angkot|toll/i.test(lowerNote)) category = "🚗 Transport";
    else if (/tagihan|listrik|pln|pdam|wifi|indihome|pulsa|kuota|kos|sewa|rumah|kursi|meja|kasur|perabot/i.test(lowerNote)) category = "🏠 Tagihan";
    else if (/shopee|tokopedia|lazada|baju|skincare|belanja|sepatu/i.test(lowerNote)) category = "👗 Gaya Hidup";
    else if (/game|steam|netflix|spotify|bioskop|nonton/i.test(lowerNote)) category = "🎮 Hiburan";
    else if (/obat|apotek|dokter|klinik|rumah sakit|vitamin/i.test(lowerNote)) category = "💊 Kesehatan";
  }

  return {
    type,
    amount,
    note,
    category,
    source: type === "masuk" ? (note || "📦 Lainnya") : "",
    account: matchedAccount,
  };
}

bot.on("message:text", async (ctx) => {
  // Security: Rate limiting
  if (isRateLimited(ctx.from.id)) return;

  const chatId = ctx.chat.id;
  const text = ctx.message.text.trim();
  const sess = await getSession(chatId);

  if (!sess.step && !text.startsWith("/")) {
    const accounts = await getAccounts(ctx.from.id);
    const quick = parseQuickTransaction(text, accounts);
    if (quick) {
      if (quick.error) return ctx.reply(`⚠️ ${quick.error}`, { parse_mode: "MarkdownV2" });
      const saved = await addTransaction(ctx.from.id, quick.account.id, quick.type, quick.amount, quick.note, quick.category, quick.source, createOperationId());
      if (!saved) return ctx.reply("⚠️ Transaksi gagal disimpan. Coba lagi.");
      const updated = await getAccountById(quick.account.id, ctx.from.id);
      await analyzeAndAlert(ctx, ctx.from.id).catch(() => {});
      return ctx.reply(`✅ *${quick.type === "masuk" ? "Pemasukan" : "Pengeluaran"} tercatat*\n\n${quick.type === "masuk" ? "⬆️" : "⬇️"} *${esc(formatRupiah(quick.amount))}*\n🏦 ${esc(updated.bank_name)}\n${quick.note ? `📝 ${esc(quick.note)}\n` : ""}💰 Saldo: *${esc(formatRupiah(updated.balance))}*`, { parse_mode: "MarkdownV2" });
    }
  }

  // Security: Input length validation
  const MAX_LENGTHS = {
    tambahbank_nama: 50,
    tambahbank_saldo: 20,
    tambahkategori_nama: 30,
    setlimit_nominal: 20,
    catat_input_kategori: 30,
    catat_nominal: 20,
    catat_keterangan: 100,
    editrek_input_saldo: 20,
    editrek_input_nama: 50,
    wallet_label: 50,
    wallet_address: 2000,
    wallet_rename: 50,
    wallet_replace_address: 60,
    eth_wallet_label: 50,
    eth_wallet_address: 2000,
    eth_wallet_rename: 50,
    eth_wallet_replace_address: 60,
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
    return ctx.reply(`💳 Nama rekening: *${esc(text)}*\n\nSekarang ketik *saldo awal* rekening ini:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("❌ Batal", "batal") });
  }

  if (sess.step === "tambahbank_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
    sess.bankBalance = nominal;
    sess.step = "tambahbank_konfirmasi";
    await saveSession(chatId, sess);
    return ctx.reply(`🏦 *Rekening Baru*\n\nNama: *${esc(sess.bankName)}*\nSaldo awal: *${esc(formatRupiah(nominal))}*\n\nPeriksa sebelum menyimpan\\.`, {
      parse_mode: "MarkdownV2",
      reply_markup: new InlineKeyboard().text("✅ Simpan Rekening", "tambahbank_simpan").row().text("✏️ Ubah Saldo", "tambahbank_ubah_saldo").text("❌ Batal", "batal"),
    });
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
    sess.note = text === "-" ? "" : text;
    await saveSession(chatId, sess);
    return sendCatatPreview(ctx, sess);
  }

  if (sess.step === "wallet_label") {
    if (text.length < 2) return ctx.reply("⚠️ Nama wallet minimal 2 karakter\\. Coba lagi\\.", { parse_mode: "MarkdownV2" });
    sess.walletLabel = text;
    sess.step = "wallet_address";
    await saveSession(chatId, sess);
    return ctx.reply("🔗 Kirim *public address* Solana\\.\n\n_Tips Multi\\-Wallet: Bisa kirim 1 address atau beberapa address sekaligus \\(1 per baris\\)\\._\n_Contoh multilabel:_\n\`Utama: 9UC6...La1U\`\n\`Trading: 7aX8...K9pL\`\n\n⚠️ Jangan pernah kirim seed phrase atau private key\\.", { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "wallet_address") {
    const items = parseMultiWalletInput(text, sess.walletLabel || "Solana", false);
    if (!items.length) return ctx.reply("⚠️ Address Solana tidak valid\\. Kirim public address Base58 32\\-byte\\. Jangan kirim private key\\.", { parse_mode: "MarkdownV2" });

    if (items.length === 1) {
      sess.walletAddress = items[0].address;
      sess.walletLabel = items[0].label;
      sess.step = "wallet_confirm";
      await saveSession(chatId, sess);
      return ctx.reply(`🪙 *Konfirmasi Wallet Solana*\n\n🏷 Nama\n*${esc(sess.walletLabel)}*\n\n🔗 Public Address\n\`${esc(items[0].address)}\``, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("✅ Simpan Wallet", "wallet_save").text("❌ Batal", "batal") });
    }

    let addedCount = 0;
    let resultMsg = `✅ *${items.length} Wallet Solana Berhasil Ditambahkan*\n\n`;
    for (const item of items) {
      try {
        const walletId = await addSolWallet(ctx.from.id, item.label, item.address);
        const wallet = await getSolWalletById(walletId, ctx.from.id);
        addedCount++;
        let balText = "Belum disinkronkan";
        try {
          const lamports = await syncSolWallet(wallet);
          balText = formatSol(lamports);
        } catch {}
        resultMsg += `🪙 *${esc(item.label)}*\n├ \`${shortenSolAddress(item.address)}\`\n└ 💰 *${esc(balText)}*\n\n`;
      } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
          resultMsg += `⚠️ *${esc(item.label)}* — Address sudah dipantau sebelumnya\n\n`;
        }
      }
    }
    await clearSession(chatId);
    return ctx.reply(resultMsg, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
  }

  if (sess.step === "wallet_rename") {
    if (text.length < 2) return ctx.reply("⚠️ Nama wallet minimal 2 karakter\\. Coba lagi\\.", { parse_mode: "MarkdownV2" });
    const updated = await renameSolWallet(sess.walletId, ctx.from.id, text);
    if (!updated) return ctx.reply("⚠️ Wallet tidak ditemukan\\. Buka daftar wallet lagi\\.", { parse_mode: "MarkdownV2" });
    await clearSession(chatId);
    return ctx.reply("✅ Nama wallet diperbarui\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
  }

  if (sess.step === "wallet_replace_address") {
    const address = text.trim();
    if (!isValidSolanaAddress(address)) return ctx.reply("⚠️ Address Solana tidak valid\\. Jangan kirim private key\\.", { parse_mode: "MarkdownV2" });
    try {
      const updated = await replaceSolWalletAddress(sess.walletId, ctx.from.id, address);
      if (!updated) return ctx.reply("⚠️ Wallet tidak ditemukan\\. Buka daftar wallet lagi\\.", { parse_mode: "MarkdownV2" });
      const wallet = await getSolWalletById(sess.walletId, ctx.from.id);
      await clearSession(chatId);
      try { await syncSolWallet(wallet); } catch { }
      return ctx.reply("✅ Address wallet diperbarui\\. Saldo sudah disinkronkan ulang\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return ctx.reply("⚠️ Address ini sudah dipantau\. Coba address lain\.", { parse_mode: "MarkdownV2" });
      throw error;
    }
  }

  if (sess.step === "eth_wallet_label") {
    if (text.length < 2) return ctx.reply("⚠️ Nama wallet minimal 2 karakter\\.", { parse_mode: "MarkdownV2" });
    sess.walletLabel = text;
    sess.step = "eth_wallet_address";
    await saveSession(chatId, sess);
    return ctx.reply("🔗 Kirim *public address* Ethereum\\.\n\n_Tips Multi\\-Wallet: Bisa kirim 1 address atau beberapa address sekaligus \\(1 per baris\\)\\._\n_Contoh multilabel:_\n\`Robinhood 1: 0x1234...abcd\`\n\`Robinhood 2: 0x5678...ef01\`\n\n⚠️ Jangan pernah kirim seed phrase atau private key\\.", { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "eth_wallet_address") {
    const items = parseMultiWalletInput(text, sess.walletLabel || "ETH Robinhood", true);
    if (!items.length) return ctx.reply("⚠️ Address Ethereum tidak valid\\. Format harus 0x diikuti 40 karakter hex\\. Jangan kirim private key\\.", { parse_mode: "MarkdownV2" });

    if (items.length === 1) {
      sess.walletAddress = items[0].address;
      sess.walletLabel = items[0].label;
      sess.step = "eth_wallet_confirm";
      await saveSession(chatId, sess);
      return ctx.reply(`⟠ *Konfirmasi Wallet ETH Robinhood*\n\n🏷 *${esc(sess.walletLabel)}*\n🔗 \`${esc(items[0].address)}\``, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("✅ Simpan Wallet", "eth_wallet_save").text("❌ Batal", "batal") });
    }

    let addedCount = 0;
    let resultMsg = `✅ *${items.length} Wallet ETH Robinhood Berhasil Ditambahkan*\n\n`;
    for (const item of items) {
      try {
        const walletId = await addEthWallet(ctx.from.id, item.label, item.address);
        const wallet = await getEthWalletById(walletId, ctx.from.id);
        addedCount++;
        let balText = "Belum disinkronkan";
        try {
          const wei = await syncEthWallet(wallet);
          balText = formatEth(wei);
        } catch {}
        resultMsg += `⟠ *${esc(item.label)}*\n├ \`${shortenEthAddress(item.address)}\`\n└ 💰 *${esc(balText)}*\n\n`;
      } catch (err) {
        if (String(err.message).includes("UNIQUE")) {
          resultMsg += `⚠️ *${esc(item.label)}* — Address sudah dipantau sebelumnya\n\n`;
        }
      }
    }
    await clearSession(chatId);
    return ctx.reply(resultMsg, { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
  }

  if (sess.step === "eth_wallet_rename") {
    if (text.length < 2) return ctx.reply("⚠️ Nama wallet minimal 2 karakter\\.", { parse_mode: "MarkdownV2" });
    const updated = await renameEthWallet(sess.walletId, ctx.from.id, text);
    await clearSession(chatId);
    return ctx.reply(updated ? "✅ Nama wallet ETH diperbarui\\." : "⚠️ Wallet ETH tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
  }

  if (sess.step === "eth_wallet_replace_address") {
    if (!isValidEthereumAddress(text)) return ctx.reply("⚠️ Address Ethereum tidak valid\\.", { parse_mode: "MarkdownV2" });
    const updated = await replaceEthWalletAddress(sess.walletId, ctx.from.id, text);
    if (!updated) return ctx.reply("⚠️ Wallet ETH tidak ditemukan\\.", { parse_mode: "MarkdownV2" });
    const wallet = await getEthWalletById(sess.walletId, ctx.from.id);
    await clearSession(chatId);
    try { await syncEthWallet(wallet); } catch { }
    return ctx.reply("✅ Address wallet ETH diperbarui\\. Saldo sudah disinkronkan ulang\\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["👛 Wallet", "menu_wallet"]) });
  }

  if (sess.step === "transfer_amount") {
    const amount = parseNominal(text);
    if (!isValidNominal(amount)) return ctx.reply("⚠️ Nominal tidak valid\. Coba lagi\.", { parse_mode: "MarkdownV2" });
    sess.transferAmount = amount;
    sess.step = "transfer_note_prompt";
    await saveSession(chatId, sess);
    return ctx.reply(`📝 Tambah catatan transfer? ${esc("(opsional)")}`, { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard().text("✏️ Tambah Catatan", "transfer_edit_note").text("⏭ Lewati", "transfer_note_skip").row().text("❌ Batal", "batal") });
  }

  if (sess.step === "transfer_note") {
    sess.transferNote = text === "-" ? "" : text;
    sess.transferId = sess.transferId || createOperationId();
    sess.step = "transfer_confirm";
    await saveSession(chatId, sess);
    return sendTransferPreview(ctx, sess);
  }

  if (sess.step === "txedit_amount") {
    const amount = parseNominal(text);
    if (!isValidNominal(amount)) return ctx.reply("⚠️ Nominal tidak valid\. Coba lagi\.", { parse_mode: "MarkdownV2" });
    const updated = await updateTransactionAmount(sess.txId, ctx.from.id, sess.txRevision, amount);
    if (!updated) return ctx.reply("⚠️ Transaksi sudah berubah atau terhapus\. Buka riwayat lagi\.", { parse_mode: "MarkdownV2" });
    await clearSession(chatId);
    return ctx.reply("✅ Nominal transaksi diperbarui\. Saldo rekening sudah disesuaikan\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["📋 Riwayat", "menu_riwayat"]) });
  }

  if (sess.step === "txedit_note") {
    const updated = await updateTransactionNote(sess.txId, ctx.from.id, sess.txRevision, text === "-" ? "" : text);
    if (!updated) return ctx.reply("⚠️ Transaksi sudah berubah atau terhapus\. Buka riwayat lagi\.", { parse_mode: "MarkdownV2" });
    await clearSession(chatId);
    return ctx.reply("✅ Catatan transaksi diperbarui\.", { parse_mode: "MarkdownV2", reply_markup: createNavigationKeyboard(["📋 Riwayat", "menu_riwayat"]) });
  }

  if (sess.step === "ocr_input_nominal") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal)) {
      return ctx.reply("⚠️ Nominal tidak valid\\. Contoh: _25000 / 25rb / 1jt_", { parse_mode: "MarkdownV2" });
    }
    const list = sess.ocrList || [];
    const index = sess.ocrIndex || 0;
    if (!list[index]) {
      await clearSession(chatId);
      return ctx.reply("⚠️ Sesi scan berakhir\\. Kirim screenshot lagi untuk melanjutkan\\.", {
        parse_mode: "MarkdownV2",
        reply_markup: createNavigationKeyboard(["📸 Scan Screenshot", "menu_scan"]),
      });
    }
    list[index].nominal = nominal;
    sess.ocrList = list;
    delete sess.step;
    await saveSession(chatId, sess);
    return showOcrKonfirmasi(ctx, sess, await getAccounts(ctx.from.id));
  }

  // ── EDIT REKENING TEXT INPUTS ──────────────────────────────
  if (sess.step === "editrek_input_saldo") {
    const nominal = parseNominal(text);
    if (!isValidNominal(nominal) && nominal !== 0) {
      return ctx.reply(`⚠️ Nominal tidak valid\\. Coba lagi:\n_Contoh: 500000 / 500rb / 2jt_`, { parse_mode: "MarkdownV2" });
    }

    sess.newBalance = nominal;
    sess.operationId = createOperationId();
    const oldBalance = sess.currentBalance;
    const diff = nominal - oldBalance;
    const selisih = diff >= 0 ? `\\+${esc(formatRupiah(diff))}` : `\\-${esc(formatRupiah(Math.abs(diff)))}`;

    sess.step = "editrek_konfirmasi_saldo";
    await saveSession(chatId, sess);

    const kb = new InlineKeyboard()
      .text("✅ Ya, Ubah Saldo", "editrek_simpan_saldo").row()
      .text("❌ Batal", "batal");

    return ctx.reply(
      `🔍 *Konfirmasi Perubahan Saldo*\n\n🏦 ${esc(sess.accountName)}\n💰 Saldo lama: *${esc(formatRupiah(oldBalance))}*\n✅ Saldo baru: *${esc(formatRupiah(nominal))}*\n📊 Selisih: ${selisih}`,
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
      `🔍 *Konfirmasi Perubahan Nama*\n\nNama lama: *${esc(sess.accountName)}*\n✅ Nama baru: *${esc(text)}*`,
      { parse_mode: "MarkdownV2", reply_markup: kb }
    );
  }

  return ctx.reply("🤔 Pesan belum dikenali\\. Pilih menu untuk melanjutkan\\.", {
    parse_mode: "MarkdownV2",
    reply_markup: createNavigationKeyboard(),
  });
});

// ── VERCEL HANDLER ────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ status: "MyDuit Ku Bot is running 💰" });
  }

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
    console.warn("Unauthorized webhook request blocked");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const t0 = Date.now();

  try {
    await initPromise;
    await bot.handleUpdate(req.body);
    console.log(`⏱ handleUpdate (total): ${Date.now() - t0}ms`);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Bot error:", err);
    res.status(200).json({ ok: false });
  }
}
