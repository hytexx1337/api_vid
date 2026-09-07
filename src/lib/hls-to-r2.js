/**
 * src/lib/hls-to-r2.js — Lógica compartida para archivar un stream HLS
 * completo (a través de nuestro proxy sellado) a Cloudflare R2.
 *
 * Usado por:
 *   - scripts/r2-select.js / scripts/r2-test.js (manual, CLI)
 *   - src/lib/r2-queue.js (automático, encolado desde /anime/:id/:episode)
 *
 * El bucket es PRIVADO: no se generan URLs públicas acá. Los objetos se
 * sirven después a través del Worker r2-cdn (ver workers/r2-cdn/index.js),
 * que valida un token HMAC firmado on-demand por la API (src/lib/r2-seal.js).
 * Por eso el playlist se reescribe con nombres de archivo RELATIVOS
 * (seg-00001.jpg, no URLs absolutas): el Worker resuelve el path completo
 * usando el prefijo (slug) + el nombre del archivo.
 *
 * Requiere en .env:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
} = process.env;

export function assertR2Env() {
  for (const [name, val] of Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME })) {
    if (!val) throw new Error(`Falta la variable de entorno ${name} en .env`);
  }
}

// Chequeo no-throw para callers que quieren R2 como mejora opcional (ej.
// subtítulos: si no está configurado, caen al disco local sin romper nada).
// Incluye R2_SEAL_SECRET/R2_WORKER_BASE porque sin eso no se puede generar
// la URL firmada para servir el objeto después de subirlo.
export function isR2Configured() {
  return !!(
    R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME &&
    process.env.R2_SEAL_SECRET && process.env.R2_WORKER_BASE
  );
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

// Camuflaje: los segmentos/keys se guardan con extensión y Content-Type de
// imagen en vez de video/mp2t. Los providers que scrapeamos ya hacen esto
// mismo (extensiones tipo .txt/.urlset en vez de .ts) para no llamar la
// atención de clasificadores automáticos de trafico de video. El player HLS
// no valida el Content-Type de los segmentos, así que esto no rompe el
// playback.
const DISGUISED_SEGMENT_EXT = ".jpg";
const DISGUISED_CONTENT_TYPE = "image/jpeg";

async function fetchBuffer(url, attempt = 1) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, ct };
  } catch (e) {
    if (attempt < 3) {
      console.warn(`  retry fetch (${attempt}/2) tras error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return fetchBuffer(url, attempt + 1);
    }
    throw e;
  }
}

export async function uploadToR2(key, buf, contentType, attempt = 1) {
  return upload(key, buf, contentType, attempt);
}

export async function objectExistsInR2(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function upload(key, buf, contentType, attempt = 1) {
  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: buf,
      ContentType: contentType || "application/octet-stream",
    }));
  } catch (e) {
    if (attempt < 3) {
      console.warn(`  retry upload ${key} (${attempt}/2) tras error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return upload(key, buf, contentType, attempt + 1);
    }
    throw e;
  }
  console.log(`  subido ${key} (${(buf.length / 1024).toFixed(1)} KB)`);
  return { bytes: buf.length };
}

function isM3U8(ct, buf) {
  if ((ct || "").toLowerCase().includes("mpegurl")) return true;
  return buf.slice(0, 7).toString("ascii") === "#EXTM3U";
}

function resolveUrl(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/**
 * Procesa una MEDIA playlist (sin variantes): sube keys, init segments (MAP)
 * y segmentos a R2 con nombres relativos y devuelve el texto reescrito.
 * tsPrefix/fmp4Prefix determinan el prefijo de los segmentos para que el
 * Worker r2-cdn sepa el Content-Type real (seg-/fseg- para video,
 * aud-/audf- para pistas de audio separadas).
 */
async function processMediaPlaylist(text, url, dirPrefix, counters, tsPrefix = "seg-", fmp4Prefix = "fseg-") {
  const lines = text.split(/\r?\n/);

  // Media playlist (ya sin variantes): procesar keys, init segments (MAP) y segmentos.
  // IMPORTANTE: EXT-X-KEY (clave AES real) y EXT-X-MAP (init segment fMP4/CMAF,
  // literalmente un box MP4) se archivan con prefijos DISTINTOS ("key-" / "init-")
  // aunque ambos usen la extensión camuflada .jpg. El Worker r2-cdn necesita
  // distinguirlos para servir Content-Type correcto (video/mp4 para el init
  // segment) — si no, Chromecast/Shaka rechaza el init MP4 servido como
  // application/octet-stream y el cast falla (en navegador con hls.js no se
  // nota porque hls.js ignora el Content-Type).
  // Si el playlist trae EXT-X-MAP, los segmentos de media son fMP4/CMAF
  // (fragmentos MP4 que referencian el init segment), no MPEG-TS. Hay que
  // archivarlos con un prefijo distinto ("fseg-") para que el Worker los
  // sirva como video/mp4 en vez de video/mp2t.
  const isFmp4 = lines.some((l) => /^#EXT-X-MAP/i.test(l.trim()));
  const segPrefix = isFmp4 ? fmp4Prefix : tsPrefix;

  const out = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (/^#EXT-X-MAP/i.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
      const uri = trimmed.match(/URI="([^"]+)"/)[1];
      const abs = resolveUrl(uri, url);
      const { buf: initBuf } = await fetchBuffer(abs);
      const filename = `init-${String(++counters.init).padStart(3, "0")}${DISGUISED_SEGMENT_EXT}`;
      const { bytes } = await upload(`${dirPrefix}/${filename}`, initBuf, DISGUISED_CONTENT_TYPE);
      counters.bytes += bytes;
      out.push(rawLine.replace(/URI="([^"]+)"/, `URI="${filename}"`));
      continue;
    }

    if (/^#EXT-X-KEY/i.test(trimmed) && /URI="([^"]+)"/.test(trimmed)) {
      const uri = trimmed.match(/URI="([^"]+)"/)[1];
      const abs = resolveUrl(uri, url);
      const { buf: keyBuf } = await fetchBuffer(abs);
      const filename = `key-${String(++counters.key).padStart(3, "0")}${DISGUISED_SEGMENT_EXT}`;
      const { bytes } = await upload(`${dirPrefix}/${filename}`, keyBuf, DISGUISED_CONTENT_TYPE);
      counters.bytes += bytes;
      // Relativo: el Worker resuelve dirPrefix + filename al validar la firma.
      out.push(rawLine.replace(/URI="([^"]+)"/, `URI="${filename}"`));
      continue;
    }

    if (!trimmed.startsWith("#") && trimmed) {
      const abs = resolveUrl(trimmed, url);
      const { buf: segBuf } = await fetchBuffer(abs);
      const filename = `${segPrefix}${String(++counters.seg).padStart(5, "0")}${DISGUISED_SEGMENT_EXT}`;
      const { bytes } = await upload(`${dirPrefix}/${filename}`, segBuf, DISGUISED_CONTENT_TYPE);
      counters.bytes += bytes;
      out.push(filename);
      continue;
    }

    out.push(rawLine);
  }

  return out.join("\n");
}

/**
 * Descarga y procesa un playlist m3u8: si es un master con múltiples
 * variantes de calidad, elige SOLO la de mayor BANDWIDTH y descarta el
 * resto (no tiene sentido archivar todas las calidades para 1 stream por
 * idioma). Sube segmentos/keys a R2 y devuelve el texto reescrito.
 *
 * Si el master declara pistas de audio separadas (#EXT-X-MEDIA:TYPE=AUDIO
 * con URI= — ej. flixcloud, que manda jpn+eng en playlists aparte), también
 * se archivan: cada audio playlist se procesa como media playlist con
 * segmentos prefijados "aud-" y se guarda como audio-N.m3u8, la variante de
 * video como video.m3u8, y se genera un master nuevo que los referencia.
 * Sin esto el archivo quedaba mudo: el audio nunca se descargaba.
 */
async function processPlaylist(url, dirPrefix, counters, tsPrefix = "seg-", fmp4Prefix = "fseg-") {
  const { buf, ct } = await fetchBuffer(url);
  if (!isM3U8(ct, buf)) throw new Error(`Se esperaba un m3u8 en ${url}, llegó Content-Type=${ct}`);

  const text = buf.toString("utf8");
  const lines = text.split(/\r?\n/);

  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const bwMatch = trimmed.match(/BANDWIDTH=(\d+)/i);
      const uriLine = lines[i + 1]?.trim();
      if (uriLine && !uriLine.startsWith("#")) {
        variants.push({ lineIndex: i, bandwidth: bwMatch ? parseInt(bwMatch[1], 10) : 0, uri: uriLine });
      }
    }
  }

  if (variants.length === 0) {
    return processMediaPlaylist(text, url, dirPrefix, counters, tsPrefix, fmp4Prefix);
  }

  const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a));
  const audioMediaLines = lines.filter((l) => /^#EXT-X-MEDIA/i.test(l.trim()) && /TYPE=AUDIO/i.test(l) && /URI="[^"]+"/.test(l));

  if (audioMediaLines.length === 0) {
    console.log(`  Master con ${variants.length} variante(s) de calidad, se descartan ${variants.length - 1} y se usa BANDWIDTH=${best.bandwidth}`);
    const abs = resolveUrl(best.uri, url);
    return processPlaylist(abs, dirPrefix, counters, tsPrefix, fmp4Prefix);
  }

  // Master con audio separado: archivar video + cada pista de audio y
  // generar un master propio que referencie los playlists locales.
  console.log(`  Master con ${variants.length} variante(s) y ${audioMediaLines.length} pista(s) de audio — archivando video (BANDWIDTH=${best.bandwidth}) + audio`);

  const videoText = await processPlaylist(resolveUrl(best.uri, url), dirPrefix, counters, tsPrefix, fmp4Prefix);
  await upload(`${dirPrefix}/video.m3u8`, Buffer.from(videoText, "utf8"), "application/vnd.apple.mpegurl");

  const out = [];
  let audioIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      // Solo queda la variante elegida, apuntando al playlist local de video.
      if (i === best.lineIndex) {
        out.push(rawLine);
        out.push("video.m3u8");
      }
      i++; // saltar la línea URI de la variante
      continue;
    }

    if (/^#EXT-X-MEDIA/i.test(trimmed)) {
      // Pistas que no sean AUDIO (subtitles embebidos, etc.) se descartan:
      // sus URIs apuntan a URLs del proxy que expiran.
      if (!/TYPE=AUDIO/i.test(trimmed)) continue;
      const m = trimmed.match(/URI="([^"]+)"/);
      if (!m) { out.push(rawLine); continue; }
      const abs = resolveUrl(m[1], url);
      const audioText = await processPlaylist(abs, dirPrefix, counters, "aud-", "audf-");
      const name = `audio-${audioIdx++}.m3u8`;
      await upload(`${dirPrefix}/${name}`, Buffer.from(audioText, "utf8"), "application/vnd.apple.mpegurl");
      out.push(rawLine.replace(/URI="([^"]+)"/, `URI="${name}"`));
      continue;
    }

    out.push(rawLine);
  }

  return out.join("\n");
}

/**
 * Archiva un stream HLS completo a R2 bajo el prefijo `slug`.
 * El bucket es privado: para servirlo hay que firmar `${slug}/master.m3u8`
 * con signR2Path/buildSignedR2Url (src/lib/r2-seal.js) contra el Worker r2-cdn.
 * Devuelve { slug, bytes, elapsedMs }.
 */
export async function archiveHlsToR2(inputUrl, slug) {
  assertR2Env();
  const counters = { seg: 0, key: 0, init: 0, bytes: 0 };
  const t0 = Date.now();

  const finalPlaylist = await processPlaylist(inputUrl, slug, counters);
  const masterKey = `${slug}/master.m3u8`;
  await upload(masterKey, Buffer.from(finalPlaylist, "utf8"), "application/vnd.apple.mpegurl");

  return { slug, bytes: counters.bytes, elapsedMs: Date.now() - t0 };
}
