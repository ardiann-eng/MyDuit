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
  const results = [];
  for (const address of addresses) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"],
        }),
      });
      if (!response.ok) throw new Error(`Ethereum RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error || typeof body.result !== "string") throw new Error(body.error?.message || "Ethereum RPC response invalid");
      results.push(BigInt(body.result));
    } finally {
      clearTimeout(timeout);
    }
  }
  return results;
}
