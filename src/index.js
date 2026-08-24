import express from "express";
import { PORT, pickAllowedOrigin, API_KEY } from "./config/constants.js";
import proxyRouter from "./routes/proxy.js";
import streamsRouter from "./routes/streams.js";
import subtitlesRouter from "./routes/subtitles.js";
import providersRouter from "./routes/providers.js";
import debugRouter from "./routes/debug.js";
import adminRouter from "./routes/admin.js";
import { scheduleAnimeVerifier } from "./lib/stream-verifier.js";

const app = express();
app.set("trust proxy", 1);

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = pickAllowedOrigin(origin);
  res.setHeader("Access-Control-Allow-Origin", allowed);
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Cache-Control");
  res.setHeader("Vary", "Origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Cache-Control Enforcement Hook ───────────────────────────────────────────
app.use((req, res, next) => {
  const origSetHeader = res.setHeader.bind(res);
  res.setHeader = function (name, value) {
    if (res._ccFinal && typeof name === "string" && name.toLowerCase() === "cache-control") {
      return origSetHeader("Cache-Control", res._ccFinal);
    }
    return origSetHeader(name, value);
  };
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, statusMessageOrHeaders, headersOrUndefined) {
    let headers;
    if (typeof statusMessageOrHeaders === "object" && statusMessageOrHeaders !== null) headers = statusMessageOrHeaders;
    else if (typeof headersOrUndefined === "object" && headersOrUndefined !== null) headers = headersOrUndefined;
    else headers = {};
    if (res._ccFinal) {
      headers["Cache-Control"] = res._ccFinal;
      origSetHeader("Cache-Control", res._ccFinal);
    }
    if (typeof statusMessageOrHeaders === "string") return origWriteHead(statusCode, statusMessageOrHeaders, headers);
    return origWriteHead(statusCode, headers);
  };
  const origEnd = res.end.bind(res);
  res.end = function (chunkOrCb, encodingOrCb, cbOrUndefined) {
    if (res._ccFinal && !res.headersSent) origSetHeader("Cache-Control", res._ccFinal);
    return origEnd(chunkOrCb, encodingOrCb, cbOrUndefined);
  };
  next();
});

// ── Auth middleware ──────────────────────────────────────────────────────────
const PROXY_PATH = /^\/(sealed|proxy|ts-proxy|fetch|mp4-proxy|ghost-proxy|upn-stream\.m3u8|upn-seg|generic-stream\.m3u8|generic-media\.m3u8|generic-seg|vixsrc-stream\.m3u8|vixsrc-seg\.m3u8|vixsrc-seg|dash-proxy\.mpd|dash-seg|aes-key|subs|admin)(\/|$|\?)/;
if (API_KEY) {
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    if (PROXY_PATH.test(req.path)) return next();
    const key = req.headers["x-api-key"] ?? req.query.key;
    if (key === API_KEY) return next();
    return res.status(401).json({ error: "Unauthorized" });
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ ok: true, pid: process.pid }));
app.use(proxyRouter);
app.use(streamsRouter);
app.use(subtitlesRouter);
app.use(providersRouter);
app.use(debugRouter);
app.use(adminRouter);

// ── Errors ─────────────────────────────────────────────────────────────────────
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err.message));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

// ── Start ──────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`api_vid running on http://localhost:${PORT} [pid ${process.pid}]`);
  scheduleAnimeVerifier();
});

function shutdown() {
  server.close(() => { console.log(`[pid ${process.pid}] Server closed`); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
