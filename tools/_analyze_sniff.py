# Analiza tools/_sniff_out/index.jsonl — lista requests agrupadas por host
# y busca las llamadas a api.wecollege.net con detalle (headers, post_data).
import json
import os
import sys
import base64
from urllib.parse import urlparse
from collections import Counter

OUT = os.path.join(os.path.dirname(__file__), "_sniff_out")
entries = [json.loads(l) for l in open(os.path.join(OUT, "index.jsonl"), encoding="utf-8")]

reqs = {e["n"]: e for e in entries if e["kind"] == "request"}
resps = {e["n"]: e for e in entries if e["kind"] == "response"}
for e in entries:
    if e["kind"] == "body" and e["n"] in resps:
        resps[e["n"]].update({"body_file": e["body_file"], "body_size": e["body_size"]})

print("=== HOSTS ===")
for host, n in Counter(urlparse(r["url"]).netloc for r in reqs.values()).most_common():
    print(f"{n:4}  {host}")

print("\n=== REQUESTS ===")
for n in sorted(reqs):
    r = reqs[n]
    resp = resps.get(n, {})
    status = resp.get("status", "?")
    size = resp.get("body_size", 0)
    u = urlparse(r["url"])
    print(f"{n:3} {r['method']:4} {r['resource_type']:9} {status} {size:>8}b  {u.netloc}{u.path[:90]}")

# Detalle completo de todo lo que toque wecollege o parezca API/stream
print("\n=== DETALLE wecollege/streams ===")
for n in sorted(reqs):
    r = reqs[n]
    u = urlparse(r["url"])
    if "wecollege" in u.netloc or any(x in u.path for x in [".m3u8", ".mp4", "/api/", "stream", "source", "embed", "get"]):
        print(f"\n--- req {n}: {r['method']} {r['url']}")
        print("  headers:", json.dumps(r["headers"], indent=4)[:1500])
        if r.get("post_data_b64"):
            print("  post_data:", base64.b64decode(r["post_data_b64"])[:500])
        resp = resps.get(n)
        if resp:
            print(f"  status={resp['status']} body_file={resp.get('body_file')}")
            bf = resp.get("body_file")
            if bf and not str(bf).startswith("ERR") and resp.get("body_size", 0) < 20000:
                p = os.path.join(OUT, bf)
                if os.path.exists(p):
                    raw = open(p, "rb").read()
                    try:
                        print("  body:", raw[:2000].decode("utf-8", "replace"))
                    except Exception:
                        print("  body(hex):", raw[:200].hex())
