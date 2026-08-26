import base64
import gzip
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from curl_cffi import requests
from flask import Flask, jsonify, request, Response

app = Flask(__name__)

PIPE_URL = "https://www.miruro.tv/api/secure/pipe"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36",
    "Referer": "https://www.miruro.tv/",
    "Origin": "https://www.miruro.tv",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "sec-ch-ua": '"Chromium";v="110", "Not A(Brand";v="24", "Google Chrome";v="110"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}

PROXY_KEY = bytes.fromhex("a54d389c18527d9fd3e7f0643e27edbe")

BLOCKED_HOSTS = ["mewstream.buzz", "watching.onl", "mewcdn.buzz"]

_proxy_host_cache = {"value": None, "fetched_at": 0}


def get_proxy_host():
    if _proxy_host_cache["value"] and time.time() - _proxy_host_cache["fetched_at"] < 3600:
        return _proxy_host_cache["value"]

    res = requests.get("https://www.miruro.tv/env2.js", headers=HEADERS, impersonate="chrome110", timeout=10)
    raw = res.text.split('JSON.parse("', 1)[1].rsplit('")', 1)[0]
    env = json.loads(raw.encode().decode("unicode_escape"))

    host = env["VITE_PROXY_B"]
    _proxy_host_cache["value"] = host
    _proxy_host_cache["fetched_at"] = time.time()
    return host


def pipe(path, query, timeout=15):
    payload = {"path": path, "method": "GET", "query": query, "body": None, "version": "0.1.0"}
    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")

    res = requests.get(f"{PIPE_URL}?e={encoded}", headers=HEADERS, impersonate="chrome110", timeout=timeout)
    if res.status_code != 200:
        raise RuntimeError(f"pipe {path} failed: {res.status_code}")

    padded = res.text.strip()
    padded += "=" * (-len(padded) % 4)
    return json.loads(gzip.decompress(base64.urlsafe_b64decode(padded)))


def maybe_decode_id(value):
    if not isinstance(value, str):
        return value
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode()
        return decoded if ":" in decoded else value
    except Exception:
        return value


def decode_ids(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "id":
                node[key] = maybe_decode_id(value)
            else:
                decode_ids(value)
    elif isinstance(node, list):
        for item in node:
            decode_ids(item)


def xor(data, key):
    return bytes(b ^ key[i % len(key)] for i, b in enumerate(data))


def build_proxy_url(stream_url, referer):
    host = get_proxy_host()
    enc_url = base64.urlsafe_b64encode(xor(stream_url.encode(), PROXY_KEY)).decode().rstrip("=")
    if not referer:
        return f"{host}{enc_url}/pl.m3u8"
    enc_ref = base64.urlsafe_b64encode(xor(referer.encode(), PROXY_KEY)).decode().rstrip("=")
    return f"{host}{enc_url}~{enc_ref}/pl.m3u8"


def find_episode(providers, provider, category, number):
    episodes = providers.get(provider, {}).get("episodes", {}).get(category, [])
    for ep in episodes:
        if ep.get("number") == number:
            return ep.get("id")
    return None


def pick_stream(source):
    if not source:
        return None
    streams = source.get("streams") or source.get("sources") or []
    ok = lambda s: s.get("url") and not any(host in s["url"] for host in BLOCKED_HOSTS)

    stream = next((s for s in streams if s.get("type") == "hls" and ok(s)), None)
    if not stream:
        stream = next((s for s in streams if ".m3u8" in (s.get("url") or "") and ok(s)), None)
    if not stream:
        stream = next((s for s in streams if s.get("type") != "embed" and ok(s)), None)
    if not stream:
        return None

    subs = [
        {
            "label": t.get("label"),
            "lang": t.get("language") or t.get("lang") or t.get("srclang"),
            "url": t.get("file") or t.get("url"),
        }
        for t in (source.get("subtitles") or source.get("tracks") or [])
        if t.get("kind") != "thumbnails"
    ]

    referer = stream.get("referer")
    return {
        "url": stream["url"],
        "proxyUrl": build_proxy_url(stream["url"], referer),
        "headers": {"Referer": referer, "Origin": referer.rstrip("/")} if referer else {},
        "subtitles": subs,
        "download": source.get("download"),
    }


def _fetch_source(provider, episode_id, anilist_id, category):
    encoded_id = base64.urlsafe_b64encode(episode_id.encode()).decode().rstrip("=")
    try:
        # Timeout corto por provider: si uno cuelga (ej. kiwi con episodeIds
        # stale) no debe arrastrar el resto ni acercarse al timeout de 20s
        # que tiene el cliente Node (miruro.js).
        source = pipe("sources", {
            "episodeId": encoded_id,
            "provider": provider,
            "category": category,
            "anilistId": anilist_id,
        }, timeout=8)
    except Exception:
        return None

    stream = pick_stream(source)
    if stream:
        stream["provider"] = provider
    return stream


def resolve_category(providers, anilist_id, episode_number, category):
    tasks = []
    for provider in providers:
        episode_id = find_episode(providers, provider, category, episode_number)
        if episode_id:
            tasks.append((provider, episode_id))

    if not tasks:
        return []

    results = []
    # Providers en paralelo: el tiempo total pasa a ser ~max(latencias) en vez
    # de la suma, así un provider colgado no bloquea a los demás.
    with ThreadPoolExecutor(max_workers=len(tasks)) as executor:
        futures = [executor.submit(_fetch_source, provider, episode_id, anilist_id, category) for provider, episode_id in tasks]
        for future in as_completed(futures):
            stream = future.result()
            if stream:
                results.append(stream)

    return results


@app.get("/raw-proxy")
def raw_proxy():
    url = request.args.get("u")
    if not url:
        return jsonify({"error": "Missing u param"}), 400
    referer = request.args.get("ref") or request.headers.get("Referer") or "https://www.miruro.tv/"
    headers = HEADERS.copy()
    headers["Referer"] = referer
    headers["Origin"] = referer.rstrip("/")
    try:
        res = requests.get(url, headers=headers, impersonate="chrome110", timeout=30)
        ct = res.headers.get("Content-Type") or "application/octet-stream"
        return Response(res.content, status=res.status_code, content_type=ct)
    except Exception as e:
        return jsonify({"error": str(e)}), 502


@app.get("/watch/<int:anilist_id>/<int:episode>")
def watch(anilist_id, episode):
    try:
        episodes = pipe("episodes", {"anilistId": anilist_id})
        decode_ids(episodes)
        providers = episodes.get("providers", {})

        with ThreadPoolExecutor(max_workers=2) as executor:
            dub_future = executor.submit(resolve_category, providers, anilist_id, episode, "dub")
            sub_future = executor.submit(resolve_category, providers, anilist_id, episode, "sub")
            dub = dub_future.result()
            sub = sub_future.result()
        return jsonify({"dub": dub, "sub": sub})
    except Exception as e:
        return jsonify({"error": str(e)}), 502


if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 8001))
    app.run(host="127.0.0.1", port=port)
