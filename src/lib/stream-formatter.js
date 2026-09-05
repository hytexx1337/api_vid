import { EDGE_PROXY_BASE } from "../config/constants.js";

export function normalizeLang(lang, originalProvider = "") {
  const l = String(lang).toLowerCase();
  const op = String(originalProvider).toLowerCase();

  if (l === "es-lat" || l === "es") return { lang: "ESP-LAT", langLabel: "Español latino" };
  if (l === "es-dub") return { lang: "ESP-DUB", langLabel: "Español (doblado)" };
  if (l === "en" || l === "en-dub") return { lang: "ENG-DUB", langLabel: "Inglés (doblado)" };
  if (l === "eng") return { lang: "ENG", langLabel: "English" };

  if (l === "japanese" || l === "jap" || l.startsWith("ja") || l.includes("jap")) {
    // Hardsub detection
    if (op.includes("animeav1")) return { lang: "JAP-ES-HS", langLabel: "Japonés (sub español quemado)" };
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

export function makeAnimeStream(proxyBase, url, quality, lang, originalProvider, { headers = null, skip = null } = {}) {
  const isHLS = url.includes(".m3u8") || url.includes("/m3u8/");
  const { lang: normLang, langLabel } = normalizeLang(lang, originalProvider);

  const normalizeSkip = (raw) => {
    if (!raw) return null;
    const intro = raw.intro?.every((v) => v === 0) ? null : raw.intro;
    const outro = raw.outro?.every((v) => v === 0) ? null : raw.outro;
    return (intro || outro) ? { ...(intro && { intro }), ...(outro && { outro }) } : null;
  };

  return {
    url,
    quality,
    lang: normLang,
    langLabel,
    provider: originalProvider,
    originalProvider,
    type: isHLS ? "hls" : "mp4",
    ...(headers && { headers }),
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

const PROVIDER_ORDER = { videasy: 1, cinejoy: 2, vidup: 3, vaplayer: 4 };

function providerPriority(s) {
  const op = String(s.originalProvider).toLowerCase();
  for (const [name, rank] of Object.entries(PROVIDER_ORDER)) {
    if (op.startsWith(name) || op.includes(`/${name}`) || op.includes(`-${name}`)) return rank;
  }
  return 99;
}

export function sortStreams(streams) {
  const priority = (s) => {
    if (s.type === "hls" || s.url?.includes(".m3u8") || s.url?.includes(".txt")) {
      if (s.lang?.startsWith("ESP")) return 0;
      return 1;
    }
    const res = parseInt(s.quality) || 0;
    return 2 + (10000 - res) / 10000;
  };
  return [...streams].sort((a, b) => {
    const pa = priority(a), pb = priority(b);
    if (pa !== pb) return pa - pb;
    return providerPriority(a) - providerPriority(b);
  });
}

export function assignDisplayProviders(streams, prefix = "CPT CDN") {
  const counters = new Map();
  return streams.map((s) => {
    // Los streams archivados en R2 (nuestro propio storage) mantienen su
    // provider real en vez de camuflarse como "CPT CDN N": no dependen de
    // ningún origin externo, tiene sentido que se distingan del resto.
    if (s.originalProvider === "zenkai") return s;
    const lang = s.lang || "unknown";
    const n = (counters.get(lang) || 0) + 1;
    counters.set(lang, n);
    return { ...s, provider: `${prefix} ${n}` };
  });
}
