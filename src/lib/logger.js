const LEVELS = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

function parseBoolEnv(rawValue, fallback = false) {
  const v = String(rawValue ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

const configuredLevel = String(process.env.LOG_LEVEL || "info").trim().toLowerCase();
const CURRENT_LEVEL = LEVELS[configuredLevel] ?? LEVELS.info;

export function shouldLog(level) {
  return CURRENT_LEVEL >= (LEVELS[level] ?? LEVELS.info);
}

export function envFlag(name, fallback = false) {
  return parseBoolEnv(process.env[name], fallback);
}

export const log = {
  error: (...args) => { if (shouldLog("error")) console.error(...args); },
  warn: (...args) => { if (shouldLog("warn")) console.warn(...args); },
  info: (...args) => { if (shouldLog("info")) console.log(...args); },
  debug: (...args) => { if (shouldLog("debug")) console.log(...args); },
  trace: (...args) => { if (shouldLog("trace")) console.log(...args); },
};

export function shortUrl(raw, max = 96) {
  const input = String(raw || "");
  if (!input) return "";
  try {
    const u = new URL(input);
    const safe = `${u.origin}${u.pathname}${u.search ? "?..." : ""}`;
    if (safe.length <= max) return safe;
    return `${safe.slice(0, Math.max(12, max - 3))}...`;
  } catch {
    if (input.length <= max) return input;
    return `${input.slice(0, Math.max(12, max - 3))}...`;
  }
}

export const LOG_PERF_VERBOSE = envFlag("LOG_PERF_VERBOSE", shouldLog("debug"));
export const LOG_PROVIDER_DEBUG = envFlag("LOG_PROVIDER_DEBUG", shouldLog("debug"));
export const LOG_VERIFY = envFlag("LOG_VERIFY", shouldLog("debug"));
