# Sniffer camoufox — captura TODAS las requests/responses de una página.
# Cada response se guarda como archivo en out_dir/bodies/NNN.bin + un
# index.jsonl con metadatos (url, headers, post_data, status, timing).
# Uso: python tools/_sniff_movy.py [url] [segundos] [out_dir]
import json
import os
import sys
import time
import base64
import threading
from urllib.parse import urlparse

DEFAULT_URL = "https://vidstuck.xyz/embed/tv/1404/1/13?branding=StreameX&server=orion&loading=1&back=true"


def parse_args(argv):
    url = DEFAULT_URL
    wait_s = 45
    out_arg = "_sniff_out"

    args = [str(arg).strip() for arg in argv if str(arg).strip()]
    if not args:
        return url, wait_s, out_arg

    first = args[0].strip("`'\" \t\r\n")
    if first:
        if first.isdigit():
            wait_s = int(first)
        else:
            url = first

    if len(args) > 1:
        second = args[1].strip("`'\" \t\r\n")
        if second:
            if second.isdigit():
                wait_s = int(second)
            else:
                out_arg = second

    if len(args) > 2:
        third = args[2].strip("`'\" \t\r\n")
        if third:
            out_arg = third

    return url, wait_s, out_arg


URL, WAIT_S, OUT_ARG = parse_args(sys.argv[1:])
OUT = OUT_ARG if os.path.isabs(OUT_ARG) else os.path.join(os.path.dirname(__file__), OUT_ARG)
BODIES = os.path.join(OUT, "bodies")
os.makedirs(BODIES, exist_ok=True)

lock = threading.Lock()
idx = open(os.path.join(OUT, "index.jsonl"), "a", encoding="utf-8")
counter = [0]


def log(entry):
    with lock:
        idx.write(json.dumps(entry, ensure_ascii=False) + "\n")
        idx.flush()


def on_request(req):
    n = counter[0]
    counter[0] += 1
    req._sniff_n = n
    log({
        "n": n, "kind": "request", "method": req.method, "url": req.url,
        "resource_type": req.resource_type,
        "headers": dict(req.headers),
        "post_data_b64": base64.b64encode(req.post_data_buffer).decode() if req.post_data_buffer else None,
        "t": time.time(),
    })


responses = {}  # n -> Response (bodies se leen al final, con la page viva)

def on_response(res):
    req = res.request
    n = getattr(req, "_sniff_n", -1)
    responses[n] = res
    log({
        "n": n, "kind": "response", "url": res.url,
        "status": res.status,
        "headers": dict(res.headers),
        "t": time.time(),
    })


def dump_bodies():
    for n, res in sorted(responses.items()):
        body_file = None
        try:
            body = res.body()
            if body:
                body_file = f"bodies/{n:04d}.bin"
                with open(os.path.join(OUT, body_file), "wb") as f:
                    f.write(body)
        except Exception as e:
            body_file = f"ERR:{e}"
        size = 0
        if body_file and not body_file.startswith("ERR"):
            size = os.path.getsize(os.path.join(OUT, body_file))
        log({"n": n, "kind": "body", "body_file": body_file, "body_size": size})


from camoufox.sync_api import Camoufox

with Camoufox(headless=True, humanize=True) as browser:
    page = browser.new_page()
    page.on("request", on_request)
    page.on("response", on_response)
    # websockets por si usan WS en vez de fetch
    page.on("websocket", lambda ws: (
        log({"kind": "ws", "url": ws.url, "t": time.time()}),
        ws.on("framesent", lambda p: log({"kind": "ws_send", "url": ws.url, "payload": str(p)[:2000], "t": time.time()})),
        ws.on("framereceived", lambda p: log({"kind": "ws_recv", "url": ws.url, "payload": str(p)[:2000], "t": time.time()})),
    ))
    print(f"[sniff] {URL} ({WAIT_S}s)")
    try:
        page.goto(URL, wait_until="domcontentloaded", timeout=60000)
    except Exception as e:
        print("[sniff] goto:", e)
    time.sleep(WAIT_S)
    # simular click en el player por si el autoplay no arrancó solo
    try:
        page.mouse.click(640, 360)
    except Exception:
        pass
    time.sleep(15)
    print(f"[sniff] leyendo bodies ({len(responses)} responses)...")
    dump_bodies()
    print(f"[sniff] done — {counter[0]} requests, output en {OUT}")
idx.close()
