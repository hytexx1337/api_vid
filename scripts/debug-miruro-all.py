import sys
import os
import base64

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "providers", "miruro"))
from server import pipe, decode_ids, find_episode, build_proxy_url, BLOCKED_HOSTS  # noqa: E402
from curl_cffi import requests as creq  # noqa: E402

anilist_id = int(sys.argv[1]) if len(sys.argv) > 1 else 21202
episode = int(sys.argv[2]) if len(sys.argv) > 2 else 5

episodes = pipe("episodes", {"anilistId": anilist_id})
decode_ids(episodes)
providers = episodes.get("providers", {})
print("Providers disponibles:", list(providers.keys()))

for provider in providers:
    for category in ("sub", "dub"):
        eid = find_episode(providers, provider, category, episode)
        if not eid:
            continue
        encoded = base64.urlsafe_b64encode(eid.encode()).decode().rstrip("=")
        try:
            source = pipe("sources", {"episodeId": encoded, "provider": provider, "category": category}, timeout=10)
        except Exception as e:
            print(f"[{provider}/{category}] pipe ERROR: {e}")
            continue
        streams = source.get("streams") or source.get("sources") or []
        ok = lambda s: s.get("url") and not any(h in s["url"] for h in BLOCKED_HOSTS)
        cand = next((s for s in streams if s.get("type") == "hls" and ok(s)), None)
        if not cand:
            cand = next((s for s in streams if ".m3u8" in (s.get("url") or "") and ok(s)), None)
        if not cand:
            cand = next((s for s in streams if s.get("type") != "embed" and ok(s)), None)
        if not cand:
            print(f"[{provider}/{category}] sin candidato jugable ({len(streams)} streams)")
            continue
        proxy_url = build_proxy_url(cand["url"], cand.get("referer"))
        try:
            r = creq.get(proxy_url, impersonate="chrome110", timeout=15)
            status = r.status_code
            body_preview = r.text[:80].replace("\n", " ")
        except Exception as e:
            status = f"EXC:{e}"
            body_preview = ""
        ctype = cand.get("type")
        short_url = cand["url"][:60]
        print(f"[{provider}/{category}] type={ctype} url={short_url}... -> proxy status={status} | {body_preview}")
