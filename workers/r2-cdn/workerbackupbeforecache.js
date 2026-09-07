var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
var SEGMENT_TTL_SECONDS = 21600;
var EDGE_CACHE_TTL_SECONDS = 6 * 60 * 60;
function toBase64Url(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(toBase64Url, "toBase64Url");
async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(sigBuf);
}
__name(hmacSign, "hmacSign");
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
__name(safeEqual, "safeEqual");
async function verifySig(secret, path, exp, sig) {
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1e3) > Number(exp)) return false;
  const expected = await hmacSign(secret, `${path}:${exp}`);
  return safeEqual(expected, String(sig));
}
__name(verifySig, "verifySig");
function contentTypeFor(filename) {
  if (filename.startsWith("seg-")) return "video/mp2t";
  if (filename.startsWith("init-")) return "video/mp4";
  if (filename.startsWith("fseg-")) return "video/mp4";
  if (filename.startsWith("key-")) return "application/octet-stream";
  return "application/octet-stream";
}
__name(contentTypeFor, "contentTypeFor");
async function signSegmentLine(secret, dirPrefix, filename) {
  const objectPath = `/${dirPrefix}/${filename}`;
  const exp = Math.floor(Date.now() / 1e3) + SEGMENT_TTL_SECONDS;
  const sig = await hmacSign(secret, `${objectPath}:${exp}`);
  return `${filename}?exp=${exp}&sig=${sig}`;
}
__name(signSegmentLine, "signSegmentLine");
async function rewritePlaylist(text, dirPrefix, secret) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (/^#EXT-X-(KEY|MAP)/i.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
      const filename = trimmed.match(/URI="([^"]+)"/)[1];
      if (!filename.includes("://")) {
        const signed = await signSegmentLine(secret, dirPrefix, filename);
        out.push(rawLine.replace(/URI="([^"]+)"/, `URI="${signed}"`));
        continue;
      }
    }
    if (!trimmed.startsWith("#") && trimmed) {
      if (!trimmed.includes("://")) {
        out.push(await signSegmentLine(secret, dirPrefix, trimmed));
        continue;
      }
    }
    out.push(rawLine);
  }
  return out.join("\n");
}
__name(rewritePlaylist, "rewritePlaylist");
var index_default = {
  async fetch(request, env) {
    if (!env.R2_SEAL_SECRET) {
      return new Response("Worker misconfigured: falta R2_SEAL_SECRET", { status: 500 });
    }
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");
    const valid = await verifySig(env.R2_SEAL_SECRET, pathname, exp, sig);
    if (!valid) return new Response("Forbidden", { status: 403 });
    const key = pathname.replace(/^\/+/, "");
    if (!key) return new Response("Not found", { status: 404 });
    if (key.endsWith(".m3u8")) {
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const text = await object.text();
      const dirPrefix = key.split("/").slice(0, -1).join("/");
      const rewritten = await rewritePlaylist(text, dirPrefix, env.R2_SEAL_SECRET);
      return new Response(rewritten, {
        headers: {
          "content-type": "application/vnd.apple.mpegurl",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }
    const cache = caches.default;
    const cacheUrl = new URL(request.url);
    cacheUrl.search = "";
    const cacheKeyRequest = new Request(cacheUrl.toString(), {
      method: "GET"
    });
    let response = await cache.match(cacheKeyRequest);
    if (!response) {
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const filename = key.split("/").pop();
      const headers = new Headers();
      headers.set("content-type", contentTypeFor(filename));
      headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
      headers.set("access-control-allow-origin", "*");
      headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(object.size));
      const fullResponse = new Response(object.body, { status: 200, headers });
      await cache.put(cacheKeyRequest, fullResponse.clone());
      response = await cache.match(cacheKeyRequest) || fullResponse;
    }
    return response;
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
