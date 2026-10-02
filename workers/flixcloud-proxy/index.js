/**
 * workers/flixcloud-proxy/index.js
 *
 * Worker mínimo para relay de recursos de reanime.to + flixcloud/fetch*.flixcloud.cc
 * y para diagnosticar si una URL devuelve contenido real o challenge HTML.
 *
 * Rutas:
 *   GET /check?url=<https://...>
 *     -> JSON con status, content-type, headers útiles y preview del body.
 *   GET /fetch?url=<https://...>
 *     -> passthrough del recurso remoto con Referer/Origin de flixcloud.cc.
 *
 * Deploy:
 *   cd workers/flixcloud-proxy
 *   npx wrangler deploy
 */

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";
const REANIME_REFERER = "https://reanime.to/";
const FLIX_REFERER = "https://flixcloud.cc/";
const ALLOWED_HOST_RE = /(^|\.)((reanime\.to)|(flixcloud\.cc))$/i;
const TEXT_PREVIEW_LIMIT = 1200;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
};

function isAllowedTarget(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ALLOWED_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

function isProbablyChallenge(text, contentType) {
  const haystack = `${contentType}\n${text}`.toLowerCase();
  return (
    haystack.includes("just a moment") ||
    haystack.includes("cf-browser-verification") ||
    haystack.includes("attention required") ||
    haystack.includes("cloudflare") && haystack.includes("challenge-platform") ||
    haystack.includes("/cdn-cgi/challenge-platform/")
  );
}

function headersForTarget(target, request) {
  const parsed = new URL(target);
  const referer = ALLOWED_HOST_RE.test(parsed.hostname) && /(^|\.)reanime\.to$/i.test(parsed.hostname)
    ? REANIME_REFERER
    : FLIX_REFERER;
  return {
    "User-Agent": UA,
    "Referer": referer,
    "Origin": new URL(referer).origin,
    "Accept": request.headers.get("accept") || "*/*",
    "Accept-Language": request.headers.get("accept-language") || "es-419,es;q=0.9,en;q=0.8",
  };
}

async function fetchUpstream(target, request) {
  return fetch(target, {
    method: "GET",
    redirect: "follow",
    headers: headersForTarget(target, request),
  });
}

async function handleCheck(target, request) {
  const resp = await fetchUpstream(target, request);
  const contentType = resp.headers.get("content-type") || "";
  const raw = await resp.text();
  const preview = raw.slice(0, TEXT_PREVIEW_LIMIT);

  return Response.json({
    ok: resp.ok,
    status: resp.status,
    url: resp.url,
    contentType,
    server: resp.headers.get("server"),
    cfRay: resp.headers.get("cf-ray"),
    cacheControl: resp.headers.get("cache-control"),
    looksLikeChallenge: isProbablyChallenge(preview, contentType),
    preview,
  }, { headers: CORS });
}

async function handleFetch(target, request) {
  const resp = await fetchUpstream(target, request);
  const headers = new Headers(CORS);
  const contentType = resp.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const cacheControl = resp.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  const contentLength = resp.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);
  return new Response(resp.body, { status: resp.status, headers });
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) return new Response("Missing url param", { status: 400, headers: CORS });
    if (!isAllowedTarget(target)) return new Response("Target host not allowed", { status: 400, headers: CORS });

    if (url.pathname === "/check") return handleCheck(target, request);
    if (url.pathname === "/fetch") return handleFetch(target, request);
    return new Response("Not found", { status: 404, headers: CORS });
  },
};
