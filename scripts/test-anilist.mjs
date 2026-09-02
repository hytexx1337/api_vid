#!/usr/bin/env node
/**
 * test-anilist.mjs
 *
 * Prueba distintas combinaciones de método/headers/transporte contra la API
 * de AniList (https://graphql.anilist.co) para ver si alguna evita el 403
 * de "certain clients more likely to abuse it have been temporarily blocked".
 *
 * OJO: si el bloqueo es por IP/ASN (lo más común detrás de ese mensaje),
 * ninguna combinación de headers lo va a evitar — solo cambiar de IP/proxy.
 * Este script sirve para descartar esa posibilidad antes de asumirlo.
 *
 * Uso: node scripts/test-anilist.mjs
 */

const ENDPOINT = "https://graphql.anilist.co";
const QUERY = "query($id:Int){Media(id:$id,type:ANIME){id idMal title{romaji english} episodes status}}";
const VARIABLES = { id: 1 }; // Cowboy Bebop, ID estable (usado en la fase 1)
const TEST_ANIME_IDS = [21202, 170130];

const UA_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const UA_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";
const UA_CURL = "curl/8.4.0";
const UA_NODE_DEFAULT = null; // deja que undici/node ponga el suyo (o ninguno)

function buildBody() {
  return JSON.stringify({ query: QUERY, variables: VARIABLES });
}

function buildGetUrl() {
  const params = new URLSearchParams({
    query: QUERY,
    variables: JSON.stringify(VARIABLES),
  });
  return `${ENDPOINT}?${params.toString()}`;
}

const cases = [
  {
    name: "POST plano (como el código actual)",
    method: "POST",
    url: ENDPOINT,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: buildBody(),
  },
  {
    name: "POST + User-Agent Chrome",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_CHROME,
    },
    body: buildBody(),
  },
  {
    name: "POST + User-Agent Firefox",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_FIREFOX,
    },
    body: buildBody(),
  },
  {
    name: "POST + User-Agent curl",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_CURL,
    },
    body: buildBody(),
  },
  {
    name: "POST + Origin/Referer AniList (simula fetch desde anilist.co)",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_CHROME,
      Origin: "https://anilist.co",
      Referer: "https://anilist.co/",
    },
    body: buildBody(),
  },
  {
    name: "POST + headers completos tipo browser (sec-fetch-*, accept-language)",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_CHROME,
      Origin: "https://anilist.co",
      Referer: "https://anilist.co/",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "sec-ch-ua": '"Chromium";v="128", "Not;A=Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    },
    body: buildBody(),
  },
  {
    name: "GET con query params (AniList GraphQL soporta GET)",
    method: "GET",
    url: buildGetUrl(),
    headers: { Accept: "application/json", "User-Agent": UA_CHROME },
  },
  {
    name: "POST sin ningún header custom (fetch nativo defaults)",
    method: "POST",
    url: ENDPOINT,
    headers: { "Content-Type": "application/json" },
    body: buildBody(),
  },
  {
    name: "POST + Accept-Encoding identity (evita compresión)",
    method: "POST",
    url: ENDPOINT,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": UA_CHROME,
      "Accept-Encoding": "identity",
    },
    body: buildBody(),
  },
];

function truncate(str, n = 200) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n) + "…" : str;
}

async function runCase(c) {
  const t0 = Date.now();
  try {
    const res = await fetch(c.url, {
      method: c.method,
      headers: c.headers,
      body: c.body,
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const ok = res.ok && parsed?.data?.Media?.id;
    return {
      name: c.name,
      status: res.status,
      ok,
      ms,
      snippet: truncate(text.replace(/\s+/g, " ")),
      cfRay: res.headers.get("cf-ray"),
      server: res.headers.get("server"),
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return { name: c.name, status: "ERR", ok: false, ms, snippet: e.message };
  }
}

// Headers "ganadores" detectados en la fase 1 (Origin/Referer de anilist.co
// son los que destraban el 403 "temporarily disabled due to severe stability issues").
const WINNING_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": UA_CHROME,
  Origin: "https://anilist.co",
  Referer: "https://anilist.co/",
};

async function fetchAnimeInfo(anilistId) {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: WINNING_HEADERS,
      body: JSON.stringify({ query: QUERY, variables: { id: anilistId } }),
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    const media = parsed?.data?.Media;
    return { anilistId, status: res.status, ms, ok: res.ok && !!media, media, raw: text };
  } catch (e) {
    return { anilistId, status: "ERR", ms: Date.now() - t0, ok: false, error: e.message };
  }
}

async function main() {
  console.log(`Probando ${cases.length} variantes contra ${ENDPOINT}\n`);
  const results = [];
  for (const c of cases) {
    // Secuencial + pequeño delay para no gatillar rate-limit adicional entre pruebas.
    const r = await runCase(c);
    results.push(r);
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} [${String(r.status).padEnd(3)}] ${r.ms.toString().padStart(5)}ms  ${r.name}`);
    if (!r.ok) console.log(`     └─ ${r.snippet}${r.cfRay ? `  (cf-ray: ${r.cfRay})` : ""}`);
    await new Promise((res) => setTimeout(res, 800));
  }

  console.log("\n── Resumen ──");
  const passing = results.filter((r) => r.ok);
  if (passing.length === 0) {
    console.log("❌ Ninguna variante funcionó. Esto sugiere bloqueo por IP/ASN, no por headers.");
    console.log("   Recomendación: usar un proxy residencial/otra IP para las llamadas a AniList,");
    console.log("   o cachear agresivamente anilistToMal/getAnilistMedia para minimizar requests.");
  } else {
    console.log(`✅ ${passing.length}/${results.length} variantes funcionaron:`);
    for (const p of passing) console.log(`   - ${p.name}`);
  }

  console.log(`\n── Fase 2: consultando animes reales (${TEST_ANIME_IDS.join(", ")}) con headers ganadores ──\n`);
  for (const id of TEST_ANIME_IDS) {
    const r = await fetchAnimeInfo(id);
    if (r.ok) {
      const t = r.media.title;
      console.log(`✅ [${r.status}] ${r.ms}ms  id=${id}  "${t.romaji}"${t.english ? ` / "${t.english}"` : ""}  idMal=${r.media.idMal}  episodes=${r.media.episodes ?? "?"}  status=${r.media.status}`);
    } else {
      console.log(`❌ [${r.status}] ${r.ms}ms  id=${id}  ${r.error ?? truncate(r.raw)}`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

main();
