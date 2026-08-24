import { listPersistedKeys, cacheGet, cacheDelete, touchVerified } from "./cache.js";
import { HEADERS } from "../config/constants.js";

// Recolecta recursivamente todas las URLs http(s) presentes en un payload de
// streams cacheado (independientemente de qué provider las generó).
function collectUrls(obj, out = []) {
  if (!obj) return out;
  if (typeof obj === "string") {
    if (/^https?:\/\//i.test(obj)) out.push(obj);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) collectUrls(v, out);
    return out;
  }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) collectUrls(obj[k], out);
    return out;
  }
  return out;
}

async function isUrlAlive(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { ...HEADERS, Range: "bytes=0-1" },
      redirect: "follow",
      signal: controller.signal,
    });
    return r.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Recorre las entradas cacheadas de anime y elimina las que ya no tienen
// ninguna URL viva, forzando un re-scrape fresco en el próximo pedido.
// No hace pruning parcial por provider: si al menos una URL sigue viva,
// deja la entrada intacta (el router ya sabe filtrar/priorizar providers).
export async function verifyAnimeCache({ maxUrlsPerEntry = 12 } = {}) {
  const keys = listPersistedKeys("streams:anime:");
  console.log(`[verifier] revisando ${keys.length} entradas de anime cacheadas`);
  let removed = 0;
  let checked = 0;

  for (const key of keys) {
    const payload = cacheGet(key);
    if (!payload) continue;

    const urls = [...new Set(collectUrls(payload))].slice(0, maxUrlsPerEntry);
    if (!urls.length) continue;

    checked++;
    const results = await Promise.all(urls.map((u) => isUrlAlive(u)));
    const aliveCount = results.filter(Boolean).length;

    if (aliveCount === 0) {
      cacheDelete(key);
      removed++;
      console.log(`[verifier] ${key} -> muerto (0/${urls.length} URLs vivas), eliminado del cache`);
    } else {
      touchVerified(key);
    }
  }

  console.log(`[verifier] listo: ${checked} revisadas, ${removed} eliminadas`);
  return { checked, removed };
}

export function scheduleAnimeVerifier({ intervalMs = 24 * 60 * 60 * 1000, initialDelayMs = 2 * 60 * 1000 } = {}) {
  setTimeout(() => {
    verifyAnimeCache().catch((e) => console.warn("[verifier] error:", e.message));
    setInterval(() => {
      verifyAnimeCache().catch((e) => console.warn("[verifier] error:", e.message));
    }, intervalMs).unref();
  }, initialDelayMs).unref();
}
