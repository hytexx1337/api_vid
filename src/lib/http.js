import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as undiciRequest, fetch as undiciFetch, ProxyAgent } from "undici";
import { HEADERS, KAI_HTTP_PROXY, REANIME_CF_WORKER } from "../config/constants.js";

const execFileAsync = promisify(execFile);
const CURL_STATUS_MARKER = "__TRAE_STATUS__:";
const CURL_CT_MARKER = "__TRAE_CT__:";
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";

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
  // fetch8.flixcloud.cc / reanime.to pueden devolver 403 cuando Node/undici
  // los toca directo. Si hay Worker configurado, usar curl -> Worker evita ese
  // fingerprint y deja /fetch funcionando también para VTT/sprites.
  if (url.includes("flixcloud.cc") || url.includes("reanime.to")) {
    if (REANIME_CF_WORKER) {
      try {
        const r = await curlWorkerFetchBuffer(url, { workerBase: REANIME_CF_WORKER, timeoutMs });
        const buf = await r.buffer();
        return {
          statusCode: r.status,
          headers: { "content-type": r.contentType || "application/octet-stream" },
          body: (async function* () { yield buf; })(),
        };
      } catch {
        // fallback al fetch nativo para entornos sin curl/worker roto.
      }
    }

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

export async function curlWorkerFetch(targetUrl, { workerBase, timeoutMs = 15000 } = {}) {
  if (!workerBase) throw new Error("workerBase is required");
  const workerUrl = `${workerBase}/fetch?url=${encodeURIComponent(targetUrl)}`;
  const maxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const { stdout, stderr } = await execFileAsync(
    CURL_BIN,
    [
      "-sS",
      "-L",
      "--max-time",
      String(maxTimeSeconds),
      "-A",
      "curl/8.18.0",
      "-H",
      "Accept: */*",
      "-w",
      `\n${CURL_STATUS_MARKER}%{http_code}\n${CURL_CT_MARKER}%{content_type}\n`,
      workerUrl,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const statusIndex = stdout.lastIndexOf(`\n${CURL_STATUS_MARKER}`);
  if (statusIndex === -1) {
    throw new Error(`curl worker fetch missing status marker${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  const body = stdout.slice(0, statusIndex);
  const meta = stdout.slice(statusIndex + 1).trim().split("\n");
  const status = parseInt(meta.find((line) => line.startsWith(CURL_STATUS_MARKER))?.slice(CURL_STATUS_MARKER.length) || "0", 10);
  const contentType = meta.find((line) => line.startsWith(CURL_CT_MARKER))?.slice(CURL_CT_MARKER.length) || "";

  return {
    ok: status >= 200 && status < 300,
    status,
    contentType,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

export async function curlWorkerFetchBuffer(targetUrl, { workerBase, timeoutMs = 15000 } = {}) {
  if (!workerBase) throw new Error("workerBase is required");
  const workerUrl = `${workerBase}/fetch?url=${encodeURIComponent(targetUrl)}`;
  const maxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const { stdout, stderr } = await execFileAsync(
    CURL_BIN,
    [
      "-sS",
      "-L",
      "--max-time",
      String(maxTimeSeconds),
      "-A",
      "curl/8.18.0",
      "-H",
      "Accept: */*",
      "-w",
      `\n${CURL_STATUS_MARKER}%{http_code}\n${CURL_CT_MARKER}%{content_type}\n`,
      workerUrl,
    ],
    {
      encoding: "buffer",
      maxBuffer: 25 * 1024 * 1024,
    }
  );

  const marker = Buffer.from(`\n${CURL_STATUS_MARKER}`);
  const statusIndex = stdout.lastIndexOf(marker);
  if (statusIndex === -1) {
    const errText = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : String(stderr || "").trim();
    throw new Error(`curl worker fetch missing status marker${errText ? `: ${errText}` : ""}`);
  }

  const body = stdout.subarray(0, statusIndex);
  const meta = stdout.subarray(statusIndex + 1).toString("utf8").trim().split("\n");
  const status = parseInt(meta.find((line) => line.startsWith(CURL_STATUS_MARKER))?.slice(CURL_STATUS_MARKER.length) || "0", 10);
  const contentType = meta.find((line) => line.startsWith(CURL_CT_MARKER))?.slice(CURL_CT_MARKER.length) || "";

  return {
    ok: status >= 200 && status < 300,
    status,
    contentType,
    buffer: async () => body,
    text: async () => body.toString("utf8"),
    json: async () => JSON.parse(body.toString("utf8")),
  };
}

export async function curlFetch(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const maxTimeSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const headerArgs = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value == null) continue;
    headerArgs.push("-H", `${name}: ${value}`);
  }

  const { stdout, stderr } = await execFileAsync(
    CURL_BIN,
    [
      "-sS",
      "-L",
      "--max-time",
      String(maxTimeSeconds),
      ...headerArgs,
      "-w",
      `\n${CURL_STATUS_MARKER}%{http_code}\n${CURL_CT_MARKER}%{content_type}\n`,
      url,
    ],
    { maxBuffer: 10 * 1024 * 1024 }
  );

  const statusIndex = stdout.lastIndexOf(`\n${CURL_STATUS_MARKER}`);
  if (statusIndex === -1) {
    throw new Error(`curl fetch missing status marker${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  const body = stdout.slice(0, statusIndex);
  const meta = stdout.slice(statusIndex + 1).trim().split("\n");
  const status = parseInt(meta.find((line) => line.startsWith(CURL_STATUS_MARKER))?.slice(CURL_STATUS_MARKER.length) || "0", 10);
  const contentType = meta.find((line) => line.startsWith(CURL_CT_MARKER))?.slice(CURL_CT_MARKER.length) || "";

  return {
    ok: status >= 200 && status < 300,
    status,
    contentType,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

export { undiciRequest, undiciFetch, ProxyAgent };
