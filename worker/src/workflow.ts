import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { generateImage, loadManifest, loadStyleRef, randomSeed } from "./ai";
import { encodeRgbPng, OUT_SCALE, pixelGrid, upscaleNearest } from "./pixel";

export interface GenerateParams {
	id: number;
	/** regenerate even if a final image exists, with a fresh seed */
	force?: boolean;
}

/** One instance per token: generate -> store raw -> pixelate -> store final. */
export class GenerateToken extends WorkflowEntrypoint<Env, GenerateParams> {
	async run(event: WorkflowEvent<GenerateParams>, step: WorkflowStep) {
		const { id, force = false } = event.payload;

		const plan = await step.do("plan", async () => {
			const manifest = await loadManifest(this.env);
			const token = manifest.tokens.find((t) => t.id === id);
			if (!token) throw new NonRetryableError(`token ${id} not in manifest`);
			if (!force && (await this.env.ART.head(`final/${id}.png`))) return null;
			const tier = manifest.tiers[token.tier];
			return {
				tier: token.tier,
				model: tier.model,
				params: tier.params,
				colors: tier.colors,
				prompt: token.prompt,
				withReference: manifest.with_reference,
				// seeds are picked inside a step so a replay reuses the same one
				seed: force ? randomSeed() : token.seed,
			};
		});
		if (!plan) return { id, skipped: true };

		await step.do(
			"generate",
			{ retries: { limit: 8, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
			async () => {
				const ref = await loadStyleRef(this.env);
				const prompt = ref ? `${plan.withReference} ${plan.prompt}` : plan.prompt;
				const bytes = await generateImage(this.env, plan.model, prompt, plan.params, plan.seed, ref);
				await this.env.ART.put(`raw/${id}`, bytes, { customMetadata: { seed: String(plan.seed) } });
				return bytes.length;
			},
		);

		await step.do("pixelate", async () => {
			const raw = await this.env.ART.get(`raw/${id}`);
			if (!raw) throw new Error(`raw/${id} vanished`);
			const grid = pixelGrid(new Uint8Array(await raw.arrayBuffer()), plan.colors);
			const png = encodeRgbPng(upscaleNearest(grid, OUT_SCALE));
			await this.env.ART.put(`final/${id}.png`, png, {
				httpMetadata: { contentType: "image/png" },
				customMetadata: { seed: String(plan.seed), tier: plan.tier },
			});
			return png.length;
		});

		return { id, seed: plan.seed };
	}
}
