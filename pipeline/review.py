"""Local review app: browse every generated wayfarer, mark ugly ones or reroll them with one click.

    python pipeline/review.py            # then open http://localhost:8765

Runs only on this machine. Rerolls go to the live Worker using WORKER_URL + ADMIN_PASSWORD
from .env, so the password never reaches the browser. Marks are saved to build/review.json
(id -> "marked"); Claude rerolls and re-checks everything marked.
"""
import hashlib
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import requests

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "build" / "images"
MANIFEST = ROOT / "build" / "manifest.json"
REVIEW = ROOT / "build" / "review.json"
PORT = 8765


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


load_env()
BASE = os.environ.get("WORKER_URL", "").rstrip("/")
AUTH = ("admin", os.environ.get("ADMIN_PASSWORD", ""))
if not BASE or not AUTH[1]:
    sys.exit("set WORKER_URL and ADMIN_PASSWORD in .env")

def tokens():
    """Re-read every call so trait edits (e.g. a renamed item) show up without a restart."""
    return {t["id"]: t for t in json.loads(MANIFEST.read_text())["tokens"]}
lock = threading.Lock()
review = json.loads(REVIEW.read_text()) if REVIEW.exists() else {}  # id -> "marked"
review = {k: v for k, v in review.items() if v == "marked"}
pending = {}  # id -> {"since": ts, "old": md5}


def md5(path):
    return hashlib.md5(path.read_bytes()).hexdigest() if path.exists() else ""


def save_review():
    REVIEW.write_text(json.dumps(review, indent=1))


def request(method, url, **kw):
    """HTTP with retries: flaky connections must not kill a reroll."""
    for attempt in range(5):
        try:
            return requests.request(method, url, auth=AUTH, timeout=30, **kw)
        except requests.RequestException:
            time.sleep(2 + attempt * 2)
    return None


def watch_reroll(token_id):
    """Poll the live image until it changes, then download it over the local copy."""
    info = pending[token_id]
    deadline = time.time() + 420
    while time.time() < deadline:
        time.sleep(4)
        r = request("GET", f"{BASE}/admin/img/final/{token_id}.png")
        if r is not None and r.status_code == 200 and hashlib.md5(r.content).hexdigest() != info["old"]:
            (IMAGES / f"{token_id}.png").write_bytes(r.content)
            with lock:
                pending.pop(token_id, None)
                review.pop(str(token_id), None)  # the new image gets a fresh look
                save_review()
            return
    with lock:
        pending[token_id]["failed"] = True


PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wayfarer review</title><style>
:root{color-scheme:dark;--bg:#16120e;--card:#221b14;--line:#3b2e22;--text:#f2e6cf;--muted:#b9a88a;--gold:#f4b63f;--ok:#7dae58;--bad:#d9534f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 system-ui,sans-serif}
header{position:sticky;top:0;z-index:5;background:#0f0c09;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
h1{font-size:16px;margin:0 12px 0 0;color:var(--gold)}select,input,button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:4px;padding:6px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--gold)}#stats{color:var(--muted);margin-left:auto}
main{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{background:var(--card);border:2px solid var(--line);border-radius:6px;overflow:hidden}
.card.marked{border-color:var(--bad)}.card.busy{opacity:.55}.card.failed{border-color:var(--bad)}
.card img{width:100%;aspect-ratio:1;display:block;image-rendering:pixelated;cursor:zoom-in;background:#000}
.meta{padding:8px 10px}.top{display:flex;justify-content:space-between;font-weight:600}
.tier{font-size:12px;text-transform:uppercase;letter-spacing:.06em}.t-common{color:#b9a988}.t-uncommon{color:#7dae58}.t-rare{color:#5f9fd8}.t-epic{color:#a97fd8}.t-legendary{color:var(--gold)}
.traits{color:var(--muted);font-size:12px;margin:6px 0 8px;min-height:3.2em}.actions{display:flex;gap:6px}.actions button{flex:1}
.mark.on{background:var(--bad);color:#fff;border-color:var(--bad)}
#zoom{position:fixed;inset:0;background:rgba(0,0,0,.88);display:none;place-items:center;z-index:9;cursor:zoom-out}
#zoom img{width:min(90vw,90vh);image-rendering:pixelated}#zoom.on{display:grid}
nav{padding:0 16px 24px;display:flex;flex-wrap:wrap;gap:6px}nav button.on{border-color:var(--gold);color:var(--gold)}
</style></head><body>
<header><h1>Wayfarer review</h1>
<select id="tier"><option value="">all tiers</option><option>common</option><option>uncommon</option><option>rare</option><option>epic</option><option>legendary</option></select>
<select id="show"><option value="">all</option><option value="marked">marked</option><option value="todo">not marked</option></select>
<input id="q" placeholder="search trait, role, #id" size="22">
<span id="stats"></span></header>
<main id="grid"></main><nav id="pages"></nav>
<div id="zoom"><img alt=""></div>
<script>
let all=[], page=0; const PER=60;
const $=s=>document.querySelector(s);
async function load(){ all=await (await fetch('/api/tokens')).json(); render(); }
function filtered(){
  const tier=$('#tier').value, show=$('#show').value, q=$('#q').value.toLowerCase().trim();
  return all.filter(t=>(!tier||t.tier===tier)&&(!show||(show==='marked')===t.marked)&&
    (!q||('#'+t.id+' '+(t.name||'')+' '+Object.values(t.traits).join(' ')).toLowerCase().includes(q)));
}
function render(){
  const list=filtered(), pages=Math.max(1,Math.ceil(list.length/PER)); page=Math.min(page,pages-1);
  const marked=all.filter(t=>t.marked).length;
  $('#stats').textContent=`${marked} marked  ·  showing ${list.length}`;
  $('#grid').innerHTML=list.slice(page*PER,(page+1)*PER).map(t=>`
   <div class="card ${t.marked?'marked':''} ${t.busy?'busy':''} ${t.failed?'failed':''}" id="c${t.id}">
    <img src="/img/${t.id}.png?v=${t.v}" loading="lazy" alt="#${t.id}" onclick="zoom(this.src)">
    <div class="meta"><div class="top"><span>#${t.id} ${t.name||t.traits.Role||''}</span><span class="tier t-${t.tier}">${t.tier}</span></div>
    <div class="traits">${Object.entries(t.traits).filter(([k,v])=>v!=='None').map(([k,v])=>v).join(' · ')}</div>
    <div class="actions"><button class="mark ${t.marked?'on':''}" onclick="mark(${t.id})">${t.marked?'Marked':'Mark'}</button>
    <button onclick="reroll(${t.id})" ${t.busy?'disabled':''}>${t.busy?'Rerolling…':(t.failed?'Failed, retry':'Reroll')}</button></div></div></div>`).join('');
  $('#pages').innerHTML=Array.from({length:pages},(_,i)=>`<button class="${i===page?'on':''}" onclick="page=${i};render();scrollTo(0,0)">${i+1}</button>`).join('');
}
async function mark(id){ const r=await (await fetch('/api/mark/'+id,{method:'POST'})).json(); Object.assign(all.find(t=>t.id===id),r); render(); }
async function reroll(id){ const t=all.find(t=>t.id===id); t.busy=true; t.failed=false; render(); await fetch('/api/reroll/'+id,{method:'POST'}); poll(); }
async function poll(){
  const s=await (await fetch('/api/status')).json(); let busy=false;
  for(const t of all){ const p=s[t.id]; const was=t.busy;
    t.busy=!!p&&!p.failed; t.failed=!!(p&&p.failed); if(t.busy) busy=true; if(was&&!p){ t.v=Date.now(); t.marked=false; } }
  render(); if(busy) setTimeout(poll,5000);
}
function zoom(src){ const z=$('#zoom'); z.querySelector('img').src=src; z.classList.add('on'); }
$('#zoom').onclick=()=>$('#zoom').classList.remove('on');
['tier','show'].forEach(id=>$('#'+id).onchange=()=>{page=0;render();}); $('#q').oninput=()=>{page=0;render();};
load(); poll();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else body.encode()
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/":
            return self.send(200, PAGE, "text/html; charset=utf-8")
        if path == "/api/tokens":
            with lock:
                out = [{"id": t["id"], "tier": t["tier"], "name": t.get("name"), "traits": t["traits"],
                        "marked": review.get(str(t["id"])) == "marked", "busy": t["id"] in pending,
                        "v": int(time.time())} for t in tokens().values()]
            return self.send(200, json.dumps(out))
        if path == "/api/status":
            with lock:
                return self.send(200, json.dumps({str(k): {"failed": v.get("failed", False)} for k, v in pending.items()}))
        if path.startswith("/img/"):
            f = IMAGES / Path(path).name
            if f.exists() and f.parent == IMAGES:
                return self.send(200, f.read_bytes(), "image/png")
            return self.send(404, "{}")
        self.send(404, "{}")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            token_id = int(path.rsplit("/", 1)[1])
        except ValueError:
            return self.send(400, "{}")
        if token_id not in tokens():
            return self.send(404, "{}")
        if path.startswith("/api/mark/"):
            with lock:
                key = str(token_id)
                if review.get(key) == "marked":
                    review.pop(key)
                else:
                    review[key] = "marked"
                save_review()
                return self.send(200, json.dumps({"marked": review.get(key) == "marked"}))
        if path.startswith("/api/reroll/"):
            with lock:
                if token_id in pending and not pending[token_id].get("failed"):
                    return self.send(200, json.dumps({"queued": False}))
                pending[token_id] = {"since": time.time(), "old": md5(IMAGES / f"{token_id}.png")}
            r = request("POST", f"{BASE}/admin/generate", params={"ids": token_id, "force": 1})
            if r is None or r.status_code != 200:
                with lock:
                    pending[token_id]["failed"] = True
                return self.send(502, json.dumps({"error": "could not reach the site, try again"}))
            threading.Thread(target=watch_reroll, args=(token_id,), daemon=True).start()
            return self.send(200, json.dumps({"queued": True}))
        self.send(404, "{}")


if __name__ == "__main__":
    if not IMAGES.exists():
        sys.exit("no images yet: run `python pipeline/wayfarers.py pull` first")
    print(f"review app on http://localhost:{PORT}  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
