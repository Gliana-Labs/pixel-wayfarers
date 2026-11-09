/**
 * Pixel Wayfarers on NEAR (NEAR HACKATHON 2026): the studio and the Tavern.
 *
 *   - The studio paints hobby items. An order is a NEAR call on the collection (near/collection) with the money in
 *     escrow: someone gifting the Wayfarer an item (`commission`), or the Wayfarer buying one with its own money
 *     (`buy_item`). This worker paints the item as a pixel sprite in that Wayfarer's own palette, stores it in R2
 *     (served at /items/<net>/<collection>/<id>.png) and calls `fulfil` with a key that may only call `fulfil` (secret
 *     STUDIO_FULFIL_KEY). Runs on a cron, and right after an order when the site asks (`POST /api/near/deliver`).
 *   - The Tavern is the holders' room. Every request carries a fresh NEP-413 signed message: the signature is checked,
 *     the key must be one of the account's full-access keys, and the account must hold a Wayfarer right now
 *     (`nft_tokens_for_owner`). No session or cookie, so a seller loses access the moment the token moves.
 */
import { Account } from "@near-js/accounts";
import { KeyPair } from "@near-js/crypto";
import { FailoverRpcProvider, JsonRpcProvider } from "@near-js/providers";
import { KeyPairSigner } from "@near-js/signers";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { generateImage, loadManifest } from "./ai";
import { cutOut, encodeRgbaPng, pixelGrid, upscaleNearestRgba } from "./pixel";

/** Must match the collection's ITEMS order (near/collection, `item` is the index). */
export const ITEMS = [
	"an acoustic guitar",
	"a steaming bowl of ramen with chopsticks",
	"a corgi puppy sitting",
	"a potted monstera plant",
	"a skateboard",
	"a vintage film camera",
	"a mug of hot coffee",
	"a stack of three books",
	"a retro game controller",
	"an orange tabby cat sitting",
	"a basketball",
	"a pair of headphones",
	// 12-35, added 2026-11-09
	"a bicycle",
	"a surfboard",
	"a paint palette with brushes",
	"a chess board with pieces",
	"a telescope on a tripod",
	"a fishing rod",
	"a violin with its bow",
	"a pair of roller skates",
	"a bonsai tree in a pot",
	"a goldfish in a round bowl",
	"a hamster",
	"a green parrot",
	"a soccer ball",
	"a tennis racket and ball",
	"a basket of yarn with knitting needles",
	"a record player with a vinyl record",
	"an open laptop",
	"a small camera drone",
	"a plate of sushi",
	"a cupcake with frosting",
	"a teapot",
	"a stage microphone on a stand",
	"a camping tent",
	"an electric guitar",
];

const ITEM_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
const ITEM_GRID = 64; // sprite pixels; shown at 8x
const ITEM_COLORS = 24;

/**
 * Paints hobby item `item` for Wayfarer `id`: one object in the character's own palette and pixel style (image 0 is
 * its portrait), on a flat magenta key the cut-out removes, sat on the bottom edge so it stands on the room's shelf.
 */
export async function paintItem(env: Env, id: number, item: number, seed: number, note = "", withPortrait = true): Promise<Uint8Array> {
	const art = withPortrait ? await env.ART.get(`final/${id}.png`) : null;
	if (withPortrait && !art) throw new Error(`no artwork for #${id}`);
	const detail = note ? ` Detail: ${note.replace(/[^\p{L}\p{N} ,.'!?-]/gu, "").slice(0, 140)}.` : "";
	const prompt =
		`A single object: ${ITEMS[item] ?? ITEMS[0]}, the favourite hobby of the character in image 0.${detail} ` +
		"Draw ONLY the object, whole and centered, seen from a three-quarter angle, as a cozy pixel-art game item sprite with crisp dark outlines, " +
		(withPortrait ? "using the same colour palette and pixel style as image 0. " : "") +
		"No person, no character, no hands, no background scene, no floor, no shadow, no text. The object itself has no pink or magenta. " +
		"Plain flat solid magenta (#FF00FF) background filling the whole image.";
	const raw = await generateImage(env, ITEM_MODEL, prompt, { width: 768, height: 768 }, seed, art ? new Uint8Array(await art.arrayBuffer()) : undefined);
	return encodeRgbaPng(upscaleNearestRgba(cutOut(pixelGrid(raw, ITEM_COLORS, ITEM_GRID), ITEM_GRID), 8));
}
const MAX_PER_RUN = 3;

interface NearEnv {
	NEAR_NETWORK?: string;
	NEAR_COLLECTION?: string;
	NEAR_STUDIO?: string;
	STUDIO_FULFIL_KEY?: string;
}
type Commission = { id: string; token_id: string; buyer: string; item: number; note: string; amount: string; at: string };

// FastNEAR answers 429 to bursts, so every read and every transaction has somewhere else to go (all checked 2026-11-09).
const rpcUrls = (env: NearEnv) =>
	env.NEAR_NETWORK === "mainnet" ? ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"] : ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org", "https://near-testnet.drpc.org"];
const provider = (env: NearEnv) => new FailoverRpcProvider(rpcUrls(env).map((url) => new JsonRpcProvider({ url })));

/** A JSON-RPC `query`, trying the next RPC when one is busy or down. An error the chain itself returns is final. */
async function query<T>(env: NearEnv, params: object): Promise<{ result?: T; error?: { cause?: { name?: string } } }> {
	let last: unknown = "no answer";
	for (const url of rpcUrls(env)) {
		try {
			const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params }), signal: AbortSignal.timeout(8000) });
			if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status} from ${url}`);
			const j = await res.json<{ result?: T; error?: { cause?: { name?: string } } }>();
			if (j.result || !/TOO_MANY|TIMEOUT|INTERNAL|UNAVAILABLE|NO_SYNCED/i.test(JSON.stringify(j.error ?? ""))) return j;
			last = j.error;
		} catch (err) {
			last = String(err);
		}
	}
	return { error: { cause: { name: `no RPC answered: ${JSON.stringify(last).slice(0, 120)}` } } };
}
const collection = (env: NearEnv) => env.NEAR_COLLECTION ?? "pixelwayfarers.testnet";

async function view<T>(env: NearEnv, method: string, args: object = {}): Promise<T> {
	const j = await query<{ result?: number[] }>(env, { request_type: "call_function", finality: "final", account_id: collection(env), method_name: method, args_base64: btoa(JSON.stringify(args)) });
	if (!j.result?.result) throw new Error(`view ${method} failed: ${JSON.stringify(j.error ?? j).slice(0, 200)}`);
	return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result))) as T;
}

/** Paint one order and deliver it on chain. Idempotent: an already-painted item is reused. */
export async function deliver(env: Env & NearEnv, c: Commission): Promise<string> {
	if (!env.STUDIO_FULFIL_KEY) throw new Error("STUDIO_FULFIL_KEY is not set");
	// Per collection: order ids restart in each one.
	const key = `items/${env.NEAR_NETWORK ?? "testnet"}/${collection(env)}/${c.id}.png`;
	if (!(await env.ART.head(key))) {
		const png = await paintItem(env, Number(c.token_id), c.item, Number(c.id) * 7919 + Number(c.token_id), c.note);
		await env.ART.put(key, png, { httpMetadata: { contentType: "image/png" }, customMetadata: { token: c.token_id, order: c.id } });
	}
	const uri = `https://pixelwayfarers.com/${key}`;
	const studio = new Account(env.NEAR_STUDIO ?? "wayfarers-studio.testnet", provider(env), new KeyPairSigner(KeyPair.fromString(env.STUDIO_FULFIL_KEY as `ed25519:${string}`)));
	await studio.callFunction({ contractId: collection(env), methodName: "fulfil", args: { id: c.id, item_uri: uri }, gas: 50_000_000_000_000n });
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
	const key = await query<{ permission?: unknown }>(env, { request_type: "view_access_key", finality: "final", account_id: s.accountId, public_key: s.publicKey });
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

// ── guest accounts: try it with no wallet app (testnet only) ──────────────────────────────────────

const GUEST_PARENT = "guest.pixelwayfarers.testnet";
const GUEST_NEAR = 8n * 10n ** 23n; // 0.8 testnet NEAR: a mint, a commission and some change
const GUEST_PER_IP = 10;
const GUEST_DAILY_CAP = 12; // 9.6 test NEAR a day at most

/**
 * Makes `g<random>.guest.pixelwayfarers.testnet` for a public key the visitor's browser made, funded with 0.8 test
 * NEAR (secret GUEST_FUNDER_KEY, a testnet key of GUEST_PARENT). The private key never leaves the browser. Refused on
 * mainnet. Ten a day per IP (one was too few: a household, an office or a hackathon venue shares one address) and
 * GUEST_DAILY_CAP a day in all, so the funder can't be drained faster than it's topped up.
 */
export async function guest(env: Env & NearEnv & { GUEST_FUNDER_KEY?: string }, request: Request): Promise<Response> {
	if ((env.NEAR_NETWORK ?? "testnet") !== "testnet") return Response.json({ error: "Guest accounts are for testnet only." }, { status: 403 });
	if (!env.GUEST_FUNDER_KEY) return Response.json({ error: "Guest accounts are not set up." }, { status: 503 });
	const body = await request.json<{ public_key?: string }>().catch(() => ({}) as { public_key?: string });
	if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(body.public_key ?? "")) return Response.json({ error: "bad public key" }, { status: 400 });
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const tag = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wayfarers-guest:${ip}`))).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
	const day = new Date().toISOString().slice(0, 10);
	const marker = `guests/ip/${tag}`;
	const total = `guests/day/${day}`;
	const [seen, made] = await Promise.all([env.ART.get(marker), env.ART.get(total)]);
	// Older markers held a bare timestamp: count those as one account that day.
	const raw = seen ? await seen.text() : "";
	const mine = raw.startsWith("{") ? (JSON.parse(raw) as { day: string; n: number }) : raw ? { day: new Date(Number(raw)).toISOString().slice(0, 10), n: 1 } : { day, n: 0 };
	const usedHere = mine.day === day ? mine.n : 0;
	if (usedHere >= GUEST_PER_IP) return Response.json({ error: `That's ${GUEST_PER_IP} guest accounts from your network today. Use one you made, or try again tomorrow.` }, { status: 429 });
	const usedToday = made ? Number(await made.text()) : 0;
	if (usedToday >= GUEST_DAILY_CAP) return Response.json({ error: "Today's free guest accounts are all taken. Try again tomorrow, or connect a NEAR wallet." }, { status: 429 });
	const id = `g${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
	const funder = new Account(GUEST_PARENT, provider(env), new KeyPairSigner(KeyPair.fromString(env.GUEST_FUNDER_KEY as `ed25519:${string}`)));
	try {
		await funder.createSubAccount(id, body.public_key!, GUEST_NEAR);
	} catch (err) {
		console.error("guest_failed", String(err).slice(0, 300));
		return Response.json({ error: "Couldn't make a guest account right now. Try again in a minute." }, { status: 502 });
	}
	await Promise.all([env.ART.put(marker, JSON.stringify({ day, n: usedHere + 1 })), env.ART.put(total, String(usedToday + 1))]);
	return Response.json({ account_id: `${id}.${GUEST_PARENT}` });
}

// ── auto-stake keeper ──────────────────────────────────────────────────────────────────────────────

const AUTO_STAKE_GAP_S = 6 * 3600; // the contract's AUTO_STAKE_GAP_S
const LIQUID = 6n * 10n ** 22n; // 0.06 NEAR left in the Wayfarer's account: its storage plus 0.05 to spend
const MIN_STAKE = 10n ** 22n; // the contract's AUTO_STAKE_MIN, 0.01 NEAR

/**
 * For every Wayfarer whose holder switched auto-stake on: stake whatever its account holds beyond LIQUID, at most once
 * per window. `auto_stake` is open to anyone and can only move a token's money into a stake in the token's own name,
 * so the keeper needs no special key: it signs with the guest funder (GUEST_FUNDER_KEY), which pays the gas.
 */
export async function autoStakePass(env: Env & NearEnv & { GUEST_FUNDER_KEY?: string }): Promise<{ staked: string[]; failed: string[] }> {
	const staked: string[] = [];
	const failed: string[] = [];
	if (!env.GUEST_FUNDER_KEY) return { staked, failed };
	const due = (await view<[string, string, string][]>(env, "auto_stakers", { limit: 200 })).filter(([, , last]) => Date.now() / 1000 >= Number(last) + AUTO_STAKE_GAP_S);
	const keeper = new Account(GUEST_PARENT, provider(env), new KeyPairSigner(KeyPair.fromString(env.GUEST_FUNDER_KEY as `ed25519:${string}`)));
	for (const [token] of due.slice(0, 5)) {
		const acct = await query<{ amount: string }>(env, { request_type: "view_account", finality: "final", account_id: `${token}.${collection(env)}` });
		const spare = BigInt(acct.result?.amount ?? "0") - LIQUID;
		if (spare < MIN_STAKE) continue;
		try {
			await keeper.callFunction({ contractId: collection(env), methodName: "auto_stake", args: { token_id: token, amount: spare.toString() }, gas: 150_000_000_000_000n });
			staked.push(token);
		} catch (err) {
			console.error("auto_stake_failed", token, String(err).slice(0, 300));
			failed.push(token);
		}
	}
	return { staked, failed };
}
