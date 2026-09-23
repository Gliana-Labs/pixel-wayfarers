export interface TierConfig {
	model: string;
	params: Record<string, string | number>;
	colors: number;
	/** redraw from the pose template (false for free-form 1/1s) */
	template?: boolean;
}

export interface Token {
	id: number;
	tier: string;
	name?: string;
	traits: Record<string, string>;
	prompt: string;
	seed: number;
	/** pose template name (config/poses/<pose>.png); absent for free-form legendaries */
	pose?: string;
}

/** Written by `python pipeline/wayfarers.py roll`, uploaded to R2 as manifest.json. */
export interface Manifest {
	tiers: Record<string, TierConfig>;
	tokens: Token[];
}

/** Fixed pose template every templated tier is redrawn from (same pose, head size, framing). */
export const POSE_TEMPLATE_KEY = "template/pose.png";
export const POSE_INSTRUCTION =
	"Redraw the gray mannequin in image 0 as the character described below. Keep exactly the same pose, " +
	"body size, head size, head position, arm and hand position and framing as image 0; the gray placeholder " +
	"object becomes the item named below. Change only the character, clothing, props and background. Character: ";

/** The token's pose template (arms match its item; head and framing identical across all poses). */
export async function loadPoseTemplate(env: Env, pose?: string): Promise<Uint8Array | undefined> {
	const obj = (pose && (await env.ART.get(`template/pose-${pose}.png`))) || (await env.ART.get(POSE_TEMPLATE_KEY));
	return obj ? new Uint8Array(await obj.arrayBuffer()) : undefined;
}

export async function loadManifest(env: Env): Promise<Manifest> {
	const obj = await env.ART.get("manifest.json");
	if (!obj) throw new Error("manifest.json missing in R2; run the roll + upload steps first");
	return obj.json<Manifest>();
}

export function randomSeed(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
}

/**
 * Returns decoded image bytes. Cloudflare-hosted FLUX.2 (`@cf/...`) takes multipart input even for
 * prompt-only calls; third-party BFL models (`black-forest-labs/flux-2-pro-preview`, `-max`) take JSON
 * and may answer with an image URL instead of base64.
 */
export async function generateImage(
	env: Env,
	model: string,
	prompt: string,
	params: Record<string, string | number>,
	seed: number,
	ref?: Uint8Array,
): Promise<Uint8Array> {
	if (!model.startsWith("@cf/")) {
		const out = (await env.AI.run(model as Parameters<Ai["run"]>[0], { prompt, seed, ...params } as never)) as unknown;
		return imageBytes(out);
	}

	const form = new FormData();
	form.append("prompt", prompt);
	form.append("seed", String(seed));
	for (const [key, value] of Object.entries(params)) form.append(key, String(value));
	if (ref) form.append("input_image_0", new Blob([ref], { type: "image/png" }), "template.png");

	// Response serializes the FormData and gives us the boundary content-type
	const body = new Response(form);
	const result = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
		multipart: { body: body.body, contentType: body.headers.get("content-type") },
	} as never)) as unknown;
	return imageBytes(result);
}

/** Model output -> bytes: a stream, a base64 string, or an https URL to download. */
async function imageBytes(result: unknown): Promise<Uint8Array> {
	if (result instanceof ReadableStream) {
		return new Uint8Array(await new Response(result).arrayBuffer());
	}
	// third-party models wrap it: { state: "Completed", result: { image } }
	const r = result as { image?: unknown; result?: { image?: unknown } };
	const image = r?.image ?? r?.result?.image;
	if (typeof image !== "string") {
		throw new Error(`unexpected AI response: ${JSON.stringify(result).slice(0, 200)}`);
	}
	if (image.startsWith("https://")) {
		const res = await fetch(image);
		if (!res.ok) throw new Error(`image download failed: ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}
	const b64 = image.replace(/^data:image\/\w+;base64,/, "");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
