import base64
import json
import os
import re
import shutil
import subprocess
import time
from urllib.parse import quote, urlencode

from flask import Flask, jsonify, request, Response

try:
    from curl_cffi import requests as http_requests
    HAS_CURL_CFFI = True
except ModuleNotFoundError:
    import requests as http_requests
    HAS_CURL_CFFI = False

app = Flask(__name__)

BASE_URL = "https://barelystarted.miruro.tv"
SEARCH_URL = f"{BASE_URL}/api/search/browse"
SOURCES_URL = f"{BASE_URL}/api/sources"
ANILIST_URL = "https://graphql.anilist.co"
MIRURO_CF_WORKER = os.environ.get("MIRURO_CF_WORKER", "").strip().strip("`'\"").rstrip("/")

STRMCX_ORIGIN = "https://strm.cx"
PROXY_HOST = "https://s1.keeply.top/"
PROXY_KEY = bytes.fromhex("a54d389c18527d9fd3e7f0643e27edbe")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Referer": f"{BASE_URL}/",
    "Origin": BASE_URL,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
}

BLOCKED_HOSTS = ["mewstream.buzz", "watching.onl", "mewcdn.buzz"]
EXCLUDED_PROVIDERS = {"moo", "bonk"}

_media_cache = {}
_sources_cache = {}


def _cache_get(cache, key):
    entry = cache.get(key)
    if not entry or time.time() > entry["exp"]:
        cache.pop(key, None)
        return None
    return entry["value"]


def _cache_set(cache, key, value, ttl):
    cache[key] = {"value": value, "exp": time.time() + ttl}
    return value


def _impersonation_kwargs():
    return {"impersonate": "chrome110"} if HAS_CURL_CFFI else {}


def _http_get(url, **kwargs):
    return http_requests.get(url, **kwargs, **_impersonation_kwargs())


def _http_post(url, **kwargs):
    return http_requests.post(url, **kwargs, **_impersonation_kwargs())


def _worker_url(target_url, params=None):
    query = urlencode(params or {}, doseq=True)
    full_url = f"{target_url}?{query}" if query else target_url
    return f"{MIRURO_CF_WORKER}/fetch?url={quote(full_url, safe='')}"


def _curl_get_text(url, headers=None, timeout=15):
    curl_bin = shutil.which("curl")
    if not curl_bin:
        raise RuntimeError("curl binary not found")

    cmd = [
        curl_bin,
        "-sS",
        "-L",
        "--max-time",
        str(timeout),
        "-A",
        HEADERS["User-Agent"],
    ]
    for key, value in {**HEADERS, **(headers or {})}.items():
        if key.lower() == "user-agent":
            continue
        cmd.extend(["-H", f"{key}: {value}"])
    cmd.append(url)

    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5)
    if proc.returncode != 0:
        raise RuntimeError(f"curl failed {proc.returncode}: {proc.stderr[:180]}")
    return proc.stdout


def _json_get(url, params=None, headers=None, timeout=15):
    if MIRURO_CF_WORKER and url.startswith(BASE_URL):
        worker_url = _worker_url(url, params)
        try:
            return json.loads(_curl_get_text(worker_url, headers=headers, timeout=timeout))
        except json.JSONDecodeError as exc:
            preview = getattr(exc, "doc", "")[:180].replace("\n", " ")
            raise RuntimeError(f"GET {url} invalid worker JSON: {preview}") from exc
    else:
        res = _http_get(
            url,
            params=params,
            headers={**HEADERS, **(headers or {})},
            timeout=timeout,
        )
    if res.status_code != 200:
        preview = res.text[:180].replace("\n", " ")
        raise RuntimeError(f"GET {url} failed: {res.status_code} {preview}")
    try:
        return res.json()
    except Exception as exc:
        preview = res.text[:180].replace("\n", " ")
        raise RuntimeError(f"GET {url} invalid JSON: {preview}") from exc


def _anilist_titles(anilist_id):
    query = """
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        title { romaji english native }
        synonyms
      }
    }
    """
    res = _http_post(
        ANILIST_URL,
        json={"query": query, "variables": {"id": anilist_id}},
        headers={"Accept": "application/json", "Content-Type": "application/json"},
        timeout=12,
    )
    if res.status_code != 200:
        raise RuntimeError(f"AniList failed: {res.status_code}")

    media = (res.json().get("data") or {}).get("Media") or {}
    title = media.get("title") or {}
    candidates = [title.get("english"), title.get("romaji"), title.get("native")]
    candidates.extend(media.get("synonyms") or [])

    seen = set()
    result = []
    for value in candidates:
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _slug(title):
    text = (title or "").lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "anime"


def resolve_media(anilist_id):
    cached = _cache_get(_media_cache, anilist_id)
    if cached:
        return cached

    wanted = str(anilist_id)
    for title in _anilist_titles(anilist_id):
        data = _json_get(SEARCH_URL, {"q": title, "limit": 8, "type": "ANIME"})
        for item in data.get("data") or []:
            external_ids = item.get("external_ids") or item.get("externalIds") or {}
            if wanted in [str(v) for v in external_ids.get("anilist", [])]:
                media = {
                    "id": item["id"],
                    "slug": _slug((item.get("title") or {}).get("english") or (item.get("title") or {}).get("romaji") or title),
                }
                return _cache_set(_media_cache, anilist_id, media, 6 * 3600)

    raise RuntimeError(f"Miruro media not found for AniList {anilist_id}")


def xor(data, key):
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def _proxy_part(value):
    return base64.urlsafe_b64encode(xor(value.encode(), PROXY_KEY)).decode().rstrip("=")


def build_proxy_url(stream_url, referer):
    enc_url = _proxy_part(stream_url)
    if not referer:
        return f"{PROXY_HOST}{enc_url}/pl.m3u8"
    return f"{PROXY_HOST}{enc_url}~{_proxy_part(referer)}/pl.m3u8"


def _ok_stream(stream):
    url = stream.get("url") if isinstance(stream, dict) else None
    return bool(url) and not any(host in url for host in BLOCKED_HOSTS)


def _pick_download(downloads):
    if not isinstance(downloads, list) or not downloads:
        return None
    best = next((d for d in downloads if d.get("quality") == "1080p" and d.get("url")), None)
    return (best or next((d for d in downloads if d.get("url")), None) or {}).get("url")


def _normalize_subtitle(track):
    return {
        "label": track.get("label"),
        "lang": track.get("language") or track.get("lang") or track.get("srclang"),
        "url": track.get("file") or track.get("url"),
        "format": track.get("format"),
        "default": track.get("default"),
    }


def _flatten_sources(data):
    result = {"dub": [], "sub": []}

    for track in data.get("tracks") or []:
        bucket = "dub" if track.get("track") == "dub" else "sub"

        for provider_entry in track.get("providers") or []:
            provider = provider_entry.get("provider") or "miruro"
            if provider in EXCLUDED_PROVIDERS:
                continue

            subtitles = [
                _normalize_subtitle(t)
                for t in (provider_entry.get("subtitles") or [])
                if (t.get("file") or t.get("url"))
            ]
            download = _pick_download(provider_entry.get("downloads"))

            for server in provider_entry.get("servers") or []:
                headers = server.get("headers") or {}
                referer = headers.get("Referer") or headers.get("referer")
                streams = [s for s in (server.get("streams") or []) if _ok_stream(s)]
                hls = next((s for s in streams if s.get("format") == "hls"), None)
                stream = hls or next((s for s in streams if ".m3u8" in s.get("url", "")), None) or (streams[0] if streams else None)
                if not stream:
                    continue

                result[bucket].append({
                    "url": stream["url"],
                    "proxyUrl": build_proxy_url(stream["url"], referer),
                    "headers": {"Referer": f"{STRMCX_ORIGIN}/", "Origin": STRMCX_ORIGIN},
                    "provider": provider,
                    "server": server.get("server"),
                    "quality": stream.get("quality"),
                    "subtitles": subtitles,
                    "download": download,
                })

    return result


def resolve_sources(anilist_id, episode):
    cache_key = f"{anilist_id}:{episode}"
    cached = _cache_get(_sources_cache, cache_key)
    if cached:
        return cached

    media = resolve_media(anilist_id)
    data = _json_get(
        SOURCES_URL,
        {"id": media["id"], "n": str(episode)},
        {"Referer": f"{BASE_URL}/watch/{media['id']}/{media['slug']}?ep={episode}"},
        timeout=25,
    )
    return _cache_set(_sources_cache, cache_key, _flatten_sources(data), 15 * 60)


@app.get("/raw-proxy")
def raw_proxy():
    url = request.args.get("u")
    if not url:
        return jsonify({"error": "Missing u param"}), 400
    referer = request.args.get("ref") or request.headers.get("Referer") or f"{BASE_URL}/"
    headers = HEADERS.copy()
    headers["Referer"] = referer
    headers["Origin"] = referer.rstrip("/")
    try:
        res = _http_get(url, headers=headers, timeout=30)
        ct = res.headers.get("Content-Type") or "application/octet-stream"
        return Response(res.content, status=res.status_code, content_type=ct)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.get("/watch/<int:anilist_id>/<int:episode>")
def watch(anilist_id, episode):
    try:
        return jsonify(resolve_sources(anilist_id, episode))
    except Exception as e:
        return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8001))
    app.run(host="127.0.0.1", port=port)
