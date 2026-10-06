# Debug Session: miruro-url-change

Status: [OPEN]

## Problem
Miruro moved to a new URL/site shape. The existing provider script likely no longer matches the current routing and stream extraction flow.

Example URL:
https://barelystarted.miruro.tv/watch/FECCXTDJmuyj0mtf6ZB55r2E-tczS_bF/chillin-in-another-world-with-level-2-super-cheat-powers?ep=2

## Hypotheses
1. The opaque watch segment (`FECCXTDJmuyj0mtf6ZB55r2E-tczS_bF`) is an encoded/anime identifier generated from route metadata or an API response.
2. The new site no longer uses the old `www.miruro.tv/api/secure/pipe` contract, and episode/source data now comes from a different API host or path.
3. M3U8 URLs are produced client-side by a loaded JavaScript bundle after resolving episode/provider state through one or more API calls.
4. The final HLS manifest is hidden behind Miruro's proxy/encryption layer, requiring the new proxy key or a new URL construction scheme.
5. Browser headers/session state are now required to retrieve source manifests, so direct backend extraction must replicate selected request headers or cookies.

## Evidence Log
- Browser loaded the new watch URL successfully and rendered media id `FECCXTDJmuyj0mtf6ZB55r2E-tczS_bF` for AniList `170130`.
- The SSR payload includes `__sveltekit_k6q3ni.env` with `PUBLIC_PROXY_A=https://s1.keeply.top/`, `PUBLIC_PROXY_B=https://s2.keeply.top/`, `PUBLIC_STRMCX_ORIGIN=https://strm.cx`, and the same proxy obfuscation key `a54d389c18527d9fd3e7f0643e27edbe`.
- The opaque media id is returned by `GET /api/search/browse?q=<title>&limit=8&type=ANIME`; matching by `external_ids.anilist` confirms it belongs to AniList `170130`.
- The new sources contract is `GET /api/sources?id=<mediaId>&n=<episode>`.
- `/api/sources` returns `tracks[] -> providers[] -> servers[] -> streams[]`, including raw HLS URLs plus server-level request headers.
- The old `www.miruro.tv/api/secure/pipe` flow is no longer required for this URL shape.

## Fix
- Replaced the old `secure/pipe` provider flow with:
  1. AniList title lookup by id.
  2. Miruro `/api/search/browse?q=<title>&limit=8&type=ANIME`.
  3. Match by `external_ids.anilist`.
  4. Miruro `/api/sources?id=<mediaId>&n=<episode>`.
  5. Flatten tracks/providers/servers into the existing `{ dub, sub }` microservice contract.
- Updated Miruro proxy playback headers to use `https://strm.cx/`.
- Updated generic HLS key proxying to include `keeply.top`.

## Verification
- `python -m py_compile src/providers/miruro/server.py`: passed.
- `node --check src/routes/streams.js`: passed.
- `node --check src/routes/proxy.js`: passed.
- `app.test_client().get("/watch/170130/2")`: status 200, `dub=6`, `sub=7`.
