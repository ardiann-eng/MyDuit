import assert from "node:assert/strict";
import { test } from "node:test";

test("uses Coinbase spot prices for both currencies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pair = url.match(/prices\/(.*)\/spot/)?.[1];
    assert.ok(pair, `Unexpected URL: ${url}`);
    return { ok: true, json: async () => ({ data: { amount: {
      "SOL-USD": "100", "SOL-IDR": "1600000", "ETH-USD": "2000", "ETH-IDR": "32000000",
    }[pair] } }) };
  };
  try {
    const { getCryptoPrices } = await import("../lib/crypto-prices.js?coinbase-test");
    assert.deepEqual(await getCryptoPrices(), { usd: 100, idr: 1600000, ethUsd: 2000, ethIdr: 32000000 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps available prices when one Coinbase pair and CoinGecko fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes("coingecko") || url.includes("SOL-IDR")) return { ok: false, status: 403 };
    return { ok: true, json: async () => ({ data: { amount: "100" } }) };
  };
  try {
    const { getCryptoPrices } = await import("../lib/crypto-prices.js?partial-test");
    assert.deepEqual(await getCryptoPrices(), { usd: 100, idr: null, ethUsd: 100, ethIdr: 100 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
