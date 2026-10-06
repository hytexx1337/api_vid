/**
 * scraper-vidup.js
 *
 * vidup.to — usa el servicio de terceros enc-dec.app para desencriptar su
 * protocolo propietario. Flujo (ver EncDecEndpoints/samples/vidup.py):
 *
 *  1. GET vidup.to/{movie|tv}/{tmdbId}[/{season}/{episode}]/ -> HTML
 *  2. Extraer token "en" o "token" embebido en el HTML (regex)
 *  3. GET enc-dec.app/api/enc-vidup?text={token}&stage=1 -> { stage1, token }
 *  4. POST {stage1} con X-CSRF-Token -> blob cifrado
 *  5. GET enc-dec.app/api/enc-vidup?text={blob}&stage=2 -> { servers, stream, token }
 *  6. POST {servers} con X-CSRF-Token -> blob cifrado
 *  7. POST enc-dec.app/api/dec-vidup {text: blob} -> lista de servers [{data,...}]
 *  8. POST {stream}/{data} -> blob cifrado
 *  9. POST enc-dec.app/api/dec-vidup {text: blob} -> { url, tracks, title, ... }
 */

const ORIGIN = "https://vidup.to";
const ENC_DEC_API = "https://enc-dec.app/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": UA,
  Referer: `${ORIGIN}/`,
  "X-Requested-With": "XMLHttpRequest",
};

// vidup.to bloquea IPs de datacenter en el GET inicial (403). Intentamos directo
// primero (funciona en local) y si devuelve 403 caemos al CF Worker si hay uno.
const CF_WORKER = (process.env.VIDUP_CF_WORKER || process.env.KAI_CF_WORKER)?.replace(/\/$/, "");

async function fetchPage(url, signal) {
  let r = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml", Referer: `${ORIGIN}/` },
    signal,
  });
  if (r.status === 403 && CF_WORKER) {
    console.log("[vidup] page direct 403, retrying via worker");
    r = await fetch(`${CF_WORKER}?url=${encodeURIComponent(url)}`, { signal });
  }
  return r;
}

// Los POST a servers/stream también se intentan directo primero; si vidup bloquea
// la IP del servidor, se reintenta vía CF Worker.
async function relayFetch(url, { method = "GET", headers = {}, signal } = {}) {
  let r = await fetch(url, { method, headers, signal });
  if (r.status === 403 && CF_WORKER) {
    const ref = headers.Referer ?? headers.referer;
    const qs = `url=${encodeURIComponent(url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
    console.log("[vidup] relay direct 403, retrying via worker");
    r = await fetch(`${CF_WORKER}?${qs}`, { method, headers, signal });
  }
  return r;
}

const FETCH_TIMEOUT = 12000;
function timeoutSignal() { return AbortSignal.timeout(FETCH_TIMEOUT); }

function validate(data, path) {
  if (data?.status !== 200) {
    throw new Error(`vidup: enc-dec ${path} status=${data?.status} error=${data?.error ?? "unknown"}`);
  }
  return data.result;
}

const CACHE_TTL = 2 * 60 * 60 * 1000; // 2h
const cache = new Map();

/**
 * @param {string|number} tmdbId
 * @param {"tv"|"movie"} mediaType
 * @param {string|number} [season]
 * @param {string|number} [episode]
 * @returns {Promise<{url:string,type:"hls",provider:"vidup",referer:string,subtitles?:Array}|null>}
 */
export async function getVidupStream(tmdbId, mediaType, season, episode) {
  const cacheKey = mediaType === "tv"
    ? `vidup:tv:${tmdbId}:${season}:${episode}`
    : `vidup:movie:${tmdbId}`;

  const hit = cache.get(cacheKey);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  try {
    const pagePath = mediaType === "tv"
      ? `/tv/${tmdbId}/${season}/${episode}/`
      : `/movie/${tmdbId}/`;

    const pageRes = await fetchPage(`${ORIGIN}${pagePath}`, timeoutSignal());
    if (!pageRes.ok) throw new Error(`vidup: page HTTP ${pageRes.status}`);
    const html = await pageRes.text();

    const match = html.match(/\\"(?:en|token)\\":\\"(.*?)\\"/);
    if (!match) throw new Error("vidup: no se encontró el token embebido en el HTML");
    const embeddedToken = match[1];

    const stage1Res = await fetch(
      `${ENC_DEC_API}/enc-vidup?text=${encodeURIComponent(embeddedToken)}&stage=1`,
      { signal: timeoutSignal() }
    );
    const stage1Parts = validate(await stage1Res.json(), "enc-vidup stage=1");
    const stage1Headers = { ...BASE_HEADERS, "X-CSRF-Token": stage1Parts.token ?? "" };

    const stage1RelayRes = await relayFetch(stage1Parts.stage1, {
      method: "POST",
      headers: stage1Headers,
      signal: timeoutSignal(),
    });
    const stage1Text = await stage1RelayRes.text();

    const stage2Res = await fetch(
      `${ENC_DEC_API}/enc-vidup?text=${encodeURIComponent(stage1Text)}&stage=2`,
      { signal: timeoutSignal() }
    );
    const stage2Parts = validate(await stage2Res.json(), "enc-vidup stage=2");
    const { servers, stream, token } = stage2Parts;

    const headersWithToken = { ...BASE_HEADERS, "X-CSRF-Token": token ?? "" };

    const serversRes = await relayFetch(servers, { method: "POST", headers: headersWithToken, signal: timeoutSignal() });
    const serversEncrypted = await serversRes.text();

    const decServersRes = await fetch(`${ENC_DEC_API}/dec-vidup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: serversEncrypted }),
      signal: timeoutSignal(),
    });
    const serversDecrypted = validate(await decServersRes.json(), "dec-vidup (servers)");
    if (!Array.isArray(serversDecrypted) || !serversDecrypted.length) {
      throw new Error("vidup: sin servers disponibles");
    }

    // "Euro" y "CineX" son los que el reproductor oficial usa como principales y
    // funcionan en el ~99% de los casos. Se disparan TODOS los servers en paralelo
    // (para no perder tiempo si hay que caer a un respaldo), pero se resuelve
    // priorizando Euro/CineX — solo si ambos fallan se usa el que responda del resto
    // (que ya están en curso, sin esperar de más).
    const PRIORITY_NAMES = new Set(["Euro", "CineX"]);
    const priorityServers = serversDecrypted.filter(s => PRIORITY_NAMES.has(s.name));
    const restServers = serversDecrypted.filter(s => !PRIORITY_NAMES.has(s.name));

    const attemptServer = async (server) => {
      const streamUrl = `${stream}/${server.data}`;
      const streamRes = await relayFetch(streamUrl, { method: "POST", headers: headersWithToken, signal: timeoutSignal() });
      const streamEncrypted = await streamRes.text();
      const decStreamRes = await fetch(`${ENC_DEC_API}/dec-vidup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: streamEncrypted }),
        signal: timeoutSignal(),
      });
      const decrypted = validate(await decStreamRes.json(), "dec-vidup (stream)");
      if (!decrypted?.url) throw new Error("vidup: sin url en stream decodificado");
      return { decrypted, server };
    };

    // Lanzar TODO en paralelo desde ya (rest ya está "corriendo" mientras esperamos priority)
    const restAttempts = restServers.map(s => attemptServer(s).catch(e => { throw Object.assign(e, { server: s }); }));
    const priorityAttempts = priorityServers.map(s => attemptServer(s).catch(e => { throw Object.assign(e, { server: s }); }));
    // Si el grupo priority gana primero, las de "rest" (o viceversa) pueden rechazar
    // más tarde sin que nadie las esté esperando — evitar unhandled rejection crash.
    [...restAttempts, ...priorityAttempts].forEach(p => p.catch(() => {}));

    let winner = null;
    let lastErr = null;
    if (priorityAttempts.length) {
      try {
        winner = await Promise.any(priorityAttempts);
      } catch (aggErr) {
        lastErr = aggErr.errors?.[aggErr.errors.length - 1] ?? aggErr;
        for (const e of aggErr.errors ?? []) console.warn(`[vidup] server "${e.server?.name ?? "?"}" ✗: ${e.message}`);
      }
    }
    if (!winner && restAttempts.length) {
      try {
        winner = await Promise.any(restAttempts);
      } catch (aggErr) {
        lastErr = aggErr.errors?.[aggErr.errors.length - 1] ?? aggErr;
        for (const e of aggErr.errors ?? []) console.warn(`[vidup] server "${e.server?.name ?? "?"}" ✗: ${e.message}`);
      }
    }
    if (!winner) throw lastErr ?? new Error("vidup: ningún server resolvió");

    const { decrypted, server: winningServer } = winner;
    const usedServer = winningServer.name ?? null;

    const subtitles = Array.isArray(decrypted.tracks)
      ? decrypted.tracks.map(t => ({ label: t.label, url: t.file }))
      : [];

    const streamType = /\.mpd(\?|$)/i.test(decrypted.url)
      ? "dash"
      : /\.mp4(\?|$)/i.test(decrypted.url)
        ? "mp4"
        : "hls";

    const result = {
      url: decrypted.url,
      type: streamType,
      provider: "vidup",
      referer: `${ORIGIN}/`,
      ...(usedServer && { server: usedServer }),
      ...(subtitles.length && { subtitles }),
    };

    cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.warn(`[vidup] error para ${cacheKey}:`, err.message);
    cache.set(cacheKey, { data: null, expiresAt: Date.now() + 5 * 60 * 1000 });
    return null;
  }
}
