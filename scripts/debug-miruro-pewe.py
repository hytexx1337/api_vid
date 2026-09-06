"""
scripts/debug-miruro-pewe.py — Dump crudo de las fuentes que devuelve Miruro
para un provider puntual (default: pewe), sin pasar por pick_stream(), para
poder comparar a mano por qué el primer stream de la lista no funciona pero
el segundo sí.

Uso:
    python scripts/debug-miruro-pewe.py <anilistId> <episode> [provider]

Ej:
    python scripts/debug-miruro-pewe.py 21202 6 pewe
"""
import sys
import os
import json

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "providers", "miruro"))

from server import pipe, decode_ids, find_episode, BLOCKED_HOSTS  # noqa: E402

anilist_id = int(sys.argv[1])
episode_number = int(sys.argv[2])
provider = sys.argv[3] if len(sys.argv) > 3 else "pewe"

episodes = pipe("episodes", {"anilistId": anilist_id})
decode_ids(episodes)
providers = episodes.get("providers", {})

for category in ("sub", "dub"):
    episode_id = find_episode(providers, provider, category, episode_number)
    if not episode_id:
        print(f"[{category}] provider={provider} no tiene ep {episode_number}")
        continue

    import base64
    encoded_id = base64.urlsafe_b64encode(episode_id.encode()).decode().rstrip("=")
    source = pipe("sources", {
        "episodeId": encoded_id,
        "provider": provider,
        "category": category,
        "anilistId": anilist_id,
    }, timeout=15)

    streams = source.get("streams") or source.get("sources") or []
    print(f"\n=== [{category}] provider={provider} — {len(streams)} stream(s) ===")
    for i, s in enumerate(streams):
        ok = s.get("url") and not any(h in s["url"] for h in BLOCKED_HOSTS)
        print(f"\n--- stream[{i}] ok_filtro={ok} ---")
        print(json.dumps(s, indent=2, ensure_ascii=False))

    print(f"\n--- resto de campos de source (sin 'streams'/'sources') ---")
    rest = {k: v for k, v in source.items() if k not in ("streams", "sources")}
    print(json.dumps(rest, indent=2, ensure_ascii=False)[:2000])
