"""Local preview of the site art: every example image, brand image and candidate at full size.

    python pipeline/preview.py        # then open http://localhost:8768

Candidates for a redo live in build/preview/candidates/ (named <target>-<n>.png, e.g. chef-2.png).
"""
import html
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "worker" / "public"
CANDIDATES = ROOT / "build" / "preview" / "candidates"
PORT = 8768

SECTIONS = [
    ("Candidates (not live yet)", CANDIDATES, "/cand/"),
    ("Site examples (live)", PUBLIC / "art", "/art/"),
    ("Brand (live)", PUBLIC / "brand", "/brand/"),
]


def page():
    parts = []
    for title, folder, prefix in SECTIONS:
        files = sorted(p for p in folder.glob("*") if p.suffix in (".png", ".webp", ".jpg"))
        if not files:
            continue
        tiles = "".join(
            f'<figure><a href="{prefix}{html.escape(p.name)}" target="_blank"><img src="{prefix}{html.escape(p.name)}" loading="lazy"></a>'
            f"<figcaption>{html.escape(p.name)}</figcaption></figure>"
            for p in files
        )
        parts.append(f"<h2>{html.escape(title)}</h2><div class=grid>{tiles}</div>")
    return f"""<!doctype html><html><head><meta charset=utf-8><title>Art preview</title><style>
body{{margin:0;padding:24px;background:#16120e;color:#f2e6cf;font:15px system-ui}}h2{{color:#f4b63f;margin:28px 0 12px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(512px,1fr));gap:18px}}
figure{{margin:0;background:#221b14;border:1px solid #3b2e22;border-radius:6px;padding:8px}}
img{{width:100%;display:block;image-rendering:pixelated;background:#000}}figcaption{{padding:6px 2px 0;color:#b9a88a}}
</style></head><body><h1>Pixel Wayfarers art preview</h1><p>Click an image to open it alone at full size. Refresh after changes.</p>{''.join(parts)}</body></html>"""


class H(SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            body = page().encode()
            self.send_response(200)
            self.send_header("content-type", "text/html; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        for _, folder, prefix in SECTIONS:
            if path.startswith(prefix):
                f = folder / Path(path[len(prefix):]).name
                if f.is_file():
                    self.send_response(200)
                    self.send_header("content-type", "image/webp" if f.suffix == ".webp" else "image/png")
                    self.send_header("cache-control", "no-store")
                    self.end_headers()
                    self.wfile.write(f.read_bytes())
                    return
        self.send_error(404)


if __name__ == "__main__":
    CANDIDATES.mkdir(parents=True, exist_ok=True)
    print(f"art preview on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
