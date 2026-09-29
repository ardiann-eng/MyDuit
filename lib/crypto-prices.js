let priceCache = { value: null, expiresAt: 0 };

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Price HTTP ${response.status}`);
  return response.json();
}

function validPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export async function getCryptoPrices() {
  if (priceCache.expiresAt > Date.now()) return priceCache.value;

  const pairs = ["SOL-USD", "SOL-IDR", "ETH-USD", "ETH-IDR"];
  const results = await Promise.allSettled(pairs.map(pair =>
    fetchJson(`https://api.coinbase.com/v2/prices/${pair}/spot`)
  ));
  const values = results.map(result => result.status === "fulfilled" ? validPrice(result.value?.data?.amount) : null);
  const prices = { usd: values[0], idr: values[1], ethUsd: values[2], ethIdr: values[3] };

  if (!prices.usd || !prices.idr || !prices.ethUsd || !prices.ethIdr) {
    try {
      const body = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=solana,ethereum&vs_currencies=usd,idr");
      prices.usd ??= validPrice(body?.solana?.usd);
      prices.idr ??= validPrice(body?.solana?.idr);
      prices.ethUsd ??= validPrice(body?.ethereum?.usd);
      prices.ethIdr ??= validPrice(body?.ethereum?.idr);
    } catch (error) {
      console.warn("Crypto price fallback unavailable:", error.message);
    }
  }

  const available = Object.values(prices).some(Boolean) ? prices : null;
  priceCache = { value: available, expiresAt: Date.now() + (available ? 5 : 1) * 60 * 1000 };
  return available;
}
