const cache = new Map();

export function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.value;
}

export function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function timed(label, fn) {
  const t0 = Date.now();
  return fn().then(
    (result) => {
      console.log(`[timer] ${label} OK ${Date.now() - t0}ms`);
      return result;
    },
    (e) => {
      console.warn(`[timer] ${label} ERR ${Date.now() - t0}ms — ${e.message}`);
      throw e;
    }
  );
}

// Limpia entradas expiradas cada 5 minutos para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now > entry.expiresAt) cache.delete(key);
  }
}, 5 * 60 * 1000).unref();
