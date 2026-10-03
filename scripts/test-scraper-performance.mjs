import test from "node:test";
import assert from "node:assert/strict";

let version = 0;
const freshScraper = () => import(`../src/providers/scraper.js?test=${++version}`);
const json = (value) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("metadata comparte requests y permite reintentar tras un error", async (t) => {
  const scraper = await freshScraper();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    await tick();
    throw new Error("offline");
  });
  const failed = await Promise.allSettled([scraper.getAnilistInfo(1), scraper.getAnilistInfo(1)]);
  assert.ok(failed.every(r => r.status === "rejected"));
  assert.equal(calls, 2); // AniList + ani.zip, no dos veces cada uno.
  t.mock.restoreAll();
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return json({ data: { Media: { idMal: 1, title: { romaji: "Example" } } } });
  });
  assert.equal((await scraper.getAnilistInfo(1)).idMal, 1);
  assert.equal(calls, 3);
});

test("busquedas paralelas conservan desempates y deduplican queries", async (t) => {
  const scraper = await freshScraper();
  const queries = [];
  let releaseFirst;
  const first = new Promise(resolve => { releaseFirst = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query } = JSON.parse(options.body);
    queries.push(query);
    if (query === "Alpha") await first;
    else releaseFirst();
    return json([{ slug: query.toLowerCase(), title: query }]);
  });
  const slugs = await Promise.all([
    scraper.malIdToSlug(2, "Alpha", "Beta"),
    scraper.malIdToSlug(2, "Alpha", "Beta"),
  ]);
  assert.deepEqual(slugs, ["alpha", "alpha"]);
  assert.deepEqual(queries, ["Alpha", "Beta"]);
  assert.equal(await scraper.malIdToSlug(3, "Gamma", "Gamma"), "gamma");
  assert.equal(queries.filter(q => q === "Gamma").length, 1);
});

test("limite global de dos busquedas entre distintos animes", async (t) => {
  const scraper = await freshScraper();
  let active = 0;
  let peak = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { query } = JSON.parse(options.body);
    active++;
    peak = Math.max(peak, active);
    await tick();
    active--;
    return json([{ slug: query.toLowerCase(), title: query }]);
  });
  await Promise.all([10, 11, 12].map(id => scraper.malIdToSlug(id, `Alpha${id}`, `Beta${id}`)));
  assert.equal(peak, 2);
});

test("mantiene validacion de anio y fallback de slug sin resultados", async (t) => {
  const scraper = await freshScraper();
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      const { query } = JSON.parse(options.body);
      return json(query === "Missing" ? [] : [
        { slug: "old", title: "Example" },
        { slug: "new", title: "Example" },
      ]);
    }
    if (options.method === "HEAD") {
      assert.ok(url.endsWith("/missing/1"));
      return new Response(null);
    }
    return new Response(`<span>${url.endsWith("/old") ? 1990 : 2026}</span>`);
  });
  assert.equal(await scraper.malIdToSlug(20, "Example", null, 2026), "new");
  assert.equal(await scraper.malIdToSlug(21, "Missing"), "missing");
});

test("slug empieza antes de terminar offset y pagina espera ambos", async (t) => {
  const scraper = await freshScraper();
  let releaseOffset;
  const offsetGate = new Promise(resolve => { releaseOffset = resolve; });
  let offsetDone = false;
  let offsetCalls = 0;
  let searchStarted = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("graphql.anilist")) {
      const { query } = JSON.parse(options.body);
      if (query.includes("relations")) {
        offsetCalls++;
        await offsetGate;
        offsetDone = true;
      }
      return json({ data: { Media: { idMal: 30, title: { romaji: "Example" }, relations: { edges: [] } } } });
    }
    if (url.endsWith("/api/search")) {
      searchStarted = true;
      assert.equal(offsetDone, false);
      releaseOffset();
      return json([{ slug: "example", title: "Example" }]);
    }
    assert.equal(offsetDone, true);
    assert.ok(url.endsWith("/example/4"));
    return new Response('DUB:[{server:"HLS",url:"https://cdn.test/play/dub"}],SUB:[{server:"HLS",url:"https://cdn.test/play/sub"}]');
  });
  const [result, offset] = await Promise.all([
    scraper.getLatinoStream(30, 4),
    scraper.getEpisodeOffset(30),
  ]);
  assert.equal(searchStarted, true);
  assert.equal(offsetCalls, 1);
  assert.equal(offset, 0);
  assert.equal(result.episodeOnPage, 4);
  assert.deepEqual(result.streams.map(s => s.type), ["dub", "sub"]);
});

test("split-cour conserva el ajuste por episodio cero especial", async (t) => {
  const scraper = await freshScraper();
  const pages = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("graphql.anilist")) {
      return json({ data: { Media: {
        idMal: 40,
        title: { romaji: "Example" },
        relations: { edges: [{
          relationType: "PREQUEL",
          node: { idMal: 39, format: "TV", episodes: 12, title: { romaji: "Example" } },
        }] },
      } } });
    }
    if (url.endsWith("/api/search")) return json([{ slug: "example", title: "Example" }]);
    pages.push({ url, method: options.method || "GET" });
    if (options.method === "HEAD") {
      assert.ok(url.endsWith("/example/13"));
      return new Response(null);
    }
    if (url.endsWith("/example/0")) return new Response('TV Anime SUB:[]');
    assert.ok(url.endsWith("/example/15"));
    return new Response('SUB:[{server:"HLS",url:"https://cdn.test/play/sub"}]');
  });
  const result = await scraper.getLatinoStream(40, 4);
  assert.equal(result.offset, 11);
  assert.equal(result.episodeOnPage, 15);
  assert.equal(pages.length, 3);
  assert.equal(await scraper.getEpisodeOffset(40), 11);
  assert.equal(pages.length, 3);
});
