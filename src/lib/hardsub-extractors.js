// Extractores de embeds usados por los scrapers de hardsub inglés
// (animenosub, aniwaves). Portados tal cual de Anivexa-API/extractors —
// self-contained, sin dependencias del proyecto.
//
//   vidmoly → vidmoly.net/biz/to (animenosub "Omega")
//   nova    → upn.one (animenosub)
//   vidplay → play.echovideo.ru/embed-0|1 (aniwaves "Vidplay")
//   datasv  → play.echovideo.ru/embed-20 (aniwaves, MP4 por calidad)
//   byse    → bysesayeveum.com / gn1r5n.org (aniwaves "FileMoon"-like; PoW)
import { webcrypto as crypto } from "node:crypto";
import nodeCrypto from "node:crypto";

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

// ── vidmoly ──────────────────────────────────────────────────────────────────
export function canExtractVidmoly(url) {
  return /vidmoly\.(net|biz|to)/i.test(String(url));
}

export async function extractVidmoly(embedUrl, { userAgent = DEFAULT_UA, referer } = {}) {
  const url = String(embedUrl).startsWith("//") ? `https:${embedUrl}` : String(embedUrl);
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, "Referer": referer ?? "https://animenosub.to/" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Vidmoly fetch HTTP ${response.status}`);
  const html = await response.text();
  const match = html.match(/sources:\s*\[\s*\{\s*file:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/);
  if (!match) throw new Error("Vidmoly m3u8 not found in embed HTML");
  return [match[1]];
}

// ── nova (upn.one) ───────────────────────────────────────────────────────────
const NOVA_KEY = Buffer.from("6b69656d7469656e6d75613931316361", "hex");
const NOVA_IV = Buffer.from("313233343536373839306f6975797472", "hex");

export function canExtractNova(url) {
  return /upn\.one/i.test(String(url));
}

export async function extractNova(embedUrl, { userAgent = DEFAULT_UA } = {}) {
  const id = String(embedUrl).match(/upn\.one\/#([A-Za-z0-9]+)/i)?.[1];
  if (!id) throw new Error(`Cannot extract Nova id from ${embedUrl}`);
  const response = await fetch(`https://nova.upn.one/api/v1/video?id=${id}&w=1920&h=1080&r=`, {
    headers: { "User-Agent": userAgent, "Referer": "https://nova.upn.one/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Nova fetch HTTP ${response.status}`);
  const hex = (await response.text()).trim();
  const decipher = nodeCrypto.createDecipheriv("aes-128-cbc", NOVA_KEY, NOVA_IV);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(hex, "hex")), decipher.final()]);
  const data = JSON.parse(decrypted.toString("utf8"));
  const url = data.cf ?? data.source;
  if (!url) throw new Error("Nova response missing m3u8 url");
  return [url];
}

// ── vidplay (echovideo embed-0/embed-1) ──────────────────────────────────────
export function canExtractVidplay(url) {
  return /play\.echovideo\.ru\/embed-[01]\//i.test(String(url));
}

export async function extractVidplay(embedUrl, { userAgent = DEFAULT_UA } = {}) {
  const url = new URL(String(embedUrl));
  const match = url.pathname.match(/^\/(embed-[01])\/([^/]+)$/i);
  const type = match?.[1];
  const id = match?.[2];
  if (!id) throw new Error(`Cannot extract Vidplay id from ${embedUrl}`);
  const endpoint = new URL(`/${type}/getSources`, url.origin);
  endpoint.searchParams.set("id", id);
  const response = await fetch(endpoint, {
    headers: { "User-Agent": userAgent, "Referer": embedUrl, "X-Requested-With": "XMLHttpRequest" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Vidplay sources HTTP ${response.status}`);
  const data = await response.json();
  const sources = Array.isArray(data?.sources)
    ? data.sources.map((item) => typeof item === "string" ? item : item?.file ?? item?.url).filter(Boolean)
    : typeof data?.sources === "string" ? [data.sources] : [];
  if (!sources.length) throw new Error("Vidplay response has no sources");
  return sources;
}

// ── datasv (echovideo embed-20, MP4 por calidad) ─────────────────────────────
export function canExtractDataSv(url) {
  return /play\.echovideo\.ru\/embed-20\//i.test(String(url));
}

export async function extractDataSv(embedUrl, { userAgent = DEFAULT_UA } = {}) {
  const url = new URL(String(embedUrl));
  const id = url.pathname.match(/^\/embed-20\/([^/]+)$/i)?.[1];
  if (!id) throw new Error(`Cannot extract DATASV id from ${embedUrl}`);
  const endpoint = new URL("/embed-20/getSources", url.origin);
  endpoint.searchParams.set("id", id);
  const response = await fetch(endpoint, {
    headers: { "User-Agent": userAgent, "Referer": embedUrl, "X-Requested-With": "XMLHttpRequest" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`DATASV sources HTTP ${response.status}`);
  const data = await response.json();
  const sources = [];
  for (const [quality, urls] of Object.entries(data?.sources ?? {})) {
    for (const source of Array.isArray(urls) ? urls : [urls]) {
      if (typeof source === "string" && source) sources.push({ url: source, type: "mp4", quality });
    }
  }
  const available = await Promise.all(sources.map(async (source) => {
    try {
      const check = await fetch(source.url, {
        method: "HEAD",
        headers: { "User-Agent": userAgent, "Referer": `${url.origin}/` },
        signal: AbortSignal.timeout(10000),
      });
      return check.ok ? source : null;
    } catch {
      return null;
    }
  }));
  const valid = available.filter(Boolean);
  if (!valid.length) throw new Error("DATASV response has no available sources");
  return valid;
}

// ── byse (bysesayeveum.com / gn1r5n.org — PoW + AES-GCM) ─────────────────────
const BLOCKS = 512;
const MASK = BLOCKS - 1;
const ROUNDS = 2;
const MUL_A = 2654435761;
const MUL_B = 2246822519;

function b64u(value) { return Buffer.from(value).toString("base64url"); }
function b64uDec(value) { return Buffer.from(value, "base64url"); }
function rot(value, shift) { return (value << shift | value >>> 32 - shift) >>> 0; }
function mul(value, factor) { return Math.imul(value, factor) >>> 0; }

function mix(state) {
  state[0] = state[0] + state[1] >>> 0;
  state[3] = rot(state[3] ^ state[0], 16);
  state[2] = state[2] + state[3] >>> 0;
  state[1] = rot(state[1] ^ state[2], 12);
  state[0] = state[0] + state[1] >>> 0;
  state[3] = rot(state[3] ^ state[0], 8);
  state[2] = state[2] + state[3] >>> 0;
  state[1] = rot(state[1] ^ state[2], 7);
}

function hash(bytes) {
  const state = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i++) {
    state[0] = state[0] + bytes[i] >>> 0;
    state[0] = rot(state[0], 7);
    mix(state);
  }
  for (let i = 0; i < 8; i++) mix(state);
  const table = new Uint32Array(BLOCKS);
  for (let i = 0; i < BLOCKS; i++) {
    mix(state);
    table[i] = (state[0] ^ state[2]) >>> 0;
  }
  for (let i = 0; i < ROUNDS; i++) {
    for (let index = 0; index < BLOCKS; index++) {
      const tableIndex = table[index] & MASK;
      let value = table[index] + table[tableIndex] >>> 0;
      value = rot(value, 13);
      value = (value ^ mul(table[(index + 1) & MASK], MUL_A)) >>> 0;
      table[index] = value;
      state[0] = (state[0] ^ value) >>> 0;
      mix(state);
    }
  }
  const out = new Uint32Array(8);
  const width = BLOCKS / 8;
  for (let i = 0; i < 8; i++) {
    mix(state);
    let value = state[0];
    const offset = i * width;
    for (let index = 0; index < width; index++) {
      const tableValue = table[offset + index];
      value = value + tableValue >>> 0;
      value = rot(value, 5);
      value = (value ^ mul(tableValue, MUL_B)) >>> 0;
    }
    out[i] = (value ^ state[2]) >>> 0;
  }
  return out;
}

function latin1Bytes(value) {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 255;
  return out;
}

function leadingZeros(value) {
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === 0) { total += 32; continue; }
    return total + Math.clz32(item);
  }
  return total;
}

// El PoW es un loop síncrono: sin tope, una dificultad alta bloquea el event
// loop del proceso entero por minutos. ~3M intentos ≈ pocos segundos.
const POW_MAX_ATTEMPTS = 3_000_000;

function solvePoW(nonce, difficulty) {
  const prefix = `${nonce}:`;
  for (let counter = 0; counter < POW_MAX_ATTEMPTS; counter++) {
    if (leadingZeros(hash(latin1Bytes(prefix + counter))) >= difficulty) return String(counter);
  }
  throw new Error(`Byse PoW: no solution in ${POW_MAX_ATTEMPTS} attempts (difficulty ${difficulty})`);
}

export function canExtractByse(url) {
  return /(?:bysesayeveum\.com|gn1r5n\.org)\/e\//i.test(String(url));
}

export async function extractByse(embedUrl, { userAgent = DEFAULT_UA, referer } = {}) {
  const code = String(embedUrl).match(/\/e\/([a-z0-9]+)/i)?.[1];
  if (!code) throw new Error(`Cannot extract Byse code from ${embedUrl}`);
  const embedOrigin = new URL(embedUrl).origin;
  const parentUrl = referer || embedUrl;
  const parentHost = new URL(parentUrl).hostname;
  const embedHeaders = {
    "X-Embed-Origin": parentHost,
    "X-Embed-Referer": parentUrl,
    "X-Embed-Parent": embedUrl,
  };
  const detailsResponse = await fetch(`${embedOrigin}/api/videos/${code}/embed/details`, {
    headers: { "User-Agent": userAgent, "Referer": embedUrl, ...embedHeaders },
    signal: AbortSignal.timeout(20000),
  });
  if (!detailsResponse.ok) throw new Error(`Byse details HTTP ${detailsResponse.status}`);
  const details = await detailsResponse.json();
  const frameUrl = details.embed_frame_url || embedUrl;
  const frameBase = new URL(frameUrl).origin;
  const challengeResponse = await fetch(`${frameBase}/api/videos/access/challenge`, {
    method: "POST",
    headers: { "Content-Length": "0", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent },
    signal: AbortSignal.timeout(20000),
  });
  if (!challengeResponse.ok) throw new Error(`Byse challenge HTTP ${challengeResponse.status}`);
  const challenge = await challengeResponse.json();
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keyPair.privateKey, new TextEncoder().encode(challenge.nonce));
  const attestResponse = await fetch(`${frameBase}/api/videos/access/attest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent },
    body: JSON.stringify({ nonce: challenge.nonce, challenge_id: challenge.challenge_id, public_key: publicKey, signature: b64u(signature) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!attestResponse.ok) throw new Error(`Byse attest HTTP ${attestResponse.status}`);
  const attest = await attestResponse.json();
  const cookie = `byse_viewer_id=${attest.viewer_id}; byse_device_id=${attest.device_id}`;
  const fingerprint = { token: attest.token, viewer_id: attest.viewer_id, device_id: attest.device_id, confidence: attest.confidence };
  const captchaResponse = await fetch(`${frameBase}/api/videos/${code}/embed/captcha`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ fingerprint }),
    signal: AbortSignal.timeout(20000),
  });
  if (!captchaResponse.ok) throw new Error(`Byse captcha HTTP ${captchaResponse.status}`);
  const captcha = await captchaResponse.json();
  const verifyResponse = await fetch(`${frameBase}/api/videos/${code}/embed/captcha/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, ...embedHeaders },
    body: JSON.stringify({ pow_token: captcha.pow_token, solution: solvePoW(captcha.pow_nonce, captcha.pow_difficulty), fingerprint }),
    signal: AbortSignal.timeout(20000),
  });
  if (!verifyResponse.ok) throw new Error(`Byse verify HTTP ${verifyResponse.status}`);
  const verification = await verifyResponse.json();
  const playbackResponse = await fetch(`${frameBase}/api/videos/${code}/embed/playback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Origin": frameBase, "Referer": frameUrl, "User-Agent": userAgent, "Cookie": cookie, "X-Captcha-Token": verification.token, ...embedHeaders },
    body: JSON.stringify({ fingerprint }),
    signal: AbortSignal.timeout(20000),
  });
  if (!playbackResponse.ok) throw new Error(`Byse playback HTTP ${playbackResponse.status}`);
  const playbackData = await playbackResponse.json();
  const playback = playbackData.playback;
  const keyBytes = Buffer.concat(playback.key_parts.filter((item) => b64uDec(item).length === 16).map(b64uDec));
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64uDec(playback.iv) }, aesKey, b64uDec(playback.payload));
  return JSON.parse(new TextDecoder().decode(decrypted)).sources.map((item) => item.url);
}

// ── registry ─────────────────────────────────────────────────────────────────
const videoExtractors = [
  { name: "byse", matches: canExtractByse, extract: extractByse },
  { name: "datasv", matches: canExtractDataSv, extract: extractDataSv },
  { name: "vidplay", matches: canExtractVidplay, extract: extractVidplay },
  { name: "vidmoly", matches: canExtractVidmoly, extract: extractVidmoly },
  { name: "nova", matches: canExtractNova, extract: extractNova },
];

export function findVideoExtractor(url) {
  return videoExtractors.find((extractor) => extractor.matches(url)) ?? null;
}
