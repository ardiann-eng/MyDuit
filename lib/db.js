// lib/db.js
import { createClient } from "@libsql/client";

// Koneksi ke Turso — isi via environment variable di Vercel
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ── INISIALISASI TABEL ─────────────────────────────────────────
export async function initDB() {
  await db.batch([
    // Tabel user
    `CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      telegram_id TEXT    UNIQUE NOT NULL,
      name        TEXT    NOT NULL,
      created_at  TEXT    DEFAULT (datetime('now','localtime'))
    )`,

    // Tabel rekening / akun bank
    `CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT    NOT NULL,
      bank_name   TEXT    NOT NULL,
      balance     REAL    NOT NULL DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now','localtime'))
    )`,

    // Tabel transaksi
    `CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT    NOT NULL,
      account_id  INTEGER NOT NULL,
      type        TEXT    NOT NULL CHECK(type IN ('masuk','keluar')),
      amount      REAL    NOT NULL,
      note        TEXT,
      created_at  TEXT    DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`,
  ]);
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
    sql: `INSERT INTO accounts (telegram_id, bank_name, balance) VALUES (?, ?, ?)`,
    args: [String(telegramId), bankName, initialBalance],
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
  await db.batch([
    {
      sql: `DELETE FROM transactions WHERE account_id = ? AND telegram_id = ?`,
      args: [accountId, String(telegramId)],
    },
    {
      sql: `DELETE FROM accounts WHERE id = ? AND telegram_id = ?`,
      args: [accountId, String(telegramId)],
    },
  ]);
}

// ── TRANSAKSI ──────────────────────────────────────────────────
export async function addTransaction(telegramId, accountId, type, amount, note) {
  // Catat transaksi
  await db.execute({
    sql: `INSERT INTO transactions (telegram_id, account_id, type, amount, note)
          VALUES (?, ?, ?, ?, ?)`,
    args: [String(telegramId), accountId, type, amount, note || ""],
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

export default db;
