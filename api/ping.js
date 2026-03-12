export default async function handler(req, res) {
  // Lightweight keep-alive endpoint
  // Just enough to prevent cold start — no DB queries
  res.status(200).json({ ok: true, ts: Date.now() });
}
