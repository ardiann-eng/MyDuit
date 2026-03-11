// lib/db.js
import { createClient } from "@libsql/client";

// Koneksi ke Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── INISIALISASI TABEL ─────────────────────────────────────────
export async function initDB() {
  await db.execute(`CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY,
    telegram_id TEXT    UNIQUE NOT NULL,
    name        TEXT    NOT NULL,
    created_at  TEXT    DEFAULT (datetime('now','localtime'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT    NOT NULL,
    bank_name   TEXT    NOT NULL,
    balance     REAL    NOT NULL DEFAULT 0,
    created_at  TEXT    DEFAULT (datetime('now','localtime'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT    NOT NULL,
    account_id  INTEGER NOT NULL,
    type        TEXT    NOT NULL CHECK(type IN ('masuk','keluar')),
    amount      REAL    NOT NULL,
    note        TEXT,
    created_at  TEXT    DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  )`);

  // New Tables
  await db.execute(`CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    emoji       TEXT DEFAULT '📌',
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS category_suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    count        INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(telegram_id, name)
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    alert_type  TEXT NOT NULL,
    sent_at     TEXT DEFAULT (datetime('now','localtime'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS user_settings (
    telegram_id       TEXT PRIMARY KEY,
    monthly_income    REAL DEFAULT 0,
    daily_limit       REAL DEFAULT 0,
    limit_mode        TEXT DEFAULT 'auto',
    last_recalc       TEXT DEFAULT (datetime('now','localtime')),
    updated_at        TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ALTER TABLES to add new columns if they do not exist
  try { await db.execute(`ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'Lainnya'`); } catch (e) { }
  try { await db.execute(`ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT ''`); } catch (e) { }
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN initial_balance REAL DEFAULT 0`); } catch (e) { }

  // Try adding new columns to existing user_settings if upgrading from older version
  try { await db.execute(`ALTER TABLE user_settings ADD COLUMN monthly_income REAL DEFAULT 0`); } catch (e) { }
  try { await db.execute(`ALTER TABLE user_settings ADD COLUMN limit_mode TEXT DEFAULT 'auto'`); } catch (e) { }
  try { await db.execute(`ALTER TABLE user_settings ADD COLUMN last_recalc TEXT DEFAULT (datetime('now','localtime'))`); } catch (e) { }

  // Session storage table
  await db.execute(`CREATE TABLE IF NOT EXISTS sessions (
    chat_id    TEXT PRIMARY KEY,
    data       TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // Cleanup old sessions (older than 1 hour)
  try {
    await db.execute(`
      DELETE FROM sessions 
      WHERE updated_at < datetime('now', '-1 hours', 'localtime')
    `);
  } catch (e) {
    console.error("Session cleanup error:", e);
  }
}

// ── USER ───────────────────────────────────────────────────────
export async function upsertUser(telegramId, name) {
  await db.execute({
    sql: `INSERT INTO users (telegram_id, name)
          VALUES (?, ?)
          ON CONFLICT(telegram_id) DO UPDATE SET name = excluded.name`,
    args: [String(telegramId), name],
  });
}

// ── REKENING ───────────────────────────────────────────────────
export async function addAccount(telegramId, bankName, initialBalance) {
  const result = await db.execute({
    sql: `INSERT INTO accounts (telegram_id, bank_name, balance, initial_balance) VALUES (?, ?, ?, ?)`,
    args: [String(telegramId), bankName, initialBalance, initialBalance],
  });
  return result.lastInsertRowid;
}

export async function getAccounts(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM accounts WHERE telegram_id = ? ORDER BY created_at ASC`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function getAccountById(accountId, telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM accounts WHERE id = ? AND telegram_id = ?`,
    args: [accountId, String(telegramId)],
  });
  return result.rows[0] || null;
}

export async function deleteAccount(accountId, telegramId) {
  await db.execute({
    sql: `DELETE FROM transactions WHERE account_id = ? AND telegram_id = ?`,
    args: [accountId, String(telegramId)],
  });
  await db.execute({
    sql: `DELETE FROM accounts WHERE id = ? AND telegram_id = ?`,
    args: [accountId, String(telegramId)],
  });
}

// ── UPDATE REKENING ────────────────────────────────────────────
export async function updateAccountBalance(accountId, telegramId, newBalance) {
  await db.execute({
    sql: `UPDATE accounts SET balance = ? WHERE id = ? AND telegram_id = ?`,
    args: [newBalance, accountId, String(telegramId)],
  });
}

export async function updateAccountName(accountId, telegramId, newName) {
  await db.execute({
    sql: `UPDATE accounts SET bank_name = ? WHERE id = ? AND telegram_id = ?`,
    args: [newName, accountId, String(telegramId)],
  });
}

// ── TRANSAKSI ──────────────────────────────────────────────────
export async function addTransaction(telegramId, accountId, type, amount, note, category = 'Lainnya', source = '') {
  // Catat transaksi
  await db.execute({
    sql: `INSERT INTO transactions (telegram_id, account_id, type, amount, note, category, source)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [String(telegramId), accountId, type, amount, note || "", category, source],
  });

  // Update saldo rekening
  const delta = type === "masuk" ? amount : -amount;
  await db.execute({
    sql: `UPDATE accounts SET balance = balance + ? WHERE id = ? AND telegram_id = ?`,
    args: [delta, accountId, String(telegramId)],
  });
}

export async function getRecentTransactions(telegramId, limit = 10) {
  const result = await db.execute({
    sql: `SELECT t.*, a.bank_name
          FROM transactions t
          JOIN accounts a ON t.account_id = a.id
          WHERE t.telegram_id = ?
          ORDER BY t.created_at DESC
          LIMIT ?`,
    args: [String(telegramId), limit],
  });
  return result.rows;
}

// ── KATEGORI PENGELUARAN ───────────────────────────────────────
export async function addCustomCategory(telegramId, name, emoji = '📌') {
  await db.execute({
    sql: `INSERT INTO categories (telegram_id, name, emoji) VALUES (?, ?, ?)`,
    args: [String(telegramId), name, emoji],
  });
}

export async function getCustomCategories(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM categories WHERE telegram_id = ? ORDER BY created_at ASC`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function upsertCategorySuggestion(telegramId, name) {
  await db.execute({
    sql: `INSERT INTO category_suggestions (telegram_id, name, count) 
          VALUES (?, ?, 1)
          ON CONFLICT(telegram_id, name) DO UPDATE SET count = count + 1`,
    args: [String(telegramId), name],
  });
}

export async function getCategorySuggestions(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM category_suggestions WHERE telegram_id = ? AND count >= 3 ORDER BY count DESC LIMIT 3`,
    args: [String(telegramId)],
  });
  return result.rows;
}

// ── USER SETTINGS ──────────────────────────────────────────────
export async function getUserSettings(telegramId) {
  let result = await db.execute({
    sql: `SELECT * FROM user_settings WHERE telegram_id = ?`,
    args: [String(telegramId)],
  });
  if (result.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO user_settings (telegram_id, daily_limit) VALUES (?, 0)`,
      args: [String(telegramId)],
    });
    result = await db.execute({
      sql: `SELECT * FROM user_settings WHERE telegram_id = ?`,
      args: [String(telegramId)],
    });
  }
  return result.rows[0];
}

export async function updateDailyLimit(telegramId, limit, limit_mode = 'custom') {
  await db.execute({
    sql: `INSERT INTO user_settings (telegram_id, daily_limit, limit_mode, updated_at) 
          VALUES (?, ?, ?, datetime('now','localtime'))
          ON CONFLICT(telegram_id) DO UPDATE SET daily_limit = excluded.daily_limit, limit_mode = excluded.limit_mode, updated_at = excluded.updated_at`,
    args: [String(telegramId), limit, limit_mode],
  });
}

export async function updateSmartLimit(telegramId, limit) {
  await db.execute({
    sql: `UPDATE user_settings SET daily_limit = ?, limit_mode = 'auto', last_recalc = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE telegram_id = ?`,
    args: [limit, String(telegramId)],
  });
}

export async function updateLimitRecalcTime(telegramId) {
  await db.execute({
    sql: `UPDATE user_settings SET last_recalc = datetime('now','localtime'), updated_at = datetime('now','localtime') WHERE telegram_id = ?`,
    args: [String(telegramId)],
  });
}

// ── ALERTS & REPORTS HELPER ────────────────────────────────────
export async function getDailySpend(telegramId) {
  const result = await db.execute({
    sql: `SELECT SUM(amount) as total FROM transactions 
          WHERE telegram_id = ? AND type = 'keluar' AND date(created_at) = date('now','localtime')`,
    args: [String(telegramId)],
  });
  return result.rows[0].total || 0;
}

export async function getWeeklySpend(telegramId, offsetWeeks = 0) {
  const modifier = `-${offsetWeeks * 7} days`;
  const result = await db.execute({
    sql: `SELECT SUM(amount) as total FROM transactions 
          WHERE telegram_id = ? AND type = 'keluar' 
          AND strftime('%Y-%W', created_at) = 
              strftime('%Y-%W', date('now', ?, 'localtime'))`,
    args: [String(telegramId), modifier],
  });
  return result.rows[0].total || 0;
}

export async function getAlertLog(telegramId, alertType) {
  const result = await db.execute({
    sql: `SELECT * FROM alert_log WHERE telegram_id = ? AND alert_type = ?
    AND date(sent_at) = date('now', 'localtime')`,
    args: [String(telegramId), alertType],
  });
  return result.rows.length > 0;
}

export async function getAlertLogWithCooldown(telegramId, alertType, hoursDelay) {
  const safeHours = Math.max(1, Math.min(168, parseInt(hoursDelay) || 24));
  const result = await db.execute({
    sql: `SELECT * FROM alert_log 
          WHERE telegram_id = ? AND alert_type = ?
          AND sent_at > datetime('now', '-' || CAST(? AS TEXT) || ' hours', 'localtime')`,
    args: [String(telegramId), alertType, safeHours],
  });
  return result.rows.length > 0;
}

export async function logAlert(telegramId, alertType) {
  await db.execute({
    sql: `INSERT INTO alert_log(telegram_id, alert_type) VALUES(?, ?)`,
    args: [String(telegramId), alertType],
  });
}

export async function getTransactionsByDateRange(telegramId, type = 'keluar', days = 30) {
  const safeDays = Math.max(1, Math.min(365, parseInt(days) || 30));
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
          WHERE telegram_id = ? AND type = ? 
          AND created_at >= datetime('now', '-' || CAST(? AS TEXT) || ' days', 'localtime')
          ORDER BY created_at DESC`,
    args: [String(telegramId), type, safeDays],
  });
  return result.rows;
}

export async function getTransactionsByDayGrouped(telegramId, days = 30) {
  const safeDays = Math.max(1, Math.min(365, parseInt(days) || 30));
  const result = await db.execute({
    sql: `SELECT date(created_at) as tx_date, SUM(amount) as daily_total 
          FROM transactions 
          WHERE telegram_id = ? AND type = 'keluar' 
          AND created_at >= datetime('now', '-' || CAST(? AS TEXT) || ' days', 'localtime')
          GROUP BY date(created_at)
          ORDER BY tx_date ASC`,
    args: [String(telegramId), safeDays],
  });
  return result.rows;
}

export async function getTransactionsForCurrentMonth(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
          WHERE telegram_id = ?
    AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
          ORDER BY created_at DESC`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function getTransactionsForCurrentWeek(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
          WHERE telegram_id = ?
    AND strftime('%Y-%W', created_at) = strftime('%Y-%W', 'now', 'localtime')
          ORDER BY created_at DESC`,
    args: [String(telegramId)],
  });
  return result.rows;
}

// ── SESSION STORAGE (Turso-backed) ─────────────────────────────
export async function getSessionData(chatId) {
  try {
    const result = await db.execute({
      sql: `SELECT data FROM sessions WHERE chat_id = ?`,
      args: [String(chatId)],
    });
    if (result.rows.length === 0) return {};
    return JSON.parse(result.rows[0].data || "{}");
  } catch (e) {
    console.error("Session load error:", e);
    return {};
  }
}

export async function setSessionData(chatId, data) {
  try {
    await db.execute({
      sql: `INSERT INTO sessions (chat_id, data, updated_at)
            VALUES (?, ?, datetime('now','localtime'))
            ON CONFLICT(chat_id) DO UPDATE SET 
              data = excluded.data,
              updated_at = excluded.updated_at`,
      args: [String(chatId), JSON.stringify(data)],
    });
  } catch (e) {
    console.error("Session save error:", e);
  }
}

export async function clearSessionData(chatId) {
  try {
    await db.execute({
      sql: `DELETE FROM sessions WHERE chat_id = ?`,
      args: [String(chatId)],
    });
  } catch (e) {
    console.error("Session delete error:", e);
  }
}

// ── CRON & NOTIFICATIONS ────────────────────────────────────────
export async function getAllUsers() {
  const result = await db.execute(
    `SELECT telegram_id, name FROM users ORDER BY created_at ASC`
  );
  return result.rows;
}

export async function getTodayTransactions(telegramId) {
  const result = await db.execute({
    sql: `SELECT id FROM transactions 
          WHERE telegram_id = ? 
          AND date(created_at) = date('now', 'localtime')`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function getLastMonthTransactions(telegramId) {
  const result = await db.execute({
    sql: `SELECT type, amount FROM transactions
          WHERE telegram_id = ?
          AND strftime('%Y-%m', created_at) = 
              strftime('%Y-%m', 'now', 'localtime', '-1 month')`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export default db;
