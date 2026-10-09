import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";

const tempDir = mkdtempSync(path.join(tmpdir(), "api-vid-ovh-"));
process.env.STREAM_CACHE_DB_PATH = path.join(tempDir, "stream-cache.db");
process.env.API_KEY = "test-key";
process.env.OVH_INGEST_KEY = "ingest-key";
process.env.OVH_HLS_SIGNING_KEY = "secret";
process.env.OVH_ORIGIN_URL = "https://origin.zenkai.live";
process.env.OVH_HLS_URL_TTL_SECONDS = "21600";
process.env.R2_WORKER_BASE = "https://cdn.zenkai.live";
process.env.R2_SEAL_SECRET = "r2-secret";

const ovh = await import("../src/lib/ovh-hls.js");
const cache = await import("../src/lib/cache.js");
const sync = await import("../src/lib/ovh-sync.js");
const { normalizeSubtitleTracks } = await import("../src/lib/subtitles.js");
const { buildZenkaiStreams, selectPreferredZenkaiStreams } = await import("../src/routes/streams.js");
const { default: adminRouter } = await import("../src/routes/admin.js");

const audioTracks = [
  { id: "ja", lang: "ja-JP", code: "JAP-SUB", label: "Japonés", original: true, default: true },
  { id: "en", lang: "en-US", code: "ENG-DUB", label: "Inglés", dub: true },
];

const publishedEpisode = {
  slug: "112641-8-multi",
  status: "published",
  provider: "zenkai",
  storageProvider: "ovh",
  hls: {
    available: true,
    master: "112641-8-multi/master.m3u8",
    files: ["master.m3u8", "seg-00001.ts"],
    playlists: ["master.m3u8"],
    size_bytes: 123456,
  },
  subtitles: [
    { language: "es-419", filename: "112641-8-multi-es-419.ass", type: "ass", url: "https://origin.zenkai.live/subs/112641-8-multi-es-419.ass" },
    { language: "en-US", filename: "112641-8-multi-en-US_cc.vtt", type: "vtt", url: "https://origin.zenkai.live/subs/112641-8-multi-en-US_cc.vtt" },
    { language: "en-US", filename: "112641-8-multi-en-US_signs_en-US.ass", type: "ass", url: "https://origin.zenkai.live/subs/112641-8-multi-en-US_signs_en-US.ass" },
  ],
  thumbnails: {
    crunchy: { vtt: "https://origin.zenkai.live/thumbs/anime/112641/8/crunchy/thumbnails.vtt", sprites: ["https://origin.zenkai.live/thumbs/anime/112641/8/crunchy/sprite-00001.jpg"] },
  },
};

test("firma OVH compatible con Nginx", () => {
  const url = ovh.signOvhHlsUrl("112641-8-multi", { nowSeconds: 1700000000, ttlSeconds: 21600, secret: "secret" });
  const expiry = 1700000000 + 21600;
  const token = crypto.createHash("md5").update(`${expiry}/112641-8-multi secret`, "utf8").digest("base64url");
  assert.equal(url, `https://origin.zenkai.live/hls/${token}/${expiry}/112641-8-multi/master.m3u8`);
});

test("normaliza episodio OVH publicado, subtitulos y thumbnails", () => {
  const normalized = ovh.normalizeOvhEpisode(publishedEpisode);
  assert.equal(ovh.isOvhEpisodePublished(normalized), true);
  assert.equal(normalized.subtitles.length, 3);
  assert.equal(ovh.pickOvhThumbnailVtt(normalized.thumbnails), "https://origin.zenkai.live/thumbs/anime/112641/8/crunchy/thumbnails.vtt");

  const tracks = normalizeSubtitleTracks(normalized.subtitles);
  assert.equal(tracks.find((t) => t.url.includes("_cc.vtt")).cc, true);
  assert.equal(tracks.find((t) => t.url.includes("_signs_")).forced, false);
  assert.equal(tracks.find((t) => t.url.endsWith(".ass")).type, "ass");
});

test("parsea audioTracks OVH desde master HLS", () => {
  const tracks = ovh.parseOvhAudioTracksFromMaster(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en-US",NAME="English",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a0.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="es-419",NAME="Español (América Latina)",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="a1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="ja-JP",NAME="日本語",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="a2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO="audio"
v0.m3u8`);
  assert.deepEqual(tracks, [
    { id: "en", lang: "en-US", code: "ENG-DUB", label: "Inglés", default: true, dub: true },
    { id: "es-MX", lang: "es-MX", code: "ESP-LAT", label: "Latino", default: false, dub: true },
    { id: "ja", lang: "ja-JP", code: "JAP-SUB", label: "Japonés", default: false, original: true },
  ]);
});

test("cliente OVH maneja lookup, 404 temporal y auth errors", async () => {
  const lookup = await ovh.lookupOvhEpisodes(["112641-8-multi"], {
    fetchImpl: async (_url, opts) => {
      assert.equal(opts.method, "POST");
      assert.equal(opts.headers["X-Ingest-Key"], "ingest-key");
      assert.deepEqual(JSON.parse(opts.body).slugs, ["112641-8-multi"]);
      return new Response(JSON.stringify({ episodes: [publishedEpisode], not_found: [] }), { status: 200 });
    },
  });
  assert.equal(lookup.ok, true);
  assert.equal(lookup.episodes.length, 1);

  const notReady = await ovh.fetchOvhEpisode("112641-8-multi", {
    fetchImpl: async () => new Response("{}", { status: 404 }),
    retries: 0,
  });
  assert.equal(notReady.temporary, true);
  assert.equal(notReady.ok, false);

  const auth = await ovh.fetchOvhEpisode("112641-8-multi", {
    fetchImpl: async () => new Response("{}", { status: 403 }),
    retries: 0,
  });
  assert.equal(auth.authError, true);
});

test("persistencia OVH pendiente y publicada en SQLite", () => {
  assert.equal(cache.upsertOvhArchive({
    animeId: 112641,
    episode: 8,
    lang: "MULTI",
    slug: "112641-8-multi",
    sourceProvider: "crunchyroll-downloader",
    status: "pending",
    tracks: { audioTracks, subtitleTracks: [] },
  }), true);
  assert.deepEqual(cache.getOvhArchive(112641, 8), {});

  assert.equal(cache.upsertOvhArchive({
    animeId: 112641,
    episode: 8,
    lang: "MULTI",
    slug: "112641-8-multi",
    sourceProvider: "crunchyroll-downloader",
    status: "published",
    tracks: { audioTracks, subtitleTracks: [] },
    subtitles: ovh.normalizeOvhEpisode(publishedEpisode).subtitles,
    thumbnails: ovh.normalizeOvhEpisode(publishedEpisode).thumbnails,
    hls: ovh.normalizeOvhEpisode(publishedEpisode).hls,
  }), true);
  const row = cache.getOvhArchive(112641, 8).MULTI;
  assert.equal(row.status, "published");
  assert.equal(row.slug, "112641-8-multi");
  assert.equal(row.audioTracks.length, 2);
  assert.equal(row.subtitles.length, 3);
});

test("registro admin OVH pendiente y activacion idempotente invalidan cache", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("{}", { status: 404 });
    const app = express();
    app.use(adminRouter);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const payload = {
        animeId: 154587,
        episode: 1,
        lang: "MULTI",
        slug: "154587-1-multi",
        storageProvider: "ovh",
        sourceProvider: "crunchyroll-downloader",
        skipIntro: [0, 90],
        skipOutro: [1320, 1410],
        audioTracks,
        subtitleTracks: [{ lang: "es-MX", label: "Latino", type: "ass", kind: "subtitles" }],
      };
      const pending = await originalFetch(`${base}/admin/api/register-ovh-archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "test-key" },
        body: JSON.stringify(payload),
      });
      assert.equal(pending.status, 202);
      assert.equal((await pending.json()).status, "pending");

      cache.cacheSet("resp:streams:anime:v19:154587:1:http://localhost:1337", "stale", 60_000);
      globalThis.fetch = async () => new Response(JSON.stringify({ ...publishedEpisode, slug: "154587-1-multi" }), { status: 200 });
      const synced = await originalFetch(`${base}/admin/api/sync-ovh-archive/154587-1-multi`, {
        method: "POST",
        headers: { "x-api-key": "test-key" },
      });
      const body = await synced.json();
      assert.equal(synced.status, 200);
      assert.equal(body.current.status, "published");
      assert.equal(cache.cacheGet("resp:streams:anime:v19:154587:1:http://localhost:1337"), null);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discovery OVH consulta y persiste un episodio publicado que no estaba en SQLite", async () => {
  assert.deepEqual(cache.getOvhArchive(777, 3), {});
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes("/v1/episodes/")) {
        assert.match(String(url), /\/v1\/episodes\/777-3-multi$/);
        assert.equal(opts.headers["X-Ingest-Key"], "ingest-key");
        return new Response(JSON.stringify({ ...publishedEpisode, slug: "777-3-multi" }), { status: 200 });
      }
      return new Response(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="en-US",NAME="English",DEFAULT=YES,URI="a0.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="es-419",NAME="Español (América Latina)",DEFAULT=NO,URI="a1.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="ja-JP",NAME="日本語",DEFAULT=NO,URI="a2.m3u8"`, { status: 200 });
    };
    const result = await sync.discoverOvhArchiveForEpisode(777, 3, { retries: 0, timeoutMs: 1000 });
    assert.equal(result.status, "published");

    const row = cache.getOvhArchive(777, 3).MULTI;
    assert.equal(row.status, "published");
    assert.equal(row.slug, "777-3-multi");
    assert.equal(row.subtitles.length, 3);
    assert.equal(row.audioTracks.length, 3);
    assert.equal(row.audioTracks[1].code, "ESP-LAT");
    assert.equal(cache.getOvhArchiveBySlug("777-3-multi").hls.available, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("streams Zenkai priorizan OVH sobre R2 sin borrar externos", () => {
  const fullAudioTracks = [
    ...audioTracks,
    { id: "es-MX", lang: "es-MX", code: "ESP-LAT", label: "Latino", dub: true },
  ];
  const ovhStreams = buildZenkaiStreams(
    {
      MULTI: { slug: "112641-8-multi", sourceProvider: "r2", audioTracks: fullAudioTracks },
      "ENG-DUB": { slug: "112641-8-eng-dub", sourceProvider: "r2" },
      "ESP-LAT": { slug: "112641-8-esp-lat", sourceProvider: "r2" },
    },
    {},
    { MULTI: { status: "published", slug: "112641-8-multi", sourceProvider: "crunchyroll-downloader", audioTracks: fullAudioTracks } }
  );
  assert.equal(ovhStreams.length, 4);
  const selected = selectPreferredZenkaiStreams([
    ...ovhStreams,
    { url: "https://example.test/ext.m3u8", proxy_url: "https://example.test/ext.m3u8", lang: "ESP-LAT", originalProvider: "animeav1", provider: "animeav1", type: "hls" },
  ]);
  assert.equal(selected.filter((s) => s.originalProvider === "zenkai").length, 1);
  assert.equal(selected.find((s) => s.originalProvider === "zenkai").storageProvider, "ovh");
  assert.equal(selected.some((s) => s.storageProvider === "r2" && s.lang === "ENG-DUB"), false);
  assert.equal(selected.some((s) => s.storageProvider === "r2" && s.lang === "ESP-LAT"), false);
  assert.equal(selected.some((s) => s.originalProvider === "animeav1"), true);
  assert.equal(selected.find((s) => s.storageProvider === "ovh").verifyKey, "ovh:112641-8-multi");
});

test("sync directo activa un registro OVH y conserva metadatos MULTI reales", async () => {
  const record = {
    animeId: 999,
    episode: 2,
    lang: "MULTI",
    slug: "999-2-multi",
    sourceProvider: "crunchyroll-downloader",
    status: "pending",
    tracks: { audioTracks, subtitleTracks: [{ lang: "en-US", label: "English", type: "ass", kind: "subtitles" }] },
  };
  cache.upsertOvhArchive(record);
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ ...publishedEpisode, slug: "999-2-multi" }), { status: 200 });
    const result = await sync.syncOvhArchive("999-2-multi", { retries: 0 });
    assert.equal(result.status, "published");
    const row = cache.getOvhArchive(999, 2).MULTI;
    assert.equal(row.audioTracks[0].code, "JAP-SUB");
    assert.equal(row.subtitleTracks[0].label, "English");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
