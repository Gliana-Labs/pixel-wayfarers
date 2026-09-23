import { generateImage, loadManifest, randomSeed, type Token } from "./ai";
import { galleryPage } from "./gallery";

export { GenerateToken } from "./workflow";

const BATCH = 100; // max instances per createBatch call

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/admin")) return env.ASSETS.fetch(request);
		if (!(await authorized(request, env))) {
			return new Response("unauthorized", {
				status: 401,
				headers: { "www-authenticate": 'Basic realm="pixel-wayfarers admin"' },
			});
		}
		try {
			return await admin(request, env, url);
		} catch (err) {
			return Response.json({ error: String(err) }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
	const path = url.pathname;
	const post = request.method === "POST";

	if (path === "/admin" || path === "/admin/") {
		const manifest = await loadManifest(env);
		return new Response(galleryPage(manifest, url.searchParams), {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	if (path.startsWith("/admin/img/")) {
		const obj = await env.ART.get(decodeURIComponent(path.slice("/admin/img/".length)));
		if (!obj) return new Response("not found", { status: 404 });
		return new Response(obj.body, {
			headers: { "content-type": obj.httpMetadata?.contentType ?? "image/png", "cache-control": "no-store" },
		});
	}

	if (post && path === "/admin/art") {
		// one-off marketing art (site map, banners); body = prompt text
		const model = url.searchParams.get("model") ?? "@cf/black-forest-labs/flux-2-klein-9b";
		const width = Number(url.searchParams.get("w") ?? 1024);
		const height = Number(url.searchParams.get("h") ?? 1024);
		const bytes = await generateImage(env, model, await request.text(), { width, height }, randomSeed());
		const key = `marketing/${Date.now()}`;
		await env.ART.put(key, bytes);
		return new Response(bytes, { headers: { "content-type": "image/png", "x-art-key": key } });
	}

	if (post && path === "/admin/generate") {
		const manifest = await loadManifest(env);
		const ids = parseIds(url.searchParams.get("ids"), manifest.tokens);
		const force = url.searchParams.get("force") === "1";
		const stamp = Date.now();
		for (let i = 0; i < ids.length; i += BATCH) {
			await env.GENERATE.createBatch(
				ids.slice(i, i + BATCH).map((id) => ({ id: `t${id}-${stamp}`, params: { id, force } })),
			);
		}
		return Response.json({ queued: ids.length, force });
	}

	if (path === "/admin/progress") {
		let done = 0;
		let cursor: string | undefined;
		do {
			const page = await env.ART.list({ prefix: "final/", cursor });
			done += page.objects.length;
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		const manifest = await loadManifest(env);
		return Response.json({ done, total: manifest.tokens.length });
	}

	return new Response("not found", { status: 404 });
}

/** "1-50,77" -> ids; empty -> every token. */
function parseIds(spec: string | null, tokens: Token[]): number[] {
	if (!spec) return tokens.map((t) => t.id);
	const valid = new Set(tokens.map((t) => t.id));
	const ids = spec.split(",").flatMap((part) => {
		const [lo, hi] = part.split("-").map(Number);
		return hi ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo];
	});
	return ids.filter((id) => valid.has(id));
}

async function authorized(request: Request, env: Env): Promise<boolean> {
	if (!env.ADMIN_PASSWORD) return false;
	const header = request.headers.get("authorization") ?? "";
	if (!header.startsWith("Basic ")) return false;
	const password = atob(header.slice(6)).split(":").slice(1).join(":");
	const enc = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(password)),
		crypto.subtle.digest("SHA-256", enc.encode(env.ADMIN_PASSWORD)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}
