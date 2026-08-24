/**
 * workers/r2-cdn/index.js — Worker que sirve el bucket R2 PRIVADO donde se
 * archivan los streams (ver scripts/r2-select.js), validando un token HMAC
 * generado on-demand por la API (src/lib/r2-seal.js). Sin token válido y no
 * vencido -> 403. El bucket nunca se expone directo a internet.
 *
 * Deploy:
 *   1. Reemplazar bucket_name en wrangler.toml
 *   2. wrangler secret put R2_SEAL_SECRET   (mismo valor que en api_vid/.env)
 *   3. wrangler deploy
 *
 * Flujo:
 *   - GET /<slug>/master.m3u8?exp=..&sig=..  -> valida, lee el playlist de R2,
 *     reescribe cada línea de segmento/key (que están guardadas como nombres
 *     relativos) agregándoles su propia firma de corta duración, devuelve el
 *     playlist final.
 *   - GET /<slug>/seg-00001.jpg?exp=..&sig=.. -> valida esa firma puntual y
 *     devuelve los bytes crudos del objeto con el Content-Type real
 *     (video/mp2t), no el "image/jpeg" camuflado con el que se subió.
 */

// TTL de las firmas que el Worker genera para cada línea del playlist. Puede
// ser más corto que el TTL del master.m3u8 (24h, definido en r2-seal.js del
// lado de la API) porque el cliente HLS consume los segmentos casi
// inmediatamente después de pedir el playlist.
const SEGMENT_TTL_SECONDS = 21600; // 6h

function toBase64Url(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySig(secret, path, exp, sig) {
  if (!exp || !sig) return false;
  if (Math.floor(Date.now() / 1000) > Number(exp)) return false;
  const expected = await hmacSign(secret, `${path}:${exp}`);
  return safeEqual(expected, String(sig));
}

function contentTypeFor(filename) {
  if (filename.startsWith("seg-")) return "video/mp2t";
  if (filename.startsWith("key-")) return "application/octet-stream";
  return "application/octet-stream";
}

async function signSegmentLine(secret, dirPrefix, filename) {
  const objectPath = `/${dirPrefix}/${filename}`;
  const exp = Math.floor(Date.now() / 1000) + SEGMENT_TTL_SECONDS;
  const sig = await hmacSign(secret, `${objectPath}:${exp}`);
  return `${filename}?exp=${exp}&sig=${sig}`;
}

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

export default {
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
          "access-control-allow-origin": "*",
        },
      });
    }

    // Segmento o AES key: devolver bytes crudos con el Content-Type real
    // (no el camuflado con el que se subió a R2).
    const rangeHeader = request.headers.get("range");
    const object = await env.BUCKET.get(key, rangeHeader ? { range: request.headers } : undefined);
    if (!object) return new Response("Not found", { status: 404 });

    const filename = key.split("/").pop();
    const headers = new Headers();
    headers.set("content-type", contentTypeFor(filename));
    headers.set("cache-control", "public, max-age=21600, immutable");
    headers.set("access-control-allow-origin", "*");
    if (object.range) {
      headers.set("content-range", `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
      headers.set("content-length", String(object.range.length));
    }

    return new Response(object.body, {
      status: object.range ? 206 : 200,
      headers,
    });
  },
};
