import { request as undiciRequest, fetch as undiciFetch, ProxyAgent } from "undici";
import { HEADERS, KAI_HTTP_PROXY } from "../config/constants.js";

export async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

export async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

export async function proxyFetch(url, headers, timeoutMs = 30000) {
  // flixcloud.cc funciona mejor con fetch nativo HTTP/2
  if (url.includes("flixcloud.cc")) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const buf = await r.arrayBuffer();
    return {
      statusCode: r.status,
      headers: Object.fromEntries(r.headers.entries()),
      body: (async function* () { yield Buffer.from(buf); })(),
    };
  }

  return undiciRequest(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function kaiFetch(url, timeoutMs = 15000) {
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Referer": "https://megaup.nl/",
  };

  if (KAI_HTTP_PROXY) {
    const dispatcher = new ProxyAgent(KAI_HTTP_PROXY);
    return undiciFetch(url, { headers: baseHeaders, dispatcher, signal: AbortSignal.timeout(timeoutMs) });
  }

  return fetch(url, { headers: baseHeaders, signal: AbortSignal.timeout(timeoutMs) });
}

export { undiciRequest, undiciFetch, ProxyAgent };
