/**
 * Rate limiter ligero en memoria (sliding window).
 * Para producción con múltiples workers/servidores se reemplaza por Redis.
 */

const DEFAULT_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const store = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, rec] of store) {
    rec.hits = rec.hits.filter(t => now - t < rec.windowMs);
    if (rec.hits.length === 0) store.delete(key);
  }
}

setInterval(cleanup, CLEANUP_INTERVAL_MS).unref?.();

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || req.ip || "unknown";
}

export function createRateLimiter({ windowMs = DEFAULT_WINDOW_MS, max, message = "Too many requests", keyGenerator = req => getClientIp(req), skip = () => false }) {
  return function rateLimitMiddleware(req, res, next) {
    if (skip(req)) return next();
    const key = `${keyGenerator(req)}:${windowMs}:${max}`;
    const now = Date.now();
    let rec = store.get(key);
    if (!rec) {
      rec = { windowMs, hits: [] };
      store.set(key, rec);
    }
    rec.hits = rec.hits.filter(t => now - t < windowMs);
    if (rec.hits.length >= max) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: message });
    }
    rec.hits.push(now);
    return next();
  };
}
