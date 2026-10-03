import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { request as undiciRequest, fetch as undiciFetch, ProxyAgent } from "undici";
import { HEADERS, KAI_HTTP_PROXY, REANIME_CF_WORKER, REANIME_PROXY } from "../config/constants.js";

const PROXY_AGENT_CACHE = new Map();
const FLIXCLOUD_WORKER_HOST_RE = /(^|\.)flixcloud\.cc$/i;
const REANIME_DEBUG = /^(1|true|yes|on)$/i.test(process.env.REANIME_DEBUG || "");

function shortUrl(value) {
  if (!value) return value;
  return value.length > 180 ? `${value.slice(0, 177)}...` : value;
}

function logReanimeHttp(message, extra = null) {
  if (!REANIME_DEBUG) return;
  if (extra) console.info(`[reanime:http] ${message}`, extra);
  else console.info(`[reanime:http] ${message}`);
}

function getAxiosProxyAgents(proxyUrl) {
  if (!proxyUrl) return null;
  if (PROXY_AGENT_CACHE.has(proxyUrl)) return PROXY_AGENT_CACHE.get(proxyUrl);

  const lower = proxyUrl.toLowerCase();
  const agent = lower.startsWith("socks")
    ? new SocksProxyAgent(proxyUrl)
    : new HttpsProxyAgent(proxyUrl);
  const out = { httpAgent: agent, httpsAgent: agent };
  PROXY_AGENT_CACHE.set(proxyUrl, out);
  return out;
}

function toFetchLikeResponse(status, headers, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data ?? "");
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
    else responseHeaders.set(key, String(value));
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    async text() { return body.toString("utf8"); },
    async json() { return JSON.parse(body.toString("utf8")); },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
  };
}

export async function fetchWithProxy(url, { proxyUrl = null, timeoutMs = 30000, ...options } = {}) {
  if (!proxyUrl) {
    return fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(timeoutMs) });
  }

  const agents = getAxiosProxyAgents(proxyUrl);
  const response = await axios.request({
    url,
    method: options.method || "GET",
    headers: options.headers,
    data: options.body,
    responseType: "arraybuffer",
    timeout: timeoutMs,
    proxy: false,
    decompress: false,
    validateStatus: () => true,
    ...(agents || {}),
  });

  return toFetchLikeResponse(response.status, response.headers, response.data);
}

export async function fetchReanime(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const startedAt = Date.now();
  if (REANIME_CF_WORKER && method === "GET") {
    try {
      const parsed = new URL(url);
      if (FLIXCLOUD_WORKER_HOST_RE.test(parsed.hostname)) {
        const workerUrl = `${REANIME_CF_WORKER}/fetch?url=${encodeURIComponent(parsed.href)}`;
        const workerHeaders = {};
        if (options.headers?.Accept || options.headers?.accept) workerHeaders.Accept = options.headers.Accept || options.headers.accept;
        if (options.headers?.["Accept-Language"] || options.headers?.["accept-language"]) {
          workerHeaders["Accept-Language"] = options.headers["Accept-Language"] || options.headers["accept-language"];
        }
        logReanimeHttp("worker request:start", { method, target: shortUrl(parsed.href), workerUrl: shortUrl(workerUrl) });
        const response = await fetch(workerUrl, {
          headers: workerHeaders,
          signal: options.signal || AbortSignal.timeout(options.timeoutMs || 30000),
        });
        logReanimeHttp("worker request:end", {
          method,
          target: shortUrl(parsed.href),
          status: response.status,
          ms: Date.now() - startedAt,
          contentType: response.headers.get("content-type") || "",
        });
        return response;
      }
    } catch {}
  }
  logReanimeHttp("direct/proxy request:start", {
    method,
    target: shortUrl(url),
    viaProxy: Boolean(REANIME_PROXY),
  });
  try {
    const response = await fetchWithProxy(url, { proxyUrl: REANIME_PROXY, ...options });
    logReanimeHttp("direct/proxy request:end", {
      method,
      target: shortUrl(url),
      viaProxy: Boolean(REANIME_PROXY),
      status: response.status,
      ms: Date.now() - startedAt,
      contentType: response.headers.get("content-type") || "",
    });
    return response;
  } catch (error) {
    logReanimeHttp("direct/proxy request:error", {
      method,
      target: shortUrl(url),
      viaProxy: Boolean(REANIME_PROXY),
      ms: Date.now() - startedAt,
      error: error?.message || String(error),
    });
    throw error;
  }
}

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
