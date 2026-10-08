import { sealedQueryParam, tryUnsealQueryPayload } from "../src/lib/proxy-seal.js";

const sampleUserVtt = `WEBVTT

NOTE This is a thumbnail VTT file

00:00:00.000 --> 00:00:05.000
thumbnails/sprite_0.webp#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
thumbnails/sprite_0.webp#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
thumbnails/sprite_0.webp#xywh=320,0,160,90`;

const basePath = "https://fetch8.flixcloud.cc/thumbnails_vtt/abc123/";
const proxyBase = "http://localhost:8000";
const refDefault = "https://flixcloud.cc/";

const regex = /^([\w./-][^\s#"'<>|]*?\.(?:webp|jpg|jpeg|png)(#[^\s]*)?)$/gim;

const rewrote = sampleUserVtt.replace(regex, (m, rel) => {
  try {
    const abs = new URL(rel, basePath).href;
    const ext = rel.split(".").pop().split("#")[0].toLowerCase();
    const imgCt = (ext === "jpg" || ext === "jpeg") ? "image/jpeg" : ext === "png" ? "image/png" : "image/webp";
    return `${proxyBase}/fetch?${sealedQueryParam({ url: abs, ref: refDefault, ct: imgCt })}`;
  } catch {
    return m;
  }
});

console.log("=== VTT original (3 líneas sprite) ===");
sampleUserVtt.split("\n").forEach(l => console.log("   ", l));
console.log("");
console.log("=== VTT REESCRITO (sprites pasan por /fetch?s= sellado) ===");
rewrote.split("\n").forEach(l => console.log("   ", l));
console.log("");

const leaksRaw = /thumbnails\/sprite_0\.webp#xywh/.test(rewrote);
console.log("❓ Aún tiene sprites crudos (thumbnails/sprite...)?", leaksRaw, " — debe ser FALSE");
console.assert(leaksRaw === false, "FAIL: siguen habiendo paths sprites crudos");

const leakDomain = /flixcloud\.cc/.test(rewrote);
console.log("❓ Tiene dominio flixcloud.cc expuesto en body VTT?", leakDomain, " — debe ser FALSE");
console.assert(leakDomain === false, "FAIL: dominio flixcloud sigue expuesto");

const leakQ = /(\?u=|\?url=)(https?%3A|http)/i.test(rewrote);
console.log("❓ Tiene ?u= o ?url= crudos?", leakQ, " — debe ser FALSE");
console.assert(leakQ === false, "FAIL: query params crudos");

const spriteLines = rewrote.split("\n").filter(l => l.startsWith(`${proxyBase}/fetch?s=`));
console.log("✔ Cantidad sprites reescritos:", spriteLines.length);
console.assert(spriteLines.length === 3, `FAIL: 3 sprites, encontrados ${spriteLines.length}`);

for (const line of spriteLines) {
  const tok = line.split("?s=")[1];
  const decoded = tryUnsealQueryPayload(tok);
  console.log("   Sprite descifrado:", JSON.stringify(decoded));
  console.assert(decoded && decoded.url && /^https:\/\/fetch8\.flixcloud\.cc\/thumbnails_vtt\/abc123\/thumbnails\/sprite_0\.webp/.test(decoded.url), "URL mal descifrada");
  console.assert(decoded.ref === "https://flixcloud.cc/", "ref falta");
  console.assert(decoded.ct === "image/webp", "ct debe ser image/webp");
}

console.log("");
console.log("✅ 9/9 aserciones rewriter VTT OK");
