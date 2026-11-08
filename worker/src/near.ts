/**
 * Pixel Wayfarers on NEAR (NEAR HACKATHON 2026): the studio and the Tavern.
 *
 *   - The studio paints commissions. A commission is a NEAR call on the collection (near/collection) with the money
 *     in escrow. This worker redraws the commissioned Wayfarer's own artwork into the chosen scene with the same model
 *     and pixel pipeline as the collection, stores it in R2 (served at /scenes/<id>.png) and calls `fulfil` with a key
 *     that may only call `fulfil` (secret STUDIO_FULFIL_KEY). The contract then pays the token's own account. Runs on
 *     a cron, and right after a commission when the site asks (`POST /api/near/deliver`).
 *   - The Tavern is the holders' room. Every request carries a fresh NEP-413 signed message: the signature is checked,
 *     the key must be one of the account's full-access keys, and the account must hold a Wayfarer right now
 *     (`nft_tokens_for_owner`). No session or cookie, so a seller loses access the moment the token moves.
 */
import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { generateImage, loadManifest } from "./ai";
import { encodeRgbPng, OUT_SCALE, pixelGrid, upscaleNearest } from "./pixel";

/** Must match the collection's SCENES order (near/collection, `scene` is the index). */
export const SCENES = [
	"a lantern-lit night market in Bali, steam rising from food stalls",
	"a rainy neon alley in Tokyo, reflections on wet stones",
	"a mountain campsite at sunrise, mist in the valley",
	"the window of a space station, Earth glowing below",
	"a cozy library with tall shelves and a reading lamp",
	"a beach at sunset with palm trees and gentle waves",
	"a snowy cabin with warm light in the windows",
	"a desert caravan resting under a starry sky",
	"sunken ruins underwater with fish and light rays",
	"a park full of cherry blossoms in spring",
	"a retro arcade glowing with game cabinets",
	"a village harvest festival with paper lanterns",
];

const SCENE_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const SCENE_COLORS = 40;
const MAX_PER_RUN = 3;

interface NearEnv {
	NEAR_NETWORK?: string;
	NEAR_COLLECTION?: string;
	NEAR_STUDIO?: string;
	STUDIO_FULFIL_KEY?: string;
}
type Commission = { id: string; token_id: string; buyer: string; scene: number; note: string; amount: string; at: string };

const rpcUrl = (env: NearEnv) => (env.NEAR_NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://test.rpc.fastnear.com");
const collection = (env: NearEnv) => env.NEAR_COLLECTION ?? "pixelwayfarers.testnet";

async function view<T>(env: NearEnv, method: string, args: object = {}): Promise<T> {
	const res = await fetch(rpcUrl(env), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: collection(env), method_name: method, args_base64: btoa(JSON.stringify(args)) } }),
	});
	const j = await res.json<{ result?: { result?: number[] }; error?: unknown }>();
	if (!j.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
	return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

/** Paint one commission and deliver it on chain. Idempotent: an already-painted scene is reused. */
export async function deliver(env: Env & NearEnv, c: Commission): Promise<string> {
	if (!env.STUDIO_FULFIL_KEY) throw new Error("STUDIO_FULFIL_KEY is not set");
	const key = `scenes/${env.NEAR_NETWORK ?? "testnet"}/${c.id}.png`;
	if (!(await env.ART.head(key))) {
		const id = Number(c.token_id);
		const art = await env.ART.get(`final/${id}.png`);
		if (!art) throw new Error(`no artwork for #${id}`);
		const manifest = await loadManifest(env);
		const token = manifest.tokens.find((t) => t.id === id);
		const who = token ? Object.values(token.traits).join(", ") : "the character";
		const note = c.note ? ` Detail: ${c.note.replace(/[^\p{L}\p{N} ,.'!?-]/gu, "").slice(0, 140)}.` : "";
		const prompt =
			`Keep the character from image 0 exactly the same: same face, hair, outfit, colors and item (${who}). ` +
			`Show them, full body and small in the frame, in this scene: ${SCENES[c.scene] ?? SCENES[0]}.${note} ` +
			"Cozy detailed pixel-art game style, warm light, the same look as image 0.";
		const raw = await generateImage(env, SCENE_MODEL, prompt, { width: 1024, height: 1024 }, Number(c.id) * 7919 + id, new Uint8Array(await art.arrayBuffer()));
		const png = encodeRgbPng(upscaleNearest(pixelGrid(raw, SCENE_COLORS), OUT_SCALE));
		await env.ART.put(key, png, { httpMetadata: { contentType: "image/png" }, customMetadata: { token: String(id), commission: c.id } });
	}
	const uri = `https://pixelwayfarers.com/${key}`;
	const studio = new Account(env.NEAR_STUDIO ?? "wayfarers-studio.testnet", new JsonRpcProvider({ url: rpcUrl(env) }), new KeyPairSigner(KeyPair.fromString(env.STUDIO_FULFIL_KEY as `ed25519:${string}`)));
	await studio.callFunction({ contractId: collection(env), methodName: "fulfil", args: { id: c.id, scene_uri: uri }, gas: 50_000_000_000_000n });
	return uri;
}

/** Cron and the site's nudge: deliver what's waiting, a few at a time. */
export async function deliverPending(env: Env & NearEnv, only?: string): Promise<{ delivered: string[]; failed: string[] }> {
	const pending = await view<Commission[]>(env, "pending", { limit: 20 });
	const todo = pending.filter((c) => !only || c.id === only).slice(0, MAX_PER_RUN);
	const delivered: string[] = [];
	const failed: string[] = [];
	for (const c of todo) {
		try {
			await deliver(env, c);
			delivered.push(c.id);
		} catch (err) {
			console.error("deliver_failed", c.id, String(err).slice(0, 300));
			failed.push(c.id);
		}
	}
	return { delivered, failed };
}

// ── the Tavern: NEP-413 signed messages, checked against who holds a Wayfarer now ────────────────

const NEP413_TAG = 2 ** 31 + 413;
const TAVERN_RECIPIENT = "pixelwayfarers.com";
const MAX_AGE_MS = 10 * 60 * 1000;

type Signed = { accountId: string; publicKey: string; signature: string; message: string; nonce: string; recipient?: string };

function borshString(s: string): Uint8Array {
	const b = new TextEncoder().encode(s);
	const out = new Uint8Array(4 + b.length);
	new DataView(out.buffer).setUint32(0, b.length, true);
	out.set(b, 4);
	return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let i = 0;
	for (const p of parts) {
		out.set(p, i);
		i += p.length;
	}
	return out;
}
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function fromB58(s: string): Uint8Array {
	const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
	let n = 0n;
	for (const c of s) {
		const v = A.indexOf(c);
		if (v < 0) throw new Error("bad base58");
		n = n * 58n + BigInt(v);
	}
	const hex = n.toString(16).padStart(64, "0");
	return Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** Who is asking, if their signed message is valid, fresh, from a full-access key, and they hold a Wayfarer now. */
export async function tavernHolder(env: Env & NearEnv, s: Signed): Promise<{ account: string; tokens: string[] } | { error: string }> {
	const m = /^Enter the Pixel Wayfarers Tavern at (\d{13})$/.exec(s.message ?? "");
	if (!m || Math.abs(Date.now() - Number(m[1])) > MAX_AGE_MS) return { error: "The signed message is missing or older than 10 minutes. Sign in again." };
	if ((s.recipient ?? TAVERN_RECIPIENT) !== TAVERN_RECIPIENT) return { error: "That message was signed for another site." };
	const nonce = fromB64(s.nonce ?? "");
	if (nonce.length !== 32) return { error: "bad nonce" };
	const tag = new Uint8Array(4);
	new DataView(tag.buffer).setUint32(0, NEP413_TAG, true);
	const payload = concat(tag, borshString(s.message), nonce, borshString(TAVERN_RECIPIENT), new Uint8Array([0]));
	const pub = fromB58((s.publicKey ?? "").replace(/^ed25519:/, ""));
	let valid = false;
	try {
		valid = ed25519.verify(fromB64(s.signature), sha256(payload), pub);
	} catch {
		valid = false;
	}
	if (!valid) return { error: "The signature doesn't match." };
	// NEP-413 requires a full-access key: a web wallet's sign-in key is not proof of the account.
	const key = await fetch(rpcUrl(env), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_access_key", finality: "final", account_id: s.accountId, public_key: s.publicKey } }),
	}).then((r) => r.json<{ result?: { permission?: unknown } }>());
	if (key.result?.permission !== "FullAccess") return { error: "That key isn't a full-access key of the account." };
	const tokens = await view<{ token_id: string }[]>(env, "nft_tokens_for_owner", { account_id: s.accountId, limit: 50 });
	if (!tokens.length) return { error: "This account holds no Wayfarer right now." };
	return { account: s.accountId, tokens: tokens.map((t) => t.token_id) };
}

type Post = { account: string; text: string; at: number };
const BOARD = "tavern/board.json";

/** The Tavern board: holders read and write it; nobody else can. */
export async function tavern(env: Env & NearEnv, body: Signed & { post?: string }): Promise<Response> {
	const who = await tavernHolder(env, body);
	if ("error" in who) return Response.json(who, { status: 403 });
	const board: Post[] = (await (await env.ART.get(BOARD))?.json<Post[]>()) ?? [];
	const text = (body.post ?? "").trim().slice(0, 140);
	if (text) {
		const mine = board.filter((p) => p.account === who.account);
		if (mine.length && Date.now() - mine[mine.length - 1].at < 60_000) return Response.json({ error: "One post a minute." }, { status: 429 });
		board.push({ account: who.account, text, at: Date.now() });
		await env.ART.put(BOARD, JSON.stringify(board.slice(-200)), { httpMetadata: { contentType: "application/json" } });
	}
	return Response.json({ holder: who, board: board.slice(-50).reverse() });
}
