export interface TierConfig {
	model: string;
	params: Record<string, string | number>;
	colors: number;
}

export interface Token {
	id: number;
	tier: string;
	name?: string;
	traits: Record<string, string>;
	prompt: string;
	seed: number;
}

/** Written by `python pipeline/wayfarers.py roll`, uploaded to R2 as manifest.json. */
export interface Manifest {
	tiers: Record<string, TierConfig>;
	tokens: Token[];
}

export async function loadManifest(env: Env): Promise<Manifest> {
	const obj = await env.ART.get("manifest.json");
	if (!obj) throw new Error("manifest.json missing in R2; run the roll + upload steps first");
	return obj.json<Manifest>();
}

export function randomSeed(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
}

/** FLUX.2 klein takes multipart input even for prompt-only calls; returns decoded image bytes. */
export async function generateImage(
	env: Env,
	model: string,
	prompt: string,
	params: Record<string, string | number>,
	seed: number,
): Promise<Uint8Array> {
	const form = new FormData();
	form.append("prompt", prompt);
	form.append("seed", String(seed));
	for (const [key, value] of Object.entries(params)) form.append(key, String(value));

	// Response serializes the FormData and gives us the boundary content-type
	const body = new Response(form);
	const result = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
		multipart: { body: body.body, contentType: body.headers.get("content-type") },
	} as never)) as unknown;

	if (result instanceof ReadableStream) {
		return new Uint8Array(await new Response(result).arrayBuffer());
	}
	const image = (result as { image?: unknown })?.image;
	if (typeof image !== "string") {
		throw new Error(`unexpected AI response: ${JSON.stringify(result).slice(0, 200)}`);
	}
	return Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
}
