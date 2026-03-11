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

  await db.execute(`CREATE TABLE IF NOT EXISTS alert_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT NOT NULL,
    alert_type  TEXT NOT NULL,
    sent_at     TEXT DEFAULT (datetime('now','localtime'))
  )`);

  await db.execute(`CREATE TABLE IF NOT EXISTS user_settings (
    telegram_id  TEXT PRIMARY KEY,
    daily_limit  REAL DEFAULT 0,
    updated_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ALTER TABLES to add new columns if they do not exist
  try { await db.execute(`ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'Lainnya'`); } catch (e) { }
  try { await db.execute(`ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT ''`); } catch (e) { }
  try { await db.execute(`ALTER TABLE accounts ADD COLUMN initial_balance REAL DEFAULT 0`); } catch (e) { }
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

export async function updateDailyLimit(telegramId, limit) {
  await db.execute({
    sql: `INSERT INTO user_settings (telegram_id, daily_limit, updated_at) 
          VALUES (?, ?, datetime('now','localtime'))
          ON CONFLICT(telegram_id) DO UPDATE SET daily_limit = excluded.daily_limit, updated_at = excluded.updated_at`,
    args: [String(telegramId), limit],
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
  const modifier = offsetWeeks > 0 ? `-${offsetWeeks * 7} days` : 'now';
  const result = await db.execute({
    sql: `SELECT SUM(amount) as total FROM transactions 
          WHERE telegram_id = ? AND type = 'keluar' 
          AND strftime('%Y-%W', created_at) = strftime('%Y-%W', date('now', ?, 'localtime'))`,
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

export async function logAlert(telegramId, alertType) {
  await db.execute({
    sql: `INSERT INTO alert_log(telegram_id, alert_type) VALUES(?, ?)`,
    args: [String(telegramId), alertType],
  });
}

export async function getTransactionsByDateRange(telegramId, type = 'keluar', days = 30) {
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
          WHERE telegram_id = ? AND type = ? 
          AND created_at >= datetime('now', '-${days} days', 'localtime')
          ORDER BY created_at DESC`,
    args: [String(telegramId), type],
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

export default db;
