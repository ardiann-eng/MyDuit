const RPC_URLS = [
  process.env.ETH_RPC_URL,
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood-rpc.publicnode.com",
  "https://robinhood.rpc.blxrbdn.com",
].filter(Boolean);

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

async function fetchEthBalanceSingle(address) {
  let lastError = null;
  for (const rpcUrl of RPC_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_getBalance",
          params: [address, "latest"],
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (body.error || typeof body.result !== "string") {
        throw new Error(body.error?.message || "Invalid RPC response");
      }
      return BigInt(body.result);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error("All Robinhood Chain RPC endpoints failed");
}

export async function getNativeEthBalances(addresses) {
  if (!addresses.length) return [];
  const results = [];
  for (const address of addresses) {
    results.push(await fetchEthBalanceSingle(address));
  }
  return results;
}
