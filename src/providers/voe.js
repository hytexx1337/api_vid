const VOE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  Referer: "https://voe.sx/",
};
const VOE_TIMEOUT_MS = 10000;
const VOE_REDIRECT_RE = /window\.location\.href\s*=\s*['"]([^'"]+)['"]/i;
const VOE_JSON_RE = /<script type="application\/json">\["([^"]+)"\]<\/script>/i;
const VOE_ALTCHA_RE = /altcha-widget|Confirm you(?:'|&#039;|’)re human/i;

function voeRot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const base = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function voeCharShift(s, shift) {
  return [...s].map((c) => String.fromCharCode(c.charCodeAt(0) - shift)).join("");
}

function voeDecryptF7(blob) {
  let v = voeRot13(blob);
  for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) v = v.split(p).join("_");
  v = v.replace(/_/g, "");
  v = Buffer.from(v, "base64").toString("utf8");
  v = voeCharShift(v, 3);
  v = v.split("").reverse().join("");
  v = Buffer.from(v, "base64").toString("utf8");
  return JSON.parse(v);
}

function getSetCookiePreview(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map((cookie) => cookie.split(";")[0]);
  }
  const single = headers.get("set-cookie");
  return single ? [single.split(";")[0]] : [];
}

function summarizeHtml(html) {
  return {
    title: html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null,
    redirectUrl: html.match(VOE_REDIRECT_RE)?.[1] ?? null,
    hasJsonBlob: VOE_JSON_RE.test(html),
    hasAltcha: VOE_ALTCHA_RE.test(html),
    snippet: html.slice(0, 220).replace(/\s+/g, " ").trim(),
  };
}

async function fetchVoeStep(url) {
  const response = await fetch(url, {
    headers: VOE_HEADERS,
    signal: AbortSignal.timeout(VOE_TIMEOUT_MS),
  });
  const html = await response.text();
  return {
    url,
    finalUrl: response.url,
    status: response.status,
    ok: response.ok,
    cookies: getSetCookiePreview(response.headers),
    html,
    ...summarizeHtml(html),
  };
}

async function inspectVoeAttempt(embedUrl) {
  const firstHop = await fetchVoeStep(embedUrl);
  const secondHopUrl = firstHop.redirectUrl && firstHop.redirectUrl !== embedUrl ? firstHop.redirectUrl : null;
  const secondHop = secondHopUrl ? await fetchVoeStep(secondHopUrl) : null;
  const terminalHop = secondHop ?? firstHop;
  const jsonBlob = terminalHop.html.match(VOE_JSON_RE)?.[1] ?? null;

  if (!terminalHop.ok) {
    return { ok: false, firstHop, secondHop, result: null, reason: `HTTP ${terminalHop.status}` };
  }
  if (!jsonBlob) {
    return {
      ok: false,
      firstHop,
      secondHop,
      result: null,
      reason: terminalHop.hasAltcha ? "challenge" : "json_missing",
    };
  }

  try {
    const data = voeDecryptF7(jsonBlob);
    if (!data?.source) {
      return { ok: false, firstHop, secondHop, result: null, reason: "source_missing" };
    }
    return {
      ok: true,
      firstHop,
      secondHop,
      result: {
        url: data.source,
        directUrl: data.direct_access_url || null,
        thumbnailJpg: data.thumbnail || null,
      },
      reason: null,
    };
  } catch (error) {
    return {
      ok: false,
      firstHop,
      secondHop,
      result: null,
      reason: `decrypt_error:${error.message}`,
    };
  }
}

export async function inspectVoeEmbed(embedUrl) {
  try {
    return await inspectVoeAttempt(embedUrl);
  } catch (error) {
    return {
      ok: false,
      firstHop: null,
      secondHop: null,
      result: null,
      reason: error.message,
    };
  }
}

export async function voeToM3U8(embedUrl, attempt = 0) {
  try {
    const inspected = await inspectVoeAttempt(embedUrl);
    return inspected.ok ? inspected.result : null;
  } catch (e) {
    if (attempt === 0) return voeToM3U8(embedUrl, 1);
    return null;
  }
}

if (process.argv[1]?.includes("voe.js")) {
  const urls = process.argv.slice(2).filter((arg) => /^https?:\/\//i.test(arg));
  if (urls.length) {
    const results = [];
    for (const url of urls) {
      const debug = await inspectVoeEmbed(url);
      results.push({
        embedUrl: url,
        ok: debug.ok,
        reason: debug.reason,
        firstHop: debug.firstHop && {
          url: debug.firstHop.url,
          finalUrl: debug.firstHop.finalUrl,
          status: debug.firstHop.status,
          title: debug.firstHop.title,
          redirectUrl: debug.firstHop.redirectUrl,
          hasJsonBlob: debug.firstHop.hasJsonBlob,
          hasAltcha: debug.firstHop.hasAltcha,
          cookies: debug.firstHop.cookies,
          snippet: debug.firstHop.snippet,
        },
        secondHop: debug.secondHop && {
          url: debug.secondHop.url,
          finalUrl: debug.secondHop.finalUrl,
          status: debug.secondHop.status,
          title: debug.secondHop.title,
          redirectUrl: debug.secondHop.redirectUrl,
          hasJsonBlob: debug.secondHop.hasJsonBlob,
          hasAltcha: debug.secondHop.hasAltcha,
          cookies: debug.secondHop.cookies,
          snippet: debug.secondHop.snippet,
        },
        result: debug.result,
      });
    }
    console.log(JSON.stringify(results, null, 2));
    process.exit(0);
  }
}
