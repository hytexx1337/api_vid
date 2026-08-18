/**
 * cr-login.mjs — Extrae tokens de Crunchyroll via login automatizado con Puppeteer.
 * Intercepta el POST /auth/v1/token para capturar Authorization header, body y refresh_token.
 * Escribe el resultado en .env automáticamente.
 *
 * Uso: node cr-login.mjs
 */

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

puppeteerExtra.use(StealthPlugin());

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ENV_PATH   = resolve(SCRIPT_DIR, "..", "..", ".env");
const COOKIES_PATH = resolve(SCRIPT_DIR, "..", "..", "subs-cache", "cr-cookies.json");

const email    = process.env.CR_EMAIL    ?? readEnv("CR_EMAIL");
const password = process.env.CR_PASSWORD ?? readEnv("CR_PASSWORD");

function readEnv(key) {
  try {
    const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
    const line  = lines.find(l => l.startsWith(key + "="));
    return line?.split("=").slice(1).join("=").trim() ?? null;
  } catch { return null; }
}

if (!email || !password) {
  console.error("Falta CR_EMAIL o CR_PASSWORD en .env");
  process.exit(1);
}

console.log("Iniciando browser...");

const browser = await puppeteerExtra.launch({
  headless: true,
  defaultViewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});

const page = await browser.newPage();

let captured = null;

// Interceptar requests para capturar el POST /auth/v1/token
await page.setRequestInterception(true);

page.on("request", req => {
  req.continue();
});

page.on("response", async res => {
  const url = res.url();
  if (!url.includes("/auth/v1/token")) return;
  if (res.request().method() !== "POST") return;

  try {
    const reqHeaders = res.request().headers();
    const reqBody    = res.request().postData() ?? "";
    const json       = await res.json().catch(() => null);

    if (json?.refresh_token) {
      captured = {
        basicAuth:     reqHeaders["authorization"]?.replace("Basic ", "") ?? null,
        refreshToken:  json.refresh_token,
        etpRt:         reqHeaders["cookie"]?.match(/etp_rt=([^;]+)/)?.[1] ?? null,
        deviceId:      reqHeaders["cookie"]?.match(/device_id=([^;]+)/)?.[1] ?? null,
        anonymousId:   reqHeaders["etp-anonymous-id"] ?? null,
        body:          reqBody,
      };
      console.log("\n✅ Token capturado!");
      console.log("  refresh_token:", captured.refreshToken);
      console.log("  authorization:", captured.basicAuth?.slice(0, 20) + "...");
      console.log("  body:", captured.body);
    }
  } catch {}
});

// Ir al login
console.log("Navegando a Crunchyroll...");
await page.goto("https://www.crunchyroll.com/login", { waitUntil: "networkidle2", timeout: 30000 });

// Completar formulario
console.log("Completando formulario de login...");
await page.waitForSelector('input[name="username"], input[type="email"]', { timeout: 15000 });

const emailInput = await page.$('input[name="username"]') ?? await page.$('input[type="email"]');
const passInput  = await page.$('input[name="password"]') ?? await page.$('input[type="password"]');

await emailInput.click({ clickCount: 3 });
await emailInput.type(email, { delay: 50 });
await passInput.click({ clickCount: 3 });
await passInput.type(password, { delay: 50 });

await passInput.press("Enter");

console.log("Esperando respuesta de auth (máx 30s)...");

// Esperar hasta que se capture el token o timeout
const deadline = Date.now() + 30000;
while (!captured && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 500));
}

// Guardar cookies completas del browser en cr-cookies.json (para playback/v3)
const browserCookies = await page.cookies();
writeFileSync(COOKIES_PATH, JSON.stringify({ cookies: browserCookies, savedAt: Date.now() }, null, 2));
console.log(`\n🍪 ${COOKIES_PATH} actualizado (${browserCookies.length} cookies)`);

await browser.close();

if (!captured) {
  console.error("\n❌ No se capturó el token. Posibles causas: CAPTCHA, credenciales incorrectas, o timeout.");
  process.exit(1);
}

// Actualizar .env
let envContent = "";
try { envContent = readFileSync(ENV_PATH, "utf-8"); } catch {}

function setEnvVar(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, "m");
  return regex.test(content)
    ? content.replace(regex, `${key}=${value}`)
    : content.trimEnd() + `\n${key}=${value}\n`;
}

if (captured.basicAuth)    envContent = setEnvVar(envContent, "CR_BASIC_AUTH",    captured.basicAuth);
if (captured.refreshToken) envContent = setEnvVar(envContent, "CR_REFRESH_TOKEN", captured.refreshToken);
if (captured.deviceId)     envContent = setEnvVar(envContent, "CR_DEVICE_ID",     captured.deviceId);

writeFileSync(ENV_PATH, envContent);

console.log("\n✅ .env actualizado:");
if (captured.basicAuth)    console.log("  CR_BASIC_AUTH    =", captured.basicAuth.slice(0, 20) + "...");
if (captured.refreshToken) console.log("  CR_REFRESH_TOKEN =", captured.refreshToken);
if (captured.deviceId)     console.log("  CR_DEVICE_ID     =", captured.deviceId);
console.log("\nAhora podés correr: node test-cr.mjs");
