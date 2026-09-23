import type { Manifest } from "./ai";

const PER_PAGE = 100;
const TIERS = ["common", "uncommon", "rare", "epic", "legendary"];

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Admin review page: generation controls and token grid with reroll buttons. */
export function galleryPage(manifest: Manifest, params: URLSearchParams): string {
	const tier = params.get("tier") ?? "";
	const page = Math.max(1, Number(params.get("page") ?? 1));
	const tokens = manifest.tokens.filter((t) => !tier || t.tier === tier);
	const pages = Math.max(1, Math.ceil(tokens.length / PER_PAGE));
	const shown = tokens.slice((page - 1) * PER_PAGE, page * PER_PAGE);

	const tierLinks = ["", ...TIERS]
		.map((t) => `<a href="?tier=${t}" class="${t === tier ? "on" : ""}">${t || "all"}</a>`)
		.join("");
	const pageLinks = Array.from({ length: pages }, (_, i) => i + 1)
		.map((p) => `<a href="?tier=${tier}&page=${p}" class="${p === page ? "on" : ""}">${p}</a>`)
		.join("");

	const cards = shown
		.map((t) => {
			const title = esc(`${t.name ?? ""} ${Object.entries(t.traits).map(([k, v]) => `${k}: ${v}`).join("\n")}`);
			return `<figure class="${t.tier}" title="${title}">
  <img loading="lazy" src="/admin/img/final/${t.id}.png" alt="#${t.id}" onerror="this.classList.add('missing')">
  <figcaption>#${t.id} ${t.tier}<button onclick="post('/admin/generate?ids=${t.id}&force=1', this)">reroll</button></figcaption>
</figure>`;
		})
		.join("");

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pixel Wayfarers admin</title>
<style>
  :root { color-scheme: dark; --bg: #16131c; --panel: #221e2b; --text: #eee8d5; --muted: #9a93a8; --accent: #f2b544; }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.4 system-ui, sans-serif; }
  h1, h2 { margin: 8px 0; } h2 { font-size: 16px; color: var(--muted); }
  section { background: var(--panel); border-radius: 8px; padding: 12px; margin-bottom: 16px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  a { color: var(--muted); padding: 2px 8px; border-radius: 4px; text-decoration: none; }
  a.on { background: var(--accent); color: #000; }
  button { background: #3a3448; color: var(--text); border: 0; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
  button:disabled { opacity: .5; }
  input { background: #111; color: var(--text); border: 1px solid #444; border-radius: 4px; padding: 4px 8px; width: 120px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  figure { margin: 0; background: #111; border-radius: 6px; overflow: hidden; border: 2px solid #333; }
  figure.uncommon { border-color: #4caf50; } figure.rare { border-color: #3d8bfd; }
  figure.epic { border-color: #b35cff; } figure.legendary { border-color: var(--accent); }
  img { width: 100%; aspect-ratio: 1; display: block; image-rendering: pixelated; background: #000; }
  img.missing { opacity: .08; }
  figcaption { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; font-size: 12px; }
</style></head><body>
<h1>Pixel Wayfarers admin</h1>

<section>
  <h2>Generate</h2>
  <div class="row">
    <input id="ids" placeholder="1-20 (blank = all)">
    <button onclick="post('/admin/generate?ids=' + encodeURIComponent(ids.value), this)">generate missing</button>
    <span id="progress"></span>
  </div>
</section>

<section>
  <h2>Review (${tokens.length} tokens)</h2>
  <div class="row">${tierLinks}</div>
  <div class="row" style="margin:8px 0">${pageLinks}</div>
  <div class="grid">${cards}</div>
</section>

<script>
async function post(url, btn) {
  btn.disabled = true; const label = btn.textContent; btn.textContent = '...';
  try {
    const res = await fetch(url, { method: 'POST' });
    const body = await res.json();
    btn.textContent = res.ok ? 'ok' : 'error';
    if (!res.ok) console.error(body);
  } catch (e) { btn.textContent = 'error'; console.error(e); }
  setTimeout(() => { btn.disabled = false; btn.textContent = label; }, 3000);
}
async function progress() {
  try {
    const p = await (await fetch('/admin/progress')).json();
    document.getElementById('progress').textContent = p.done + ' / ' + p.total + ' done';
  } catch {}
}
progress(); setInterval(progress, 10000);
</script>
</body></html>`;
}
