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

// TTL del cache de edge (Cache API) para segmentos/keys ya servidos. Los
// objetos son inmutables una vez archivados (mismo key = mismos bytes para
// siempre), así que podemos cachear agresivamente. Esto SOLO evita el
// R2.get() repetido — la validación de la firma (exp/sig) sigue siendo
// obligatoria en cada request, el cache nunca la evita.
//
// Requiere que el Worker esté atado a un Custom Domain (no *.workers.dev):
// caches.default no opera en el subdominio workers.dev por defecto.
const EDGE_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 días

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
  // Pistas de audio separadas archivadas desde masters con EXT-X-MEDIA
  // (ver processPlaylist en src/lib/hls-to-r2.js): aud- = MPEG-TS,
  // audf- = fMP4/CMAF.
  if (filename.startsWith("aud-")) return "video/mp2t";
  if (filename.startsWith("audf-")) return "video/mp4";
  // Init segment y segmentos de media fMP4/CMAF (EXT-X-MAP presente en el
  // playlist original): son boxes MP4 reales. Receivers estrictos
  // (Chromecast/Shaka) usan este header para elegir el mimeType del
  // SourceBuffer al inicializar el demuxer — si se sirven como
  // application/octet-stream, se rechazan y el cast falla (en navegador con
  // hls.js no se nota porque hls.js ignora el Content-Type).
  if (filename.startsWith("init-")) return "video/mp4";
  if (filename.startsWith("fseg-")) return "video/mp4";
  if (filename.startsWith("key-")) return "application/octet-stream";
  // Subtítulos (ver src/providers/scraper-crunchyroll.js) subidos sin
  // disguise bajo el prefijo subs/ — se distinguen por extensión.
  if (filename.endsWith(".vtt")) return "text/vtt; charset=utf-8";
  if (filename.endsWith(".ass")) return "text/x-ssa; charset=utf-8";
  if (filename.endsWith(".srt")) return "application/x-subrip; charset=utf-8";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function isPublicAssetPath(key) {
  return (
    /^subs\/.+\.(vtt|ass|srt)$/i.test(key || "")
    || /^thumbs\/.+\.(vtt|webp|png|jpe?g)$/i.test(key || "")
  );
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

    // KEY/MAP/MEDIA llevan el recurso en URI="..." — MEDIA cubre las
    // playlists de audio separadas (audio-N.m3u8) de masters archivados.
    if (/^#EXT-X-(KEY|MAP|MEDIA)/i.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
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
    const key = pathname.replace(/^\/+/, "");
    const publicAsset = isPublicAssetPath(key);
    const exp = url.searchParams.get("exp");
    const sig = url.searchParams.get("sig");

    if (!publicAsset) {
      const valid = await verifySig(env.R2_SEAL_SECRET, pathname, exp, sig);
      if (!valid) return new Response("Forbidden", { status: 403 });
    }

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
    //
    // Cache key normalizada: mismo path, SIN el query string (exp/sig son
    // solo para autenticar el request actual, no deben fragmentar el cache
    // — dos URLs firmadas distintas para el mismo objeto deben pegarle a
    // la misma entrada de cache). La firma ya se validó arriba para
    // llegar hasta acá, así que el cache nunca sirve nada sin auth previa.
    const cache = caches.default;
    const cacheUrl = new URL(request.url);
    cacheUrl.search = "";
    const cacheKeyRequest = new Request(cacheUrl.toString(), {
      method: "GET",
      headers: request.headers, // preserva el Range para que Cloudflare sirva el 206 recortado
    });

    let response = await cache.match(cacheKeyRequest);
    if (!response) {
      // Miss: traer el objeto COMPLETO (sin range) para guardar una única
      // copia en cache; Cloudflare resuelve los Range requests recortando
      // esa copia automáticamente en los hits SIGUIENTES. Pero la entrada
      // recién escrita con cache.put() no está garantizada disponible para
      // un cache.match() inmediato en la MISMA request (consistencia
      // eventual del edge) — si eso pasa y el request original traía
      // Range, cache.match() devuelve null y como fallback se servía el
      // objeto ENTERO con status 200 en vez de la porción pedida con 206.
      // Un cliente que dependa del recorte exacto (Range-based buffering,
      // <video> nativo, etc.) puede corromperse con esto. Por eso, en el
      // miss, si hay Range, se recorta a mano ANTES de devolver.
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });

      const filename = key.split("/").pop();
      const size = object.size;
      const headers = new Headers();
      headers.set("content-type", contentTypeFor(filename));
      headers.set("cache-control", publicAsset
        ? "public, max-age=31536000, immutable"
        : `public, max-age=${EDGE_CACHE_TTL_SECONDS}, immutable`);
      headers.set("access-control-allow-origin", "*");
      headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(size));

      const bodyBuf = await object.arrayBuffer();
      const fullResponse = new Response(bodyBuf, { status: 200, headers });
      await cache.put(cacheKeyRequest, fullResponse.clone());

      const rangeHeader = request.headers.get("range");
      const parsedRange = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
      if (parsedRange) {
        let start = parsedRange[1] === "" ? 0 : parseInt(parsedRange[1], 10);
        let end = parsedRange[2] === "" ? size - 1 : parseInt(parsedRange[2], 10);
        if (parsedRange[1] === "" && parsedRange[2] !== "") {
          // Suffix range: "bytes=-500" -> los últimos 500 bytes.
          start = Math.max(0, size - parseInt(parsedRange[2], 10));
          end = size - 1;
        }
        end = Math.min(end, size - 1);
        if (start <= end && start < size) {
          const sliced = bodyBuf.slice(start, end + 1);
          const rangeHeaders = new Headers(headers);
          rangeHeaders.set("content-range", `bytes ${start}-${end}/${size}`);
          rangeHeaders.set("content-length", String(end - start + 1));
          return new Response(sliced, { status: 206, headers: rangeHeaders });
        }
      }

      response = fullResponse;
    }

    return response;
  },
};
