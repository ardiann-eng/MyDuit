import { Bot } from "grammy";
import {
  initDB,
  getAllUsers,
  getAccounts,
  getTodayTransactions,
  getLastMonthTransactions,
  getAlertLogWithCooldown,
  logAlert,
} from "../lib/db.js";
import { formatRupiah, esc } from "../lib/format.js";

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

export default async function handler(req, res) {
  // Security: only allow Vercel cron calls
  const authHeader = req.headers["authorization"];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await initDB();
    
    const now = new Date();
    // Convert to WIB (UTC+7)
    const wibHour = (now.getUTCHours() + 7) % 24;
    const wibDay = now.getUTCDate();

    // Detect which cron is running based on UTC hour and day
    const isMonthlyReport = wibDay === 1 && wibHour >= 7 && wibHour <= 9;
    const isDailyReminder = wibHour >= 20 && wibHour <= 22;

    const users = await getAllUsers();
    
    const results = { sent: 0, skipped: 0, errors: 0 };

    for (const user of users) {
      try {
        // Parallelize per-user operations: monthly/daily reports and low balance alert
        await Promise.all([
          isMonthlyReport ? sendMonthlyReport(user.telegram_id, user.name).then(() => results.sent++) : Promise.resolve(),
          isDailyReminder ? sendDailyReminder(user.telegram_id, user.name).then(sent => { if (sent) results.sent++; else results.skipped++; }) : Promise.resolve(),
          sendLowBalanceAlert(user.telegram_id),
        ]);
        
      } catch (err) {
        console.error(`Error for user ${user.telegram_id}:`, err);
        results.errors++;
      }
    }

    console.log("Cron results:", results);
    return res.status(200).json({ ok: true, ...results });
    
  } catch (err) {
    console.error("Cron error:", err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}

async function sendDailyReminder(telegramId, name) {
  try {
    // Check if user has any transaction TODAY
    const todayTx = await getTodayTransactions(telegramId);
    
    // If already recorded something today, skip
    if (todayTx.length > 0) return false;
    
    // Check if user has at least 1 account (active user)
    const accounts = await getAccounts(telegramId);
    if (accounts.length === 0) return false;

    const firstName = name ? name.split(" ")[0] : "kamu";

    const messages = [
      `👀 Hei *${esc(firstName)}\\!* Kamu belum catat transaksi hari ini lho\\.\\nJangan lupa dicatat biar keuanganmu tetap terkontrol ya\\! 💪`,
      `📝 *Reminder malam\\!*\\nBelum ada catatan transaksi hari ini nih\\.\\nYuk luangkan 30 detik buat catat pengeluaranmu\\! 🕐`,
      `💸 *${esc(firstName)},* hari ini belum ada catatan transaksi\\.\\nBiasanya lupa itu musuh terbesar keuangan sehat 😅\\nYuk catat sekarang\\!`,
    ];

    // Rotate messages so it doesn't feel repetitive
    const dayOfYear = Math.floor(Date.now() / 86400000);
    const msg = messages[dayOfYear % messages.length];

    await bot.api.sendMessage(telegramId, msg, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[
          { text: "✏️ Catat Sekarang", callback_data: "menu_catat" }
        ]]
      }
    });

    return true;
  } catch (err) {
    // User blocked bot or other errors
    console.warn(`Cannot send daily reminder to ${telegramId}:`, err.message);
    return false;
  }
}

async function sendMonthlyReport(telegramId, name) {
  try {
    // Get last month's transactions
    const lastMonthTx = await getLastMonthTransactions(telegramId);
    
    if (lastMonthTx.length === 0) return;

    const accounts = await getAccounts(telegramId);
    const totalBalance = accounts.reduce((a, b) => a + b.balance, 0);

    const pemasukan = lastMonthTx
      .filter(t => t.type === "masuk")
      .reduce((a, b) => a + b.amount, 0);

    const pengeluaran = lastMonthTx
      .filter(t => t.type === "keluar")
      .reduce((a, b) => a + b.amount, 0);

    const selisih = pemasukan - pengeluaran;
    const selisihIcon = selisih >= 0 ? "✅" : "⚠️";
    const selisihLabel = selisih >= 0 ? "Surplus" : "Defisit";

    // Get last month name in Indonesian
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const bulan = lastMonth.toLocaleDateString("id-ID", { 
      month: "long", year: "numeric" 
    });

    const firstName = name ? name.split(" ")[0] : "kamu";

    const msg =
      `📊 *Laporan Bulan ${esc(bulan)}*\n` +
      `Halo *${esc(firstName)}\\!* Ini ringkasan keuanganmu bulan lalu\\.\n\n` +
      `💰 Pemasukan  : *${esc(formatRupiah(pemasukan))}*\n` +
      `💸 Pengeluaran: *${esc(formatRupiah(pengeluaran))}*\n` +
      `${selisihIcon} ${selisihLabel}   : *${esc(formatRupiah(Math.abs(selisih)))}*\n` +
      `──────────────────\n` +
      `🏦 Saldo saat ini: *${esc(formatRupiah(totalBalance))}*\n` +
      `📝 Total transaksi: *${lastMonthTx.length} transaksi*\n\n` +
      `_Semangat mengatur keuangan bulan ini\\! 💪_`;

    await bot.api.sendMessage(telegramId, msg, {
      parse_mode: "MarkdownV2",
      reply_markup: {
        inline_keyboard: [[
          { text: "📈 Lihat Detail", callback_data: "menu_laporan" }
        ]]
      }
    });
  } catch (err) {
    console.warn(`Cannot send monthly report to ${telegramId}:`, err.message);
  }
}

async function sendLowBalanceAlert(telegramId) {
  try {
    const accounts = await getAccounts(telegramId);
    if (accounts.length === 0) return;

    for (const acc of accounts) {
      // Alert if balance < 10% of initial_balance
      // AND initial_balance > 0 to avoid divide by zero
      if (acc.initial_balance <= 0) continue;
      
      const ratio = acc.balance / acc.initial_balance;
      if (ratio >= 0.10) continue; // not low, skip

      // Check cooldown: only alert once per 12 hours per account
      const alreadyAlerted = await getAlertLogWithCooldown(
        telegramId,
        `low_balance_cron_${acc.id}`,
        12
      );
      if (alreadyAlerted) continue;

      const percent = Math.round(ratio * 100);

      const msg =
        `🚨 *Saldo Hampir Habis\\!*\n` +
        `──────────────────\n` +
        `🏦 Rekening : *${esc(acc.bank_name)}*\n` +
        `💰 Saldo    : *${esc(formatRupiah(acc.balance))}*\n` +
        `📉 Tersisa  : *${percent}%* dari saldo awal\n` +
        `──────────────────\n` +
        `_Segera isi saldo atau kurangi pengeluaran ya\\!_ 💡`;

      await bot.api.sendMessage(telegramId, msg, {
        parse_mode: "MarkdownV2"
      });

      // Log the alert
      await logAlert(telegramId, `low_balance_cron_${acc.id}`);
    }
  } catch (err) {
    console.warn(`Error checking low balance for ${telegramId}:`, err.message);
  }
}
