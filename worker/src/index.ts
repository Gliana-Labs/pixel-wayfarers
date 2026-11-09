import { generateImage, loadManifest, loadPoseTemplate, POSE_INSTRUCTION, randomSeed, type Token } from "./ai";
import { galleryPage } from "./gallery";
import { autoStakePass, deliverPending, guest, tavern } from "./near";

export { GenerateToken } from "./workflow";

const BATCH = 100; // max instances per createBatch call

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname.startsWith("www.")) {
			url.hostname = url.hostname.slice(4);
			return Response.redirect(url.toString(), 301);
		}
		const near = await nearPublic(request, env, url);
		if (near) return near;
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
	// Delivers NEAR commissions that are waiting (see src/near.ts).
	async scheduled(_event, env, ctx): Promise<void> {
		ctx.waitUntil(deliverPending(env).then((r) => console.log("near_deliver", JSON.stringify(r))));
		ctx.waitUntil(autoStakePass(env).then((r) => r.staked.length + r.failed.length && console.log("near_auto_stake", JSON.stringify(r))));
	},
} satisfies ExportedHandler<Env>;

/**
 * Pixel Wayfarers on NEAR (NEAR HACKATHON 2026). Artwork is served only for tokens minted on the NEAR collection, so
 * nothing else of the collection is revealed early; items are served from R2; the Tavern and delivery are POSTs.
 */
async function nearPublic(request: Request, env: Env, url: URL): Promise<Response | null> {
	const art = url.pathname.match(/^\/art\/(full|meta)\/(\d{1,4})\.(png|json)$/);
	if (art && request.method === "GET") {
		const id = Number(art[2]);
		if (!(await mintedOnNear(env, id))) return new Response("not minted", { status: 404 });
		if (art[1] === "full") {
			const obj = await env.ART.get(`final/${id}.png`);
			if (!obj) return new Response("not found", { status: 404 });
			return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
		}
		const token = (await loadManifest(env)).tokens.find((t) => t.id === id);
		if (!token) return new Response("not found", { status: 404 });
		return Response.json({
			name: `Pixel Wayfarers #${id}`,
			image: `https://pixelwayfarers.com/art/full/${id}.png`,
			attributes: [{ trait_type: "Rarity", value: token.tier }, ...Object.entries(token.traits).map(([trait_type, value]) => ({ trait_type, value }))],
		}, { headers: { "cache-control": "public, max-age=3600" } });
	}
	// /items/<net>/<collection>/<id>.png: hobby items the studio painted, on chain in each token's inventory.
	const item = url.pathname.match(/^\/items\/(testnet|mainnet)\/([a-z0-9._-]{2,64})\/(\d{1,10})\.png$/);
	if (item && request.method === "GET") {
		const obj = await env.ART.get(`items/${item[1]}/${item[2]}/${item[3]}.png`);
		if (!obj) return new Response("not found", { status: 404 });
		return new Response(obj.body, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
	}
	if (request.method === "POST" && url.pathname === "/api/near/deliver") {
		const body = await request.json<{ id?: string }>().catch(() => ({}) as { id?: string });
		return Response.json(await deliverPending(env, body.id));
	}
	if (request.method === "POST" && url.pathname === "/api/near/guest") return guest(env, request);
	if (request.method === "POST" && url.pathname === "/api/near/tavern") {
		const body = await request.json<Parameters<typeof tavern>[1]>().catch(() => null);
		if (!body) return Response.json({ error: "bad request" }, { status: 400 });
		return tavern(env, body);
	}
	return null;
}

/** Has token `id` been minted on the NEAR collection? Cached for 10 minutes at the edge. */
async function mintedOnNear(env: Env, id: number): Promise<boolean> {
	const cacheKey = new Request(`https://pixelwayfarers.com/__near_minted/${env.NEAR_NETWORK ?? "testnet"}/${id}`);
	const hit = await caches.default.match(cacheKey);
	if (hit) return (await hit.text()) === "1";
	const res = await fetch((env.NEAR_NETWORK as string) === "mainnet" ? "https://rpc.mainnet.near.org" : "https://test.rpc.fastnear.com", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: env.NEAR_COLLECTION ?? "pixelwayfarers.testnet", method_name: "nft_token", args_base64: btoa(JSON.stringify({ token_id: String(id) })) } }),
	}).then((r) => r.json<{ result?: { result?: number[] } }>()).catch(() => null);
	const minted = Boolean(res?.result?.result && new TextDecoder().decode(new Uint8Array(res.result.result)) !== "null");
	await caches.default.put(cacheKey, new Response(minted ? "1" : "0", { headers: { "cache-control": `max-age=${minted ? 600 : 60}` } }));
	return minted;
}

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

	if (path === "/admin/xcheck") {
		return Response.json(await checkXPost(url.searchParams.get("u") ?? "", url.searchParams.get("h") ?? ""));
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

const RPC_METHODS = new Set([
	"eth_chainId", "net_version", "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_gasPrice",
	"eth_maxPriorityFeePerGas", "eth_feeHistory", "eth_getBalance", "eth_getCode", "eth_getTransactionCount",
	"eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_getBlockByHash",
	"eth_sendRawTransaction", "eth_getLogs", "eth_getStorageAt", "web3_clientVersion",
]);

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const X_HANDLE = /^@?[A-Za-z0-9_]{1,15}$/;

/** Public endpoints: founders-list signup and mint proofs. No auth. */
async function publicApi(request: Request, env: Env, url: URL): Promise<Response> {
	if (request.method === "POST" && url.pathname === "/api/founders") {
		let body: { x?: string; wallet?: string; post?: string; follows?: boolean };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "bad request" }, { status: 400 });
		}
		const wallet = (body.wallet ?? "").trim();
		const x = (body.x ?? "").trim().replace(/^@/, "");
		if (!WALLET.test(wallet)) return Response.json({ error: "That is not a valid Ethereum wallet address." }, { status: 400 });
		if (!X_HANDLE.test(x)) return Response.json({ error: "That is not a valid X handle." }, { status: 400 });
		if (!body.follows) return Response.json({ error: "Please follow @pixelwayfarers on X first." }, { status: 400 });
		const key = `founders/signups/${wallet.toLowerCase()}.json`;
		if (await env.ART.head(key)) return Response.json({ ok: true, already: true });
		const check = await checkXPost(body.post ?? "", x);
		if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });
		// one post can only ever count for one wallet
		const postKey = `founders/posts/${check.id}`;
		const used = await env.ART.get(postKey);
		if (used && (await used.text()) !== wallet.toLowerCase()) {
			return Response.json({ error: "That post was already used to sign up another wallet." }, { status: 400 });
		}
		await env.ART.put(postKey, wallet.toLowerCase());
		await env.ART.put(
			key,
			JSON.stringify({ wallet: wallet.toLowerCase(), x, post: `https://x.com/${x}/status/${check.id}`, at: new Date().toISOString() }),
			{ httpMetadata: { contentType: "application/json" } },
		);
		return Response.json({ ok: true });
	}

	// JSON-RPC relay to Robinhood Chain: some ISPs (e.g. Indonesian DNS filtering) block robinhood.com,
	// so the site and wallets use this instead. Signed transactions pass through untouched.
	const rpc = url.pathname.match(/^\/api\/rpc\/(mainnet|testnet)$/);
	if (rpc) {
		const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" };
		if (request.method === "OPTIONS") return new Response(null, { headers: cors });
		if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
		const body = await request.text();
		if (body.length > 256_000) return new Response("too large", { status: 413, headers: cors });
		let calls: { method?: string }[];
		try {
			const parsed = JSON.parse(body);
			calls = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			return new Response("bad json", { status: 400, headers: cors });
		}
		if (calls.length > 20 || calls.some((c) => !RPC_METHODS.has(c.method ?? ""))) {
			return Response.json({ error: "method not allowed" }, { status: 403, headers: cors });
		}
		const upstream = rpc[1] === "mainnet" ? "https://rpc.mainnet.chain.robinhood.com" : "https://rpc.testnet.chain.robinhood.com";
		const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
		return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", ...cors } });
	}

	const proof = url.pathname.match(/^\/api\/proof\/(0x[0-9a-fA-F]{40})$/);
	if (request.method === "GET" && proof) {
		// written by `node tools/founders-tree.mjs` once you have approved the list
		// ?network=testnet reads a separate list so test runs never touch the real founders list
		const file = url.searchParams.get("network") === "testnet" ? "founders/proofs-testnet.json" : "founders/proofs.json";
		const obj = await env.ART.get(file);
		if (!obj) return Response.json({ onList: false, proof: [] });
		const proofs = await obj.json<Record<string, string[]>>();
		const p = proofs[proof[1].toLowerCase()];
		return Response.json({ onList: !!p, proof: p ?? [] });
	}

	return new Response("not found", { status: 404 });
}

const POST_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/(\d{5,25})/;

/**
 * Checks a public X post via X's free oEmbed endpoint: it must exist, be written by `handle`,
 * and mention @pixelwayfarers or pixelwayfarers.com.
 */
async function checkXPost(postUrl: string, handle: string): Promise<{ ok: boolean; reason?: string; id?: string }> {
	const m = postUrl.trim().match(POST_URL);
	if (!m) return { ok: false, reason: "Paste the link to your post, like https://x.com/you/status/123..." };
	const want = handle.trim().replace(/^@/, "").toLowerCase();
	const res = await fetch(`https://publish.twitter.com/oembed?omit_script=1&dnt=1&url=${encodeURIComponent(`https://x.com/${m[1]}/status/${m[2]}`)}`);
	if (!res.ok) return { ok: false, reason: "We could not find that post. Is it public?" };
	const data = await res.json<{ author_url?: string; html?: string }>();
	const author = (data.author_url ?? "").split("/").pop()?.toLowerCase() ?? "";
	if (want && author !== want) return { ok: false, reason: `That post is by @${author}, not @${want}.` };
	const text = (data.html ?? "").toLowerCase();
	if (!text.includes("pixelwayfarers")) return { ok: false, reason: "Your post needs to mention @pixelwayfarers or pixelwayfarers.com." };
	return { ok: true, id: m[2] };
}
