import { generateImage, loadManifest, loadPoseTemplate, POSE_INSTRUCTION, randomSeed, type Token } from "./ai";
import { galleryPage } from "./gallery";

export { GenerateToken } from "./workflow";

const BATCH = 100; // max instances per createBatch call

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname.startsWith("www.")) {
			url.hostname = url.hostname.slice(4);
			return Response.redirect(url.toString(), 301);
		}
		if (url.pathname.startsWith("/api/")) return publicApi(request, env, url);
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
		// ?template=1 redraws the pose template (the way templated tiers are generated)
		// ?ref=<R2 key> edits that image with the raw prompt (used to build pose templates)
		const useTemplate = url.searchParams.get("template") === "1";
		const refKey = url.searchParams.get("ref");
		const ref = refKey ? await getBytes(env, refKey) : useTemplate ? await loadPoseTemplate(env) : undefined;
		if ((useTemplate || refKey) && !ref) return Response.json({ error: "reference image not found in R2" }, { status: 400 });
		const text = await request.text();
		const prompt = useTemplate ? POSE_INSTRUCTION + text : text;
		const bytes = await generateImage(env, model, prompt, { width, height }, randomSeed(), ref);
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

	if (path === "/admin/founders") {
		// every signup, for you to review and approve; export: curl -u admin:PW .../admin/founders
		const rows: unknown[] = [];
		let cursor: string | undefined;
		do {
			const page = await env.ART.list({ prefix: "founders/signups/", cursor });
			for (const o of page.objects) rows.push(await (await env.ART.get(o.key))!.json());
			cursor = page.truncated ? page.cursor : undefined;
		} while (cursor);
		return Response.json(rows);
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

async function getBytes(env: Env, key: string): Promise<Uint8Array | undefined> {
	const obj = await env.ART.get(key);
	return obj ? new Uint8Array(await obj.arrayBuffer()) : undefined;
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

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;

/** Public endpoints: founders-list signup and mint proofs. No auth. */
async function publicApi(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method === "POST" && url.pathname === "/api/founders") {
		let body: { x?: string; wallet?: string };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "bad request" }, { status: 400 });
		}
		const wallet = (body.wallet ?? "").trim();
		const x = (body.x ?? "").trim().replace(/^@/, "");
		if (!WALLET.test(wallet)) return Response.json({ error: "That is not a valid Ethereum wallet address." }, { status: 400 });
		if (!X_HANDLE.test(x)) return Response.json({ error: "That is not a valid X handle." }, { status: 400 });
		const key = `founders/signups/${wallet.toLowerCase()}.json`;
		if (await env.ART.head(key)) return Response.json({ ok: true, already: true });
		await env.ART.put(key, JSON.stringify({ wallet: wallet.toLowerCase(), x, at: new Date().toISOString() }), {
			httpMetadata: { contentType: "application/json" },
		});
		return Response.json({ ok: true });
	}

	const proof = url.pathname.match(/^\/api\/proof\/(0x[0-9a-fA-F]{40})$/);
	if (request.method === "GET" && proof) {
		// written by `node tools/founders-tree.mjs` once you have approved the list
		const obj = await env.ART.get("founders/proofs.json");
		if (!obj) return Response.json({ onList: false, proof: [] });
		const proofs = await obj.json<Record<string, string[]>>();
		const p = proofs[proof[1].toLowerCase()];
		return Response.json({ onList: !!p, proof: p ?? [] });
	}

	return new Response("not found", { status: 404 });
}
