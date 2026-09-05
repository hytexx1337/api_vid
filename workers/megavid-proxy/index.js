/**
 * workers/megavid-proxy/index.js — Worker que proxeea megavid porque el VPS
 * tiene conectividad rota con ese origen (timeouts frecuentes / ASN
 * bloqueado). Cloudflare sale por su propia red y llega sin problema.
 *
 * Rutas:
 *   GET /ani/<anilistId>/<ep>/dub/source  -> https://megavid.buzz/ani/...
 *     (API JSON; el scraper la usa como BASE cuando MEGAVID_WORKER está set)
 *   GET /sub/<path>                       -> https://megavid.buzz/sub/...
 *     (tracks de subtítulos que devuelve la API)
 *   GET /hls/<path>                       -> https://cp.megavid.buzz/hls/...
 *     (CDN de video; manda Referer megavid.buzz y, si la respuesta es un
 *     playlist m3u8, reescribe las URLs absolutas de cp.megavid.buzz para
 *     que los segmentos también salgan por el worker. Las líneas relativas
 *     quedan igual: resuelven contra el path /hls/... del worker y vuelven
 *     a caer acá.)
 *
 * Deploy:
 *   cd workers/megavid-proxy && wrangler deploy
 *   Luego setear en api_vid/.env: MEGAVID_WORKER=https://<worker>.workers.dev
 *   (o el custom domain que le pongan).
 */

const API_ORIGIN = "https://megavid.buzz";
const CDN_ORIGIN = "https://cp.megavid.buzz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

function upstreamFor(pathname) {
  if (pathname.startsWith("/hls/")) return CDN_ORIGIN;
  if (pathname.startsWith("/ani/") || pathname.startsWith("/sub/")) return API_ORIGIN;
  return null;
}

function isPlaylist(contentType, pathname) {
  return contentType.includes("mpegurl") || contentType.includes("x-mpegurl") || pathname.endsWith(".m3u8");
}

function rewritePlaylist(text, workerOrigin) {
  // Las URLs absolutas del CDN pasan por el worker; las relativas se dejan
  // (resuelven contra /hls/... del worker y vuelven a entrar por acá).
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (t.startsWith(CDN_ORIGIN)) return workerOrigin + t.slice(CDN_ORIGIN.length);
      // URI="https://cp.megavid.buzz/..." dentro de #EXT-X-KEY / #EXT-X-MAP
      return line.replaceAll(`URI="${CDN_ORIGIN}`, `URI="${workerOrigin}`);
    })
    .join("\n");
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);
    const upstream = upstreamFor(url.pathname);
    if (!upstream) return new Response("Not found", { status: 404, headers: CORS });

    const target = upstream + url.pathname + url.search;
    const isCdn = upstream === CDN_ORIGIN;

    const resp = await fetch(target, {
      headers: {
        "User-Agent": UA,
        // El CDN bloquea referers ajenos (403 a player.zenkai.live) pero
        // acepta megavid.buzz o ausente. La API también lo espera.
        "Referer": `${API_ORIGIN}/`,
        "Accept": request.headers.get("accept") || "*/*",
      },
      redirect: "follow",
    });

    const contentType = resp.headers.get("content-type") || "";

    if (isCdn && resp.ok && isPlaylist(contentType, url.pathname)) {
      const text = await resp.text();
      return new Response(rewritePlaylist(text, url.origin), {
        status: resp.status,
        headers: { ...CORS, "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" },
      });
    }

    // Passthrough: JSON de la API, segmentos, subs, etc.
    const headers = new Headers(CORS);
    headers.set("content-type", contentType || (isCdn ? "video/mp2t" : "application/octet-stream"));
    if (isCdn) headers.set("cache-control", "public, max-age=3600");
    return new Response(resp.body, { status: resp.status, headers });
  },
};
