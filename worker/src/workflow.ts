import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { generateImage, loadManifest, loadPoseTemplate, POSE_INSTRUCTION, randomSeed } from "./ai";
import { encodeRgbPng, OUT_SCALE, pixelGrid, upscaleNearest } from "./pixel";

const FLAGGED_SEED_TRIES = 5;
/** used only for tokens whose every seed gets flagged on the main model (a filter false positive) */
const FALLBACK_MODEL = "@cf/black-forest-labs/flux-2-klein-9b";

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
				template: tier.template ?? false,
				pose: token.pose,
				prompt: token.prompt,
				// seeds are picked inside a step so a replay reuses the same one
				seed: force ? randomSeed() : token.seed,
			};
		});
		if (!plan) return { id, skipped: true };

		const usedSeed = await step.do(
			"generate",
			{ retries: { limit: 8, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" },
			async () => {
				// no style reference image: in testing it leaked its clothing/props into every token;
				// the shared style prompt + pixelation keep the collection consistent on their own.
				// The safety filter sometimes flags a harmless render (3030); a new seed usually passes,
				// while retrying the same seed never would.
				// templated tiers are redrawn from the fixed pose so the whole collection shares one framing
				const ref = plan.template ? await loadPoseTemplate(this.env, plan.pose) : undefined;
				if (plan.template && !ref) throw new NonRetryableError("pose template missing in R2 (template/pose.png)");
				const prompt = ref ? POSE_INSTRUCTION + plan.prompt : plan.prompt;
				const attempts = [
					...Array.from({ length: FLAGGED_SEED_TRIES }, (_, n) => ({ model: plan.model, seed: plan.seed + n })),
					...(plan.model === FALLBACK_MODEL
						? []
						: Array.from({ length: 3 }, (_, n) => ({ model: FALLBACK_MODEL, seed: plan.seed + 100 + n }))),
				];
				for (const { model, seed } of attempts) {
					try {
						const bytes = await generateImage(this.env, model, prompt, plan.params, seed, ref);
						await this.env.ART.put(`raw/${id}`, bytes, { customMetadata: { seed: String(seed), model } });
						return seed;
					} catch (err) {
						if (!String(err).includes("3030")) throw err;
					}
				}
				throw new NonRetryableError(`token ${id}: every attempt flagged by the safety filter; edit its traits and reroll`);
			},
		);

		await step.do("pixelate", async () => {
			const raw = await this.env.ART.get(`raw/${id}`);
			if (!raw) throw new Error(`raw/${id} vanished`);
			const grid = pixelGrid(new Uint8Array(await raw.arrayBuffer()), plan.colors);
			const png = encodeRgbPng(upscaleNearest(grid, OUT_SCALE));
			await this.env.ART.put(`final/${id}.png`, png, {
				httpMetadata: { contentType: "image/png" },
				// model shows up in /admin/img metadata so fallback renders can be reviewed
				customMetadata: { seed: String(usedSeed), tier: plan.tier, model: raw.customMetadata?.model ?? plan.model },
			});
			return png.length;
		});

		return { id, seed: usedSeed };
	}
}
