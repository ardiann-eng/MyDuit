const RPC_URL = process.env.ETH_RPC_URL || "https://cloudflare-eth.com";

export function isValidEthereumAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

export function formatEth(wei) {
  const value = BigInt(wei || 0);
  const whole = value / 1_000_000_000_000_000_000n;
  const fraction = (value % 1_000_000_000_000_000_000n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ETH`;
}

export function shortenEthAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function getNativeEthBalances(addresses) {
  if (!addresses.length) return [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(addresses.map((address, id) => ({
        jsonrpc: "2.0", id, method: "eth_getBalance", params: [address, "latest"],
      }))),
    });
    if (!response.ok) throw new Error(`Ethereum RPC HTTP ${response.status}`);
    const body = await response.json();
    const results = Array.isArray(body) ? body : [body];
    return addresses.map((_, index) => {
      const result = results.find((item) => item.id === index);
      if (result?.error || typeof result?.result !== "string") throw new Error("Ethereum RPC response invalid");
      return BigInt(result.result);
    });
  } finally {
    clearTimeout(timeout);
  }
}
