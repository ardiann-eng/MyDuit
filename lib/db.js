// lib/db.js
import { createClient } from "@libsql/client";

// Koneksi ke Turso
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

db.execute("SELECT 1").catch(() => {});

let _dbReady = false;

// ── INISIALISASI TABEL ─────────────────────────────────────────
export async function initDB() {
  if (_dbReady) return;
  // Phase 1: Create all tables in parallel
  await Promise.all([
    db.execute(`CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY,
      telegram_id TEXT    UNIQUE NOT NULL,
      name        TEXT    NOT NULL,
      created_at  TEXT    DEFAULT (datetime('now'))
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS accounts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT    NOT NULL,
      bank_name   TEXT    NOT NULL,
      balance     REAL    NOT NULL DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT    NOT NULL,
      account_id  INTEGER NOT NULL,
      type        TEXT    NOT NULL CHECK(type IN ('masuk','keluar')),
      amount      REAL    NOT NULL,
      note        TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      name        TEXT NOT NULL,
      emoji       TEXT DEFAULT '📌',
      created_at  TEXT DEFAULT (datetime('now','localtime'))
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS category_suggestions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id  TEXT NOT NULL,
      name         TEXT NOT NULL,
      count        INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(telegram_id, name)
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS alert_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      alert_type  TEXT NOT NULL,
      sent_at     TEXT DEFAULT (datetime('now','localtime'))
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS user_settings (
      telegram_id       TEXT PRIMARY KEY,
      monthly_income    REAL DEFAULT 0,
      daily_limit       REAL DEFAULT 0,
      limit_mode        TEXT DEFAULT 'auto',
      last_recalc       TEXT DEFAULT (datetime('now','localtime')),
      updated_at        TEXT DEFAULT (datetime('now','localtime'))
    )`),
    db.execute(`CREATE TABLE IF NOT EXISTS sessions (
      chat_id    TEXT PRIMARY KEY,
      data       TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT DEFAULT (datetime('now','localtime'))
    )`),
  ]);

  // Phase 1b: Create indexes for common query patterns
  await Promise.all([
    db.execute(`CREATE INDEX IF NOT EXISTS idx_transactions_telegram_date 
                ON transactions(telegram_id, created_at DESC)`).catch(() => { }),
    db.execute(`CREATE INDEX IF NOT EXISTS idx_transactions_type 
                ON transactions(telegram_id, type, created_at DESC)`).catch(() => { }),
    db.execute(`CREATE INDEX IF NOT EXISTS idx_alert_log_lookup 
                ON alert_log(telegram_id, alert_type, sent_at DESC)`).catch(() => { }),
    db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_updated 
                ON sessions(updated_at)`).catch(() => { }),
  ]);

  // Phase 2: Create a meta table to track schema version
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  // Check current schema version
  let schemaVersion = 0;
  try {
    const versionRow = await db.execute(
      `SELECT value FROM schema_meta WHERE key = 'version'`
    );
    schemaVersion = parseInt(versionRow.rows[0]?.value || "0");
  } catch (e) { }

  // Only run migrations if needed
  if (schemaVersion < 1) {
    await Promise.all([
      db.execute(`ALTER TABLE transactions ADD COLUMN category TEXT DEFAULT 'Lainnya'`).catch(() => { }),
      db.execute(`ALTER TABLE transactions ADD COLUMN source TEXT DEFAULT ''`).catch(() => { }),
      db.execute(`ALTER TABLE accounts ADD COLUMN initial_balance REAL DEFAULT 0`).catch(() => { }),
      db.execute(`ALTER TABLE user_settings ADD COLUMN monthly_income REAL DEFAULT 0`).catch(() => { }),
      db.execute(`ALTER TABLE user_settings ADD COLUMN limit_mode TEXT DEFAULT 'auto'`).catch(() => { }),
      db.execute(`ALTER TABLE user_settings ADD COLUMN last_recalc TEXT DEFAULT (datetime('now','localtime'))`).catch(() => { }),
    ]);

    // Mark migration as done
    await db.execute({
      sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '1')
            ON CONFLICT(key) DO UPDATE SET value = '1'`,
      args: [],
    });
    schemaVersion = 1;
  }

  if (schemaVersion < 2) {
    await Promise.all([
      db.execute(`ALTER TABLE transactions ADD COLUMN is_balance_correction INTEGER NOT NULL DEFAULT 0`).catch(() => { }),
      db.execute(`ALTER TABLE transactions ADD COLUMN operation_id TEXT`).catch(() => { }),
    ]);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_operation_id
                      ON transactions(operation_id) WHERE operation_id IS NOT NULL`);
    await db.execute(`UPDATE transactions
                      SET is_balance_correction = 1
                      WHERE category = '⚙️ Koreksi'`);

    await db.execute({
      sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '2')
            ON CONFLICT(key) DO UPDATE SET value = '2'`,
      args: [],
    });
  }

  if (schemaVersion < 3) {
    await db.execute(`ALTER TABLE transactions ADD COLUMN transfer_id TEXT`).catch(() => {});
    await db.execute(`ALTER TABLE transactions ADD COLUMN transfer_role TEXT`).catch(() => {});
    await db.execute(`ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await db.execute(`ALTER TABLE transactions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_transactions_transfer_id ON transactions(telegram_id, transfer_id)`);
    await db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_transfer_pair ON transactions(transfer_id, transfer_role) WHERE transfer_id IS NOT NULL`);
    await db.execute({ sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '3') ON CONFLICT(key) DO UPDATE SET value = '3'`, args: [] });
    schemaVersion = 3;
  }

  if (schemaVersion < 4) {
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS sol_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, label TEXT NOT NULL, address TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, last_balance_lamports TEXT, last_checked_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(telegram_id, address))`, args: [] },
      { sql: `CREATE TABLE IF NOT EXISTS sol_wallet_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, wallet_id INTEGER NOT NULL, snapshot_date TEXT NOT NULL, lamports TEXT NOT NULL, captured_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(wallet_id, snapshot_date))`, args: [] },
      { sql: `CREATE INDEX IF NOT EXISTS idx_sol_wallets_active ON sol_wallets(is_active, telegram_id)`, args: [] },
      { sql: `CREATE INDEX IF NOT EXISTS idx_sol_snapshots_date ON sol_wallet_snapshots(wallet_id, snapshot_date DESC)`, args: [] },
      { sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '4') ON CONFLICT(key) DO UPDATE SET value = '4'`, args: [] },
    ], "write");
    schemaVersion = 4;
  }

  if (schemaVersion < 5) {
    await db.batch([
      { sql: `CREATE TABLE IF NOT EXISTS eth_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, label TEXT NOT NULL, address TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, last_balance_wei TEXT, last_checked_at TEXT, last_error TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(telegram_id, address))`, args: [] },
      { sql: `CREATE INDEX IF NOT EXISTS idx_eth_wallets_active ON eth_wallets(is_active, telegram_id)`, args: [] },
      { sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '5') ON CONFLICT(key) DO UPDATE SET value = '5'`, args: [] },
    ], "write");
    schemaVersion = 5;
  }

  if (schemaVersion < 6) {
    await db.execute(`DELETE FROM transactions WHERE is_balance_correction = 1 OR category = '⚙️ Koreksi'`);
    await db.execute({ sql: `INSERT INTO schema_meta (key, value) VALUES ('version', '6') ON CONFLICT(key) DO UPDATE SET value = '6'`, args: [] });
    schemaVersion = 6;
  }

  // Session cleanup (after both phases complete)
  // Fire and forget — tidak blocking initDB()
  db.execute(`
  DELETE FROM sessions 
  WHERE updated_at < datetime('now', '-1 hours', 'localtime')
`).catch(e => console.error("Session cleanup error:", e));

  _dbReady = true;
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
export async function addTransaction(telegramId, accountId, type, amount, note, category = 'Lainnya', source = '', operationId = null) {
  const delta = type === "masuk" ? amount : -amount;
  const results = await db.batch([
    {
      sql: `INSERT OR IGNORE INTO transactions
            (telegram_id, account_id, type, amount, note, category, source, operation_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      args: [String(telegramId), accountId, type, amount, note || "", category, source, operationId],
    },
    {
      sql: `UPDATE accounts SET balance = balance + ?
            WHERE id = ? AND telegram_id = ? AND changes() > 0`,
      args: [delta, accountId, String(telegramId)],
    },
  ], "write");
  return results[0].rowsAffected > 0;
}

export async function addSolWallet(telegramId, label, address) {
  const result = await db.execute({ sql: `INSERT INTO sol_wallets (telegram_id, label, address) VALUES (?, ?, ?)`, args: [String(telegramId), label, address] });
  return Number(result.lastInsertRowid);
}

export async function getSolWallets(telegramId) {
  const result = await db.execute({ sql: `SELECT * FROM sol_wallets WHERE telegram_id = ? AND is_active = 1 ORDER BY created_at ASC`, args: [String(telegramId)] });
  return result.rows;
}

export async function getSolWalletById(walletId, telegramId) {
  const result = await db.execute({ sql: `SELECT * FROM sol_wallets WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [walletId, String(telegramId)] });
  return result.rows[0] || null;
}

export async function getActiveSolWallets() {
  const result = await db.execute(`SELECT * FROM sol_wallets WHERE is_active = 1 ORDER BY id ASC`);
  return result.rows;
}

export async function updateSolWalletBalance(walletId, lamports) {
  await db.execute({ sql: `UPDATE sol_wallets SET last_balance_lamports = ?, last_checked_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?`, args: [String(lamports), walletId] });
}

export async function setSolWalletError(walletId, message) {
  await db.execute({ sql: `UPDATE sol_wallets SET last_error = ?, updated_at = datetime('now') WHERE id = ?`, args: [String(message).slice(0, 200), walletId] });
}

export async function insertSolSnapshot(walletId, date, lamports) {
  const result = await db.execute({ sql: `INSERT OR IGNORE INTO sol_wallet_snapshots (wallet_id, snapshot_date, lamports) VALUES (?, ?, ?)`, args: [walletId, date, String(lamports)] });
  return result.rowsAffected > 0;
}

export async function renameSolWallet(walletId, telegramId, label) {
  const result = await db.execute({ sql: `UPDATE sol_wallets SET label = ?, updated_at = datetime('now') WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [label, walletId, String(telegramId)] });
  return result.rowsAffected > 0;
}

export async function replaceSolWalletAddress(walletId, telegramId, address) {
  const result = await db.batch([
    { sql: `UPDATE sol_wallets SET address = ?, last_balance_lamports = NULL, last_checked_at = NULL, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [address, walletId, String(telegramId)] },
    { sql: `DELETE FROM sol_wallet_snapshots WHERE wallet_id = ? AND EXISTS (SELECT 1 FROM sol_wallets WHERE id = ? AND telegram_id = ? AND is_active = 1)`, args: [walletId, walletId, String(telegramId)] },
  ], "write");
  return result[0].rowsAffected > 0;
}

export async function deleteSolWallet(walletId, telegramId) {
  await db.batch([
    { sql: `DELETE FROM sol_wallet_snapshots WHERE wallet_id = ?`, args: [walletId] },
    { sql: `UPDATE sol_wallets SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND telegram_id = ?`, args: [walletId, String(telegramId)] },
  ], "write");
}

export async function addEthWallet(telegramId, label, address) {
  const result = await db.execute({ sql: `INSERT INTO eth_wallets (telegram_id, label, address) VALUES (?, ?, ?)`, args: [String(telegramId), label, address] });
  return Number(result.lastInsertRowid);
}

export async function getEthWallets(telegramId) {
  const result = await db.execute({ sql: `SELECT * FROM eth_wallets WHERE telegram_id = ? AND is_active = 1 ORDER BY created_at ASC`, args: [String(telegramId)] });
  return result.rows;
}

export async function getEthWalletById(walletId, telegramId) {
  const result = await db.execute({ sql: `SELECT * FROM eth_wallets WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [walletId, String(telegramId)] });
  return result.rows[0] || null;
}

export async function getActiveEthWallets() {
  const result = await db.execute(`SELECT * FROM eth_wallets WHERE is_active = 1 ORDER BY id ASC`);
  return result.rows;
}

export async function updateEthWalletBalance(walletId, wei) {
  await db.execute({ sql: `UPDATE eth_wallets SET last_balance_wei = ?, last_checked_at = datetime('now'), last_error = NULL, updated_at = datetime('now') WHERE id = ?`, args: [String(wei), walletId] });
}

export async function setEthWalletError(walletId, message) {
  await db.execute({ sql: `UPDATE eth_wallets SET last_error = ?, updated_at = datetime('now') WHERE id = ?`, args: [String(message).slice(0, 200), walletId] });
}

export async function renameEthWallet(walletId, telegramId, label) {
  const result = await db.execute({ sql: `UPDATE eth_wallets SET label = ?, updated_at = datetime('now') WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [label, walletId, String(telegramId)] });
  return result.rowsAffected > 0;
}

export async function replaceEthWalletAddress(walletId, telegramId, address) {
  const result = await db.execute({ sql: `UPDATE eth_wallets SET address = ?, last_balance_wei = NULL, last_checked_at = NULL, last_error = NULL, updated_at = datetime('now') WHERE id = ? AND telegram_id = ? AND is_active = 1`, args: [address, walletId, String(telegramId)] });
  return result.rowsAffected > 0;
}

export async function deleteEthWallet(walletId, telegramId) {
  await db.execute({ sql: `UPDATE eth_wallets SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND telegram_id = ?`, args: [walletId, String(telegramId)] });
}

export async function addTransactions(telegramId, accountId, transactions, operationId) {
  if (transactions.length === 0) return false;

  const statements = [];
  for (const [index, tx] of transactions.entries()) {
    const itemOperationId = `${operationId}-${index}`;
    const delta = tx.type === "masuk" ? tx.amount : -tx.amount;
    statements.push(
      {
        sql: `INSERT OR IGNORE INTO transactions
              (telegram_id, account_id, type, amount, note, category, source, operation_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        args: [String(telegramId), accountId, tx.type, tx.amount, tx.note || "", tx.category, tx.source, itemOperationId],
      },
      {
        sql: `UPDATE accounts SET balance = balance + ?
              WHERE id = ? AND telegram_id = ? AND changes() > 0`,
        args: [delta, accountId, String(telegramId)],
      }
    );
  }
  const results = await db.batch(statements, "write");
  return results.some((result, index) => index % 2 === 0 && result.rowsAffected > 0);
}

// ── CORRECTION RECORD ─────────────────────────────────────────
export async function correctAccountBalance(telegramId, accountId, newBalance) {
  const result = await db.execute({
    sql: `UPDATE accounts SET balance = ? WHERE id = ? AND telegram_id = ?`,
    args: [newBalance, accountId, String(telegramId)],
  });
  return result.rowsAffected > 0;
}

export async function getRecentTransactions(telegramId, limit = 10, offset = 0, days = null) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit) || 10));
  const safeOffset = Math.max(0, parseInt(offset) || 0);
  const safeDays = days === null ? null : Math.max(1, Math.min(365, parseInt(days) || 30));
  const result = await db.execute({
    sql: `SELECT t.*, a.bank_name
          FROM transactions t
          JOIN accounts a ON t.account_id = a.id
          WHERE t.telegram_id = ?
          AND t.is_balance_correction = 0 AND t.category != '⚙️ Koreksi'
          AND (? IS NULL OR date(t.created_at, '+7 hours') >= date('now', '+7 hours', '-' || CAST(? - 1 AS TEXT) || ' days'))
          ORDER BY t.created_at DESC
          LIMIT ? OFFSET ?`,
    args: [String(telegramId), safeDays, safeDays, safeLimit, safeOffset],
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
  // Pastikan row ada (tidak error kalau sudah ada)
  await db.execute({
    sql: `INSERT OR IGNORE INTO user_settings (telegram_id, daily_limit) VALUES (?, 0)`,
    args: [String(telegramId)],
  });
  const result = await db.execute({
    sql: `SELECT * FROM user_settings WHERE telegram_id = ?`,
    args: [String(telegramId)],
  });
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
           WHERE telegram_id = ? AND type = 'keluar' AND is_balance_correction = 0 AND is_transfer = 0
           AND date(created_at, '+7 hours') = date('now', '+7 hours')`,
    args: [String(telegramId)],
  });
  return result.rows[0].total || 0;
}

export async function getWeeklySpend(telegramId, offsetWeeks = 0) {
  const modifier = `-${offsetWeeks * 7} days`;
  const result = await db.execute({
    sql: `SELECT SUM(amount) as total FROM transactions 
           WHERE telegram_id = ? AND type = 'keluar' AND is_balance_correction = 0 AND is_transfer = 0
           AND strftime('%Y-%W', created_at, '+7 hours') =
               strftime('%Y-%W', date('now', ?, '+7 hours'))`,
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
           WHERE telegram_id = ? AND type = ? AND is_balance_correction = 0 AND is_transfer = 0
           AND created_at >= datetime('now', '-' || CAST(? AS TEXT) || ' days')
          ORDER BY created_at DESC`,
    args: [String(telegramId), type, safeDays],
  });
  return result.rows;
}

export async function getTransactionsByDayGrouped(telegramId, days = 30) {
  const safeDays = Math.max(1, Math.min(365, parseInt(days) || 30));
  const result = await db.execute({
    sql: `SELECT date(created_at, '+7 hours') as tx_date, SUM(amount) as daily_total
          FROM transactions 
           WHERE telegram_id = ? AND type = 'keluar' AND is_balance_correction = 0 AND is_transfer = 0
           AND created_at >= datetime('now', '-' || CAST(? AS TEXT) || ' days')
           GROUP BY date(created_at, '+7 hours')
          ORDER BY tx_date ASC`,
    args: [String(telegramId), safeDays],
  });
  return result.rows;
}

export async function getTransactionsForCurrentMonth(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
           WHERE telegram_id = ? AND is_balance_correction = 0 AND is_transfer = 0
     AND strftime('%Y-%m', created_at, '+7 hours') = strftime('%Y-%m', 'now', '+7 hours')
          ORDER BY created_at DESC`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function getTransactionById(transactionId, telegramId) {
  const result = await db.execute({
    sql: `SELECT t.*, a.bank_name FROM transactions t JOIN accounts a ON a.id = t.account_id
          WHERE t.id = ? AND t.telegram_id = ?`, args: [transactionId, String(telegramId)],
  });
  return result.rows[0] || null;
}

export async function createTransfer(telegramId, fromAccountId, toAccountId, amount, note, transferId) {
  if (fromAccountId === toAccountId) throw new Error("Transfer accounts must differ");
  const userId = String(telegramId);
  const results = await db.batch([
    { sql: `INSERT OR IGNORE INTO transactions (telegram_id, account_id, type, amount, note, category, source, operation_id, transfer_id, transfer_role, is_transfer, created_at)
      SELECT ?, ?, 'keluar', ?, ?, '↔️ Transfer', '', ?, ?, 'out', 1, datetime('now')
      WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND telegram_id = ?) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND telegram_id = ?)`,
      args: [userId, fromAccountId, amount, note || '', `${transferId}:out`, transferId, fromAccountId, userId, toAccountId, userId] },
    { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ? AND telegram_id = ? AND changes() > 0`, args: [amount, fromAccountId, userId] },
    { sql: `INSERT OR IGNORE INTO transactions (telegram_id, account_id, type, amount, note, category, source, operation_id, transfer_id, transfer_role, is_transfer, created_at)
      SELECT ?, ?, 'masuk', ?, ?, '↔️ Transfer', '↔️ Transfer', ?, ?, 'in', 1, datetime('now')
      WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND telegram_id = ?) AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND telegram_id = ?)`,
      args: [userId, toAccountId, amount, note || '', `${transferId}:in`, transferId, fromAccountId, userId, toAccountId, userId] },
    { sql: `UPDATE accounts SET balance = balance + ? WHERE id = ? AND telegram_id = ? AND changes() > 0`, args: [amount, toAccountId, userId] },
  ], "write");
  return results[0].rowsAffected > 0 && results[2].rowsAffected > 0;
}

export async function deleteTransaction(transactionId, telegramId, revision) {
  const tx = await getTransactionById(transactionId, telegramId);
  if (!tx || tx.revision !== revision) return false;
  if (tx.is_transfer) return false;
  const delta = tx.type === 'masuk' ? -tx.amount : tx.amount;
  const results = await db.batch([
    { sql: `UPDATE accounts SET balance = balance + ? WHERE id = ? AND telegram_id = ? AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND telegram_id = ? AND revision = ? AND is_transfer = 0)`, args: [delta, tx.account_id, String(telegramId), transactionId, String(telegramId), revision] },
    { sql: `DELETE FROM transactions WHERE id = ? AND telegram_id = ? AND revision = ? AND is_transfer = 0`, args: [transactionId, String(telegramId), revision] },
  ], "write");
  return results[1].rowsAffected > 0;
}

export async function deleteTransfer(transferId, telegramId, revision) {
  const userId = String(telegramId);
  const pair = await db.execute({ sql: `SELECT * FROM transactions WHERE telegram_id = ? AND transfer_id = ? AND is_transfer = 1 ORDER BY transfer_role`, args: [userId, transferId] });
  if (pair.rows.length !== 2 || pair.rows.some((tx) => tx.revision !== revision)) return false;
  const outgoing = pair.rows.find((tx) => tx.transfer_role === 'out');
  const incoming = pair.rows.find((tx) => tx.transfer_role === 'in');
  if (!outgoing || !incoming) return false;
  const results = await db.batch([
    { sql: `UPDATE accounts SET balance = balance + ? WHERE id = ? AND telegram_id = ?`, args: [outgoing.amount, outgoing.account_id, userId] },
    { sql: `UPDATE accounts SET balance = balance - ? WHERE id = ? AND telegram_id = ?`, args: [incoming.amount, incoming.account_id, userId] },
    { sql: `DELETE FROM transactions WHERE telegram_id = ? AND transfer_id = ? AND is_transfer = 1 AND revision = ?`, args: [userId, transferId, revision] },
  ], "write");
  return results[2].rowsAffected === 2;
}

export async function updateTransactionNote(transactionId, telegramId, revision, note) {
  const result = await db.execute({ sql: `UPDATE transactions SET note = ?, revision = revision + 1 WHERE id = ? AND telegram_id = ? AND revision = ? AND is_transfer = 0`, args: [note || '', transactionId, String(telegramId), revision] });
  return result.rowsAffected > 0;
}

export async function updateTransactionAmount(transactionId, telegramId, revision, amount) {
  const tx = await getTransactionById(transactionId, telegramId);
  if (!tx || tx.revision !== revision || tx.is_transfer) return false;
  const delta = tx.type === 'masuk' ? amount - tx.amount : tx.amount - amount;
  const results = await db.batch([
    { sql: `UPDATE accounts SET balance = balance + ? WHERE id = ? AND telegram_id = ? AND EXISTS (SELECT 1 FROM transactions WHERE id = ? AND telegram_id = ? AND revision = ? AND is_transfer = 0)`, args: [delta, tx.account_id, String(telegramId), transactionId, String(telegramId), revision] },
    { sql: `UPDATE transactions SET amount = ?, revision = revision + 1 WHERE id = ? AND telegram_id = ? AND revision = ? AND is_transfer = 0`, args: [amount, transactionId, String(telegramId), revision] },
  ], "write");
  return results[1].rowsAffected > 0;
}

export async function getTransactionsForMonth(telegramId, yearMonth) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(yearMonth)) {
    throw new Error("Invalid export month");
  }

  const result = await db.execute({
    sql: `SELECT t.*, a.bank_name
          FROM transactions t
          JOIN accounts a ON t.account_id = a.id
          WHERE t.telegram_id = ?
            AND strftime('%Y-%m', t.created_at, '+7 hours') = ?
          ORDER BY t.created_at ASC, t.id ASC`,
    args: [String(telegramId), yearMonth],
  });
  return result.rows;
}

export async function getTransactionsForCurrentWeek(telegramId) {
  const result = await db.execute({
    sql: `SELECT * FROM transactions 
           WHERE telegram_id = ? AND is_balance_correction = 0 AND is_transfer = 0
     AND strftime('%Y-%W', created_at, '+7 hours') = strftime('%Y-%W', 'now', '+7 hours')
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
           AND date(created_at, '+7 hours') = date('now', '+7 hours')`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export async function getLastMonthTransactions(telegramId) {
  const result = await db.execute({
    sql: `SELECT type, amount FROM transactions
          WHERE telegram_id = ?
           AND is_balance_correction = 0 AND is_transfer = 0
           AND strftime('%Y-%m', created_at, '+7 hours') =
               strftime('%Y-%m', 'now', '+7 hours', '-1 month')`,
    args: [String(telegramId)],
  });
  return result.rows;
}

export default db;
