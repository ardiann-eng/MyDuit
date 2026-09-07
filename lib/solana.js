const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function isValidSolanaAddress(address) {
  const value = String(address || "").trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let bytes = [0];
  let leadingZeroes = 0;
  for (const char of value) {
    if (char !== "1") break;
    leadingZeroes++;
  }
  for (const char of value) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return false;
    let carry = digit;
    for (let index = 0; index < bytes.length; index++) {
      const total = bytes[index] * 58 + carry;
      bytes[index] = total & 255;
      carry = total >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 255);
      carry >>= 8;
    }
  }
  for (let index = 1; index < leadingZeroes; index++) bytes.push(0);
  return bytes.length === 32;
}

export function formatSol(lamports) {
  const value = BigInt(lamports || 0);
  const solNum = Number(value) / 1_000_000_000;
  const formatted = solNum.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 });
  return `${formatted} SOL`;
}

export function shortenSolAddress(address) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export async function getNativeSolBalances(addresses) {
  if (!addresses.length) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: "myduit-sol", method: "getMultipleAccounts", params: [addresses, { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }] }),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || !Array.isArray(body.result?.value)) throw new Error("Solana RPC response invalid");
    return body.result.value.map((account) => BigInt(account?.lamports || 0));
  } finally {
    clearTimeout(timeout);
  }
}
