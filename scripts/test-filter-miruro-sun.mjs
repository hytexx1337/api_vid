import crypto from "node:crypto";
const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";
const b64d = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function dec(b) {
  if (!b || b.encrypted !== true) return b;
  const iv = b64d(b.iv), dek = b64d(b.key), raw = b64d(b.data);
  const tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

for (const ep of [
  { name: "139587/1 Catgirl", url: `${API}/anime/139587/1?key=${encodeURIComponent(KEY)}` },
  { name: "170130/2 Frieren", url: `${API}/anime/170130/2?key=${encodeURIComponent(KEY)}` },
]) {
  console.log(`\n========== ${ep.name} ==========`);
  const r = await fetch(ep.url);
  const body = dec(await r.json());
  console.log("status:", r.status, " streams finales:", body.streams?.length);

  const miruros = (body.streams || []).filter(s => (s.originalProvider || "").startsWith("miruro"));
  console.log("Miruros sobrevivientes:", miruros.length);
  miruros.forEach(s => console.log(`   - ${s.originalProvider}  /  ${s.lang}  → display [${s.provider}]`));

  const bad = (body.streams || []).filter(s =>
    /^miruro(-|_)?sun$/i.test(s.originalProvider || "") && /JAP(-|_)?EN(-|_)?HS/i.test(s.lang || "")
  );
  console.log(`miruro-sun × JAP-EN-HS encontrados: ${bad.length}  ${bad.length ? "❌ FAIL" : "✅ OK (eliminado)"}`);

  console.log("\nLista final ordenada:");
  (body.streams || []).forEach((s, i) => {
    console.log(`   #${String(i + 1).padStart(2, "0")}  ${String(s.originalProvider || "").padEnd(18, " ")}  ${String(s.lang || "").padEnd(12, " ")}  → [${s.provider}]`);
  });
}
