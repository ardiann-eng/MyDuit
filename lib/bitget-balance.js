import { getBitgetUnifiedAssets, getUsdIdrRate } from "./bitget.js";
import { getBitgetBalance, saveBitgetBalance, setBitgetBalanceError } from "./db.js";

export async function syncBitgetBalance(telegramId) {
  try {
    const { equityUsd, assets } = await getBitgetUnifiedAssets();
    let equityIdr = null;
    try {
      equityIdr = equityUsd * await getUsdIdrRate();
    } catch (error) {
      console.warn("Bitget USD/IDR unavailable:", error.message);
    }
    await saveBitgetBalance(telegramId, equityUsd, equityIdr, assets);
  } catch (error) {
    console.warn("Bitget balance sync failed:", error.message);
    await setBitgetBalanceError(telegramId, error.message);
  }
  return getBitgetBalance(telegramId);
}
