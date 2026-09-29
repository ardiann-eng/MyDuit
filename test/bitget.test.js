import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { getBitgetUnifiedAssets, isBitgetOwner } from "../lib/bitget.js";

test("Bitget Unified request is signed and account equity is parsed", async () => {
  const originalFetch = globalThis.fetch;
  const oldEnv = {
    key: process.env.BITGET_API_KEY,
    secret: process.env.BITGET_API_SECRET,
    passphrase: process.env.BITGET_API_PASSPHRASE,
  };
  process.env.BITGET_API_KEY = "test-key";
  process.env.BITGET_API_SECRET = "test-secret";
  process.env.BITGET_API_PASSPHRASE = "test-passphrase";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.bitget.com/api/v3/account/assets");
    assert.equal(options.headers["ACCESS-KEY"], "test-key");
    assert.equal(options.headers["ACCESS-PASSPHRASE"], "test-passphrase");
    const timestamp = options.headers["ACCESS-TIMESTAMP"];
    assert.equal(options.headers["ACCESS-SIGN"], createHmac("sha256", "test-secret")
      .update(`${timestamp}GET/api/v3/account/assets`).digest("base64"));
    return { ok: true, json: async () => ({ code: "00000", data: {
      accountEquity: "123.45", assets: [
        { coin: "USDT", balance: "100", usdValue: "100" },
        { coin: "BGB", balance: "10", usdValue: "23.45" },
      ],
    } }) };
  };
  try {
    assert.deepEqual(await getBitgetUnifiedAssets(), {
      equityUsd: 123.45,
      assets: [
        { coin: "USDT", balance: "100", usdValue: 100 },
        { coin: "BGB", balance: "10", usdValue: 23.45 },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries({
      BITGET_API_KEY: oldEnv.key, BITGET_API_SECRET: oldEnv.secret,
      BITGET_API_PASSPHRASE: oldEnv.passphrase,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Bitget balance is visible only to its owner in a private chat", () => {
  const previous = process.env.BITGET_TELEGRAM_ID;
  process.env.BITGET_TELEGRAM_ID = "123";
  try {
    assert.equal(isBitgetOwner(123, "private"), true);
    assert.equal(isBitgetOwner(123, "supergroup"), false);
    assert.equal(isBitgetOwner(456, "private"), false);
  } finally {
    if (previous === undefined) delete process.env.BITGET_TELEGRAM_ID;
    else process.env.BITGET_TELEGRAM_ID = previous;
  }
});
