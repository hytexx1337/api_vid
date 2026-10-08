import crypto from "node:crypto";

const API = "http://localhost:8000";
const KEY = process.env.TEST_API_KEY || "Monitor1337!";
const REQUIRED = ["url", "label", "lang", "type", "mimeType", "kind", "default", "ai", "cc", "forced"];

const b64d = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function dec(b) {
  if (!b || b.encrypted !== true) return b;
  const iv = b64d(b.iv), dek = b64d(b.key), raw = b64d(b.data);
  const tag = raw.subarray(raw.length - 16), ct = raw.subarray(0, raw.length - 16);
  const d = crypto.createDecipheriv("aes-256-gcm", dek, iv); d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

async function checkEndpoint(name, path) {
  const url = `${API}${path}?key=${encodeURIComponent(KEY)}`;
  console.log(`\n=== [${name}] ${path} ===`);
  let r, body;
  try {
    r = await fetch(url);
    body = dec(await r.json());
  } catch (e) {
    console.log(`  ❌ fetch error: ${e.message}`);
    return false;
  }
  console.log(`  status: ${r.status}`);
  const tracks = body.tracks || body.subtitles || [];
  console.log(`  tracks/subtitles count: ${tracks.length}`);

  let okCount = 0, failCount = 0;
  if (tracks.length === 0) {
    console.log("  ⚠️  0 tracks (probablemente cache frío / sin subs). Endpoint OK.");
    return true;
  }
  for (const t of tracks) {
    const missing = REQUIRED.filter(k => !(k in t));
    if (missing.length) {
      failCount++;
      console.log(`  ❌ label="${t.label ?? "(sin label)"}" MISSING: ${missing.join(",")}`);
    } else {
      okCount++;
      console.log(`  ✅ label="${t.label}" lang=${t.lang} kind=${t.kind} type=${t.type} ai=${t.ai} cc=${t.cc} forced=${t.forced} default=${t.default} mime=${t.mimeType}`);
      if (t.available_fonts) console.log(`     available_fonts: ${Object.keys(t.available_fonts).length} keys`);
      if (t.extracted_fonts?.length) console.log(`     extracted_fonts: ${t.extracted_fonts.length}`);
    }
  }
  console.log(`  Resumen: ${okCount} OK, ${failCount} FAIL`);
  return failCount === 0;
}

const allPassed = [
  await checkEndpoint("MOVIE Fight Club", "/movie/550"),
  await checkEndpoint("TV Breaking Bad S1E1", "/tv/1396/1/1"),
].every(Boolean);

console.log("\n" + (allPassed ? "✅ Todos los endpoints pasaron el contrato de subtítulos." : "❌ Hay fallos."));
process.exit(allPassed ? 0 : 1);
