import { EDGE_PROXY_BASE } from "../config/constants.js";
import crypto from "node:crypto";

export function normalizeLang(lang, originalProvider = "") {
  const l = String(lang).toLowerCase();
  const op = String(originalProvider).toLowerCase();

  if (l === "es-lat" || l === "es") return { lang: "ESP-LAT", langLabel: "Español latino" };
  if (l === "es-dub") return { lang: "ESP-DUB", langLabel: "Español (doblado)" };
  if (l === "en" || l === "en-dub") return { lang: "ENG-DUB", langLabel: "Inglés (doblado)" };
  if (l === "eng") return { lang: "ENG", langLabel: "English" };

  if (l === "japanese" || l === "jap" || l.startsWith("ja") || l.includes("jap")) {
    // ja-sub-lat ya trae el idioma del sub en el tag (japonés + sub latino
    // quemado — animeav1 no tiene subs por separado). Va antes del chequeo
    // de provider para que los CDNs alternativos de animeav1 (voe,
    // mp4upload) no caigan en JAP-SUB.
    if (l === "ja-sub-lat") return { lang: "JAP-ES-HS", langLabel: "Japonés (sub español quemado)" };
    // Hardsub detection. upnshare es un CDN alternativo usado dentro del
    // pipeline de animeav1 (ver providers/scraper.js) — mismo contenido
    // (japonés con sub español quemado), solo cambia el hosting del stream.
    if (op.includes("animeav1") || op.includes("upnshare")) return { lang: "JAP-ES-HS", langLabel: "Japonés (sub español quemado)" };
    // hsub = hardsub real (sub quemado). anikoto da ambos: "anikoto-*" es
    // soft-sub y "anikoto-hsub-*" es el quemado — hay que mirar "hsub" y no
    // "anikoto" a secas para no etiquetar mal los soft-subs.
    if (op.includes("miruro") || op.includes("hsub")) return { lang: "JAP-EN-HS", langLabel: "Japonés (sub inglés quemado)" };
    return { lang: "JAP-SUB", langLabel: "Japonés (sub por separado)" };
  }

  return { lang: l.toUpperCase(), langLabel: l };
}

export function mapMovieTvLang(rawLang, originalLang) {
  const l = String(rawLang || "en").toLowerCase();
  if (l.startsWith("en")) {
    return (originalLang || "").toLowerCase().startsWith("en") ? "eng" : "en-dub";
  }
  return rawLang || "en";
}

export function resolveProxyUrlByType(result, proxyBase, ref) {
  if (result.type === "mp4") {
    const edgeBase = EDGE_PROXY_BASE ?? proxyBase;
    return `${edgeBase}/mp4-proxy?url=${encodeURIComponent(result.url)}&headers=${encodeURIComponent(JSON.stringify(ref ? { Referer: ref } : {}))}`;
  }
  if (result.type === "dash") {
    return `${proxyBase}/dash-proxy.mpd?u=${encodeURIComponent(result.url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
  }
  return `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(result.url)}${ref ? `&ref=${encodeURIComponent(ref)}` : ""}`;
}

export function makeCuevanaStream(result, proxyBase) {
  const edgeBase = EDGE_PROXY_BASE ?? proxyBase;
  const hasHeaders = result.headers && Object.keys(result.headers).length > 0;
  const encodedHeaders = hasHeaders ? `&headers=${encodeURIComponent(JSON.stringify(result.headers))}` : "";
  const originalProvider = `cuevana/${result.server}`;
  const { lang, langLabel } = normalizeLang("es-lat", originalProvider);
  const vttProxy = result.thumbnailVtt
    ? `${proxyBase}/fetch?url=${encodeURIComponent(result.thumbnailVtt)}&ref=${encodeURIComponent(new URL(result.thumbnailVtt).origin + "/")}&ct=${encodeURIComponent("text/vtt")}`
    : null;
  const jpgProxy = result.thumbnailJpg
    ? `${proxyBase}/fetch?url=${encodeURIComponent(result.thumbnailJpg)}&ref=${encodeURIComponent(new URL(result.thumbnailJpg).origin + "/")}&ct=${encodeURIComponent("image/jpeg")}`
    : null;
  return {
    url: result.url,
    quality: "auto",
    lang,
    langLabel,
    type: "hls",
    provider: originalProvider,
    originalProvider,
    ...(hasHeaders && { headers: result.headers }),
    proxy_url: `${edgeBase}/proxy?url=${encodeURIComponent(result.url)}${encodedHeaders}`,
    ...(result.thumbnailVtt && { thumbnailVtt: result.thumbnailVtt, thumbnailVttProxy: vttProxy }),
    ...(result.thumbnailJpg && { thumbnailJpg: result.thumbnailJpg, thumbnailJpgProxy: jpgProxy }),
  };
}

export function makeVidsrcStream(result, proxyBase, lang = "en") {
  const ref = result.referer ?? null;
  const proxy_url = resolveProxyUrlByType(result, proxyBase, ref);
  const originalProvider = result.provider ?? "vidsrc";
  const { lang: normLang, langLabel } = normalizeLang(lang ?? "en", originalProvider);
  return {
    url: result.url,
    quality: "auto",
    lang: normLang,
    langLabel,
    type: result.type ?? "hls",
    provider: originalProvider,
    originalProvider,
    proxy_url,
  };
}

export function makeGenericStream(result, proxyBase, lang = "en") {
  const ref = result.referer ?? null;
  const proxy_url = resolveProxyUrlByType(result, proxyBase, ref);
  const originalProvider = result.provider ?? "generic";
  const { lang: normLang, langLabel } = normalizeLang(lang, originalProvider);
  const vttProxy = result.thumbnailVtt
    ? `${proxyBase}/fetch?url=${encodeURIComponent(result.thumbnailVtt)}&ct=${encodeURIComponent("text/vtt")}`
    : null;
  return {
    url: result.url,
    quality: result.quality ?? "auto",
    lang: normLang,
    langLabel,
    type: result.type === "mp4" || result.type === "dash" ? result.type : "hls",
    provider: originalProvider,
    originalProvider,
    ...(result.thumbnailVtt && { thumbnailVtt: result.thumbnailVtt, thumbnailVttProxy: vttProxy }),
    proxy_url,
  };
}

export function makeVixsrcStream(result, proxyBase, lang = "en") {
  const { lang: normLang, langLabel } = normalizeLang(lang, "vixsrc");
  return {
    url: result.masterUrl,
    quality: "auto",
    lang: normLang,
    langLabel,
    type: "hls",
    provider: "vixsrc",
    originalProvider: "vixsrc",
    proxy_url: `${proxyBase}/vixsrc-stream.m3u8?u=${encodeURIComponent(result.masterUrl)}`,
  };
}

export function makeAnimeStream(proxyBase, url, quality, lang, originalProvider, { headers = null, skip = null, forceType = null } = {}) {
  // Decisión de type por orden de prioridad:
  //   1) forceType explícito (quien llama ya lo sabe — mejor caso).
  //   2) Si la URL empieza con "sealed:" — no hay info util ahí. Para Reanime
  //      (flixcloud-backed, provider `reanime-*` o `flixcloud-*`) sabemos que
  //      siempre es HLS. Otros providers sin hint → mp4 safe default.
  //   3) Sniff por substring ".m3u8" / "/m3u8/" en URLs crudas sin sellar.
  let type = forceType;
  if (!type) {
    const op = String(originalProvider || "").toLowerCase();
    if (typeof url === "string" && /^sealed:/i.test(url)) {
      if (/^(reanime|flixcloud)($|[-/])/.test(op)) type = "hls";
      else type = "mp4";
    } else if (typeof url === "string" && (url.includes(".m3u8") || url.includes("/m3u8/"))) {
      type = "hls";
    } else {
      type = "mp4";
    }
  }
  const { lang: normLang, langLabel } = normalizeLang(lang, originalProvider);

  const normalizeSkip = (raw) => {
    if (!raw) return null;
    const intro = raw.intro?.every((v) => v === 0) ? null : raw.intro;
    const outro = raw.outro?.every((v) => v === 0) ? null : raw.outro;
    return (intro || outro) ? { ...(intro && { intro }), ...(outro && { outro }) } : null;
  };

  const vk = typeof url === "string" ? `vk:${crypto.createHash("sha1").update(url).digest("hex").slice(0,24)}` : null;

  return {
    url,
    quality,
    lang: normLang,
    langLabel,
    provider: originalProvider,
    originalProvider,
    type,
    ...(headers && { headers }),
    ...(vk && { verifyKey: vk }),
    ...(normalizeSkip(skip) && { skip: normalizeSkip(skip) }),
  };
}

export function makeVidRockStreams(result, proxyBase) {
  const qualityVal = q => parseInt(q) || 0;
  const cdnBest = new Map();
  for (const s of result.sources) {
    try {
      const cdnKey = new URL(s.url.url).hostname;
      const prev = cdnBest.get(cdnKey);
      if (!prev || qualityVal(s.quality) > qualityVal(prev.quality)) cdnBest.set(cdnKey, s);
    } catch { /* ignore */ }
  }
  return [...cdnBest.values()].map((s, i) => {
    const ref = s.url.headers?.Referer ?? null;
    const refEnc = ref ? `&ref=${encodeURIComponent(ref)}` : "";
    const originalProvider = i === 0 ? "vidrock" : `vidrock-${i + 1}`;
    return {
      url: s.url.url,
      quality: s.quality ?? "auto",
      lang: "ENG",
      langLabel: "English",
      type: s.type,
      provider: originalProvider,
      originalProvider,
      proxy_url: s.type === "hls"
        ? `${proxyBase}/generic-stream.m3u8?u=${encodeURIComponent(s.url.url)}${refEnc}`
        : `${proxyBase}/mp4-proxy?url=${encodeURIComponent(s.url.url)}&headers=${encodeURIComponent(JSON.stringify(s.url.headers ?? {}))}`,
    };
  });
}

const PROVIDER_ORDER = { vidstuck: 1, vidy: 2, cinejoy: 3, vidup: 4, vaplayer: 5 };

function providerPriority(s) {
  const op = String(s.originalProvider).toLowerCase();
  for (const [name, rank] of Object.entries(PROVIDER_ORDER)) {
    if (op.startsWith(name) || op.includes(`/${name}`) || op.includes(`-${name}`)) return rank;
  }
  return 99;
}

/**
 * Orde de preferencia de PROVIDERS para anime/movie/tv.
 * Número menor = más arriba en la lista.
 */
const PROVIDER_PREFERENCE_RANK = [
  { name: "zenkai", rank: 1 },
  { name: "reanime", rank: 2 },
  { name: "megaplay", rank: 3 },
  { name: "miruro", rank: 4 },
  { name: "animeav1", rank: 5 },
  { name: "animenosub", rank: 6 },
  { name: "vidrock", rank: 7 },
  { name: "vixsrc", rank: 8 },
  { name: "vidstuck", rank: 9 },
  { name: "flixcloud", rank: 10 }, // alias de reanime, por si aparece
];

function providerPreferenceRank(originalProvider) {
  const op = String(originalProvider || "").toLowerCase();
  for (const { name, rank } of PROVIDER_PREFERENCE_RANK) {
    if (op.startsWith(name) || op.includes(`-${name}`) || op.includes(`/${name}`)) return rank;
  }
  return 99;
}

/**
 * Idioma preferencia orden: ENG-DUB primero, luego HS en/es, luego dubs ESP/LAT/CAST,
 * finalmente JAP-SUB y otros.
 */
const LANG_PREFERENCE_RANK = [
  { re: /^ENG(-|_)DUB$/i, rank: 1, label: "inglés doblado" },
  { re: /^JAP(-|_)EN(-|_)HS$/i, rank: 2, label: "japonés hard-sub inglés" },
  { re: /^EN(-|_)HS$/i, rank: 2, label: "japonés hard-sub inglés alias" },
  { re: /^JAP(-|_)ES(-|_)HS$/i, rank: 3, label: "japonés hard-sub español" },
  { re: /^ES(-|_)HS$/i, rank: 3, label: "japonés hard-sub español alias" },
  { re: /^(ES|ESP)(-|_)?(LAT|LATINO)$/i, rank: 4, label: "español latino" },
  { re: /^(ES|ESP)(-|_)?(ES|CAST)?$/i, rank: 5, label: "español / castellano" },
  { re: /^JAP(-|_)SUB$/i, rank: 6, label: "japonés sub por separado" },
  { re: /^POR(-|_)?(BR|PT)?$/i, rank: 7, label: "portugués" },
  { re: /^ITA(-|_)?$/i, rank: 8, label: "italiano" },
];

function langPreferenceRank(lang) {
  const l = String(lang || "");
  for (const { re, rank } of LANG_PREFERENCE_RANK) {
    if (re.test(l)) return rank;
  }
  return 50;
}

export function sortStreams(streams) {
  const isHls = (s) => s.type === "hls" || /\.m3u8($|\?)/i.test(s.url || "");
  return [...streams].sort((a, b) => {
    // (1) IDIOMA primero. ENG-DUB grupo 1, EN-HS grupo 2, ES-HS grupo 3...
    //     Queremos ver juntos primero todos los doblajes, después los HS, después
    //     los subs por separado.
    const la = langPreferenceRank(a.lang), lb = langPreferenceRank(b.lang);
    if (la !== lb) return la - lb;

    // (2) Provider favorito DENTRO DEL MISMO IDIOMA.
    //     zenkai → reanime → megaplay → miruro → animeav1 → resto.
    const prA = providerPreferenceRank(a.originalProvider);
    const prB = providerPreferenceRank(b.originalProvider);
    if (prA !== prB) return prA - prB;

    // (3) Provider QUALITY legacy rank (menor es mejor) para desempate dentro
    //     de mismo provider + mismo lang + mismo tipo.
    const qa = providerPriority(a), qb = providerPriority(b);
    if (qa !== qb) return qa - qb;

    // (4) HLS antes que MP4/WebM directo a igualdad.
    const hA = isHls(a) ? 0 : 1, hB = isHls(b) ? 0 : 1;
    if (hA !== hB) return hA - hB;

    // (5) Mayor resolución primero a igualdad total.
    const resA = parseInt(a.quality) || 0;
    const resB = parseInt(b.quality) || 0;
    return resB - resA;
  });
}

/**
 * Blacklist centralizada de COMBINACIONES (provider × lang) que se sabe
 * que devuelven data incorrecta / inservible.
 *
 * Cada rule:
 *   provider: regex case-insensitive match contra originalProvider
 *   lang    : regex case-insensitive match contra lang
 *   reason  : string opcional para logs (por qué se borra)
 *
 * Para agregar una combinación nueva: agregar una entrada. No tocar cada scraper.
 */
const BROKEN_PROVIDER_LANG_RULES = [
  // miruro-sun + JAP-EN-HS: subtítulos quemados son incorrectos / inexistentes.
  // Se oculta solo esta combinación. ENG-DUB, otros langs, y miruro-{hop,kiwi,knob}
  // siguen intactos.
  { provider: /^miruro(-|_)?sun$/i, lang: /^JAP(-|_)?EN(-|_)?HS$/i, reason: "HS mal o sin subs (confirmado user 2026-10-07)" },
];

/**
 * Devuelve un array nuevo de streams sin las combinaciones provider+lang rotas.
 * Loguea cada stream removido para poder auditarlo.
 */
export function filterBrokenProviderLangCombos(streams, { log = true, context = "" } = {}) {
  if (!Array.isArray(streams) || !streams.length) return streams || [];
  const out = [];
  for (const s of streams) {
    const op = String(s.originalProvider || "");
    const lang = String(s.lang || "");
    let broken = null;
    for (const r of BROKEN_PROVIDER_LANG_RULES) {
      if (r.provider.test(op) && r.lang.test(lang)) {
        broken = r;
        break;
      }
    }
    if (broken) {
      if (log) {
        const ctx = context ? `[${context}] ` : "";
        console.log(`${ctx}[provider-blacklist] omitido ${op} / ${lang} — ${broken.reason || "n/a"}`);
      }
    } else {
      out.push(s);
    }
  }
  return out;
}

/**
 * Rutas de proxy que SABEMOS al 100% que devuelven HLS m3u8.
 * Si un stream tiene proxy_url en cualquiera de estas rutas, su type DEBE ser
 * "hls", sin importar lo que diga el campo type (podría estar mal por bugs
 * en sniff URLs selladas, etc.). Siempre gana el proxy_url pathname.
 */
const HLS_PROXY_ROUTE_RE = [
  /\/river\.m3u8($|\?)/i,
  /\/flixcloud-m3u8($|\?)/i,
  /\/vixsrc-stream\.m3u8($|\?)/i,
  /\/generic-stream\.m3u8($|\?)/i,
  /\/megaplay-m3u8($|\?)/i,
  /\/megavid-m3u8($|\?)/i,
  /\/miruro-m3u8($|\?)/i,
  /\/animeav1-m3u8($|\?)/i,
  /\/animenosub-m3u8($|\?)/i,
];

/**
 * Corrige campos `type` en streams basándose en el proxy_url real (fuente de
 * verdad). Si proxy_url es `*.m3u8` del proxy local → type = "hls".
 * También reconoce zenkai URLs `.m3u8` directas type=hls.
 * Devuelve un array NUEVO, no muta el original.
 */
export function normalizeProxyStreamTypes(streams) {
  if (!Array.isArray(streams)) return streams || [];
  return streams.map((_s) => {
    const s = { ..._s };
    let corrected = null;
    const p = String(s.proxy_url || "");
    if (p) {
      for (const re of HLS_PROXY_ROUTE_RE) {
        if (re.test(p)) { corrected = "hls"; break; }
      }
    }
    // Fallback: url cruda zenkai (públicas) o url con .m3u8 sin sellar → HLS.
    if (!corrected) {
      const u = String(s.url || "");
      if (u && !/^sealed:/i.test(u) && (u.includes(".m3u8") || u.includes("/m3u8/"))) corrected = "hls";
    }
    if (corrected && s.type !== corrected) s.type = corrected;
    return s;
  });
}

const PUBLIC_PROVIDER_LABELS = [
  { test: (op) => /^reanime($|-|\/)/i.test(op), label: "RIVER" },
  { test: (op) => /(^|[-/])animeav1($|[-/])/i.test(op), label: "RACING" },
  { test: (op) => /(^|[-/])megaplay($|[-/])/i.test(op), label: "INDEPENDIENTE" },
  { test: (op) => /(^|[-/])miruro($|[-/])/i.test(op), label: "BOCA" },
  { test: (op) => /(^|[-/])animenosub($|[-/])/i.test(op), label: "CABALLITO" },
  { test: (op) => /(^|[-/])vidrock($|[-/])/i.test(op), label: "CHACARITA" },
  { test: (op) => /(^|[-/])vixsrc($|[-/])/i.test(op), label: "SARANDÍ" },
  { test: (op) => /(^|[-/])vidstuck($|[-/])/i.test(op), label: "NUEVA CHICAGO" },
  { test: (op) => /(^|[-/])flixcloud($|[-/])/i.test(op), label: "RIVER" },
];

export function publicProviderLabel(originalProvider, { fallbackPrefix = "NET" } = {}) {
  const op = String(originalProvider || "");
  if (!op) return fallbackPrefix;
  if (/^zenkai($|-)/i.test(op)) return op; // nuestros propios streams no camuflamos
  for (const rule of PUBLIC_PROVIDER_LABELS) {
    if (rule.test(op)) return rule.label;
  }
  return fallbackPrefix;
}

export function publicDownloadServer(originalProvider) {
  // Mismo labeling que streams, para que coincidan server <-> provider.
  return publicProviderLabel(originalProvider, { fallbackPrefix: "NET" });
}

export function assignDisplayProviders(streams) {
  // Para combos dentro del mismo idioma / label → RIVER 1, RIVER 2... etc.
  const counters = new Map();
  const hasMultiple = new Set();
  for (const s of streams) {
    if (String(s.originalProvider || "") === "zenkai") continue;
    const key = `${s.lang || "unknown"}:${publicProviderLabel(s.originalProvider)}`;
    const cur = counters.get(key) || 0;
    if (cur >= 1) hasMultiple.add(key);
    counters.set(key, cur + 1);
  }
  counters.clear();
  return streams.map((s) => {
    if (String(s.originalProvider || "") === "zenkai") return s;
    const label = publicProviderLabel(s.originalProvider);
    const key = `${s.lang || "unknown"}:${label}`;
    const n = (counters.get(key) || 0) + 1;
    counters.set(key, n);
    const finalProvider = hasMultiple.has(key) ? `${label} ${n}` : label;
    return { ...s, provider: finalProvider };
  });
}
