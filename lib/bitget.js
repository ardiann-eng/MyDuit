import { createHmac } from "node:crypto";

const ACCOUNT_PATH = "/api/v3/account/assets";

export function isBitgetOwner(telegramId, chatType = "private") {
  return chatType === "private" && Boolean(process.env.BITGET_TELEGRAM_ID) &&
    String(telegramId) === process.env.BITGET_TELEGRAM_ID;
}

export function hasBitgetCredentials() {
  return Boolean(process.env.BITGET_API_KEY && process.env.BITGET_API_SECRET && process.env.BITGET_API_PASSPHRASE);
}

export async function getBitgetUnifiedAssets() {
  if (!hasBitgetCredentials()) throw new Error("Bitget API credentials belum dikonfigurasi");
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", process.env.BITGET_API_SECRET)
    .update(`${timestamp}GET${ACCOUNT_PATH}`)
    .digest("base64");
  const response = await fetch(`https://api.bitget.com${ACCOUNT_PATH}`, {
    signal: AbortSignal.timeout(8000),
    headers: {
      "ACCESS-KEY": process.env.BITGET_API_KEY,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": process.env.BITGET_API_PASSPHRASE,
      "Content-Type": "application/json",
      locale: "en-US",
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.code !== "00000") {
    const code = typeof body?.code === "string" && /^\d{3,6}$/.test(body.code)
      ? ` API ${body.code}` : "";
    throw new Error(`Bitget HTTP ${response.status}${code}`);
  }
  const equityUsd = Number(body.data?.accountEquity);
  if (!Number.isFinite(equityUsd) || !Array.isArray(body.data?.assets)) {
    throw new Error("Respons saldo Bitget tidak valid");
  }
  const assets = body.data.assets.map(asset => ({
    coin: String(asset.coin || ""),
    balance: String(asset.balance || "0"),
    usdValue: Number(asset.usdValue),
  })).filter(asset => /^[A-Za-z0-9]{2,20}$/.test(asset.coin) && Number.isFinite(asset.usdValue));
  return { equityUsd, assets };
}

export async function getUsdIdrRate() {
  const response = await fetch("https://api.coinbase.com/v2/exchange-rates?currency=USD", {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`USD/IDR HTTP ${response.status}`);
  const body = await response.json();
  const rate = Number(body?.data?.rates?.IDR);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("Kurs USD/IDR tidak valid");
  return rate;
}
