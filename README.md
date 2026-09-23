# Pixel Wayfarers

1,000 AI-generated cozy pixel-art characters of every kind (chefs, pirates, astronauts, wizards...). Every token is generated from its own
rolled traits; the rarer the tier, the richer the prompt, the stronger the model and
the bigger the palette. Minted at ~$10 each on Base, traded on OpenSea.

## Rarity tiers

| Tier      | Count | Model                 | Palette | Art                                           |
|-----------|------:|-----------------------|--------:|-----------------------------------------------|
| Common    |   600 | flux-2-klein-4b       |      24 | clean, daylight                               |
| Uncommon  |   250 | flux-2-klein-4b       |      32 | detailed, golden hour                         |
| Rare      |   100 | flux-2-klein-4b       |      40 | rim light, sparkles, rare-only traits         |
| Epic      |    40 | flux-2-klein-9b       |      56 | glowing aura, epic-only traits                |
| Legendary |    10 | flux-2-klein-9b       |      64 | hand-written 1/1 scenes (`legendaries.yaml`)  |

Tokens can only get traits of their tier or below, and prefer their own tier
(`same_tier_boost`). Edit everything in `config/traits.yaml`.

## Cost (Workers AI)

~$0.0012 per klein-4b image, ~$0.017 per klein-9b image. The whole collection with
rerolls is under $5 of AI. Needs **Workers Paid ($5/mo)**: pixelation uses ~100ms CPU
per image, over the free plan's 10ms limit.

## Layout

- `config/` traits, tiers, legendaries (edit these)
- `pipeline/wayfarers.py` local: `roll`, `stats`, `pull`, `provenance`, `metadata`
- `worker/` Cloudflare Worker: Workers AI generation, pixelation, R2 storage,
  Workflows batch jobs, password-protected review gallery at `/admin`
- `contracts/` ERC-721 (Foundry)

## One-time Cloudflare setup

```bash
cd worker && npm install
npx wrangler r2 bucket create pixel-wayfarers
npx wrangler deploy                      # first deploy (or let Git integration do it)
npx wrangler secret put ADMIN_PASSWORD   # gallery login: any username + this password
```

### Git integration (Workers Builds)

Push this repo to GitHub (private or public: art and manifest live in R2, not git).
Dashboard -> Workers & Pages -> pixel-wayfarers -> Settings -> Builds -> Connect repo:

- Root directory: `worker`
- Deploy command: `npx wrangler deploy`

Every push to `main` then redeploys the Worker. Secrets survive redeploys.

## Pipeline

```bash
pip install -r requirements.txt
python pipeline/wayfarers.py roll       # build/manifest.json + trait stats
cd worker && npx wrangler r2 object put pixel-wayfarers/manifest.json \
  --file ../build/manifest.json --content-type application/json --remote
```

Then in the browser at `https://pixel-wayfarers.<you>.workers.dev/admin`:

1. **Generate**: enter `1-20` first, check results, then leave blank for all.
   Runs as Workflows (retries, resumable); progress counter updates live.
2. **Review**: filter by tier, click "reroll" on bad ones (new seed).

Consistency comes from the shared style prompt + pixelation. A style reference image
was tested and dropped: FLUX copied its clothes/props into every token.

Test locally first: `echo ADMIN_PASSWORD=test > worker/.dev.vars`, upload the manifest
with `--local` instead of `--remote`, run `npx wrangler dev`, open `localhost:8787/admin`.
Storage and Workflows stay local; only the AI calls hit Cloudflare.

Back locally:

```bash
cp .env.example .env                  # WORKER_URL + ADMIN_PASSWORD
python pipeline/wayfarers.py pull          # final PNGs -> build/images/
python pipeline/wayfarers.py provenance    # hash of final images
```

`roll` is deterministic (seed in config). Re-running it after editing traits
changes the manifest, so finish trait design before generating (and re-upload it).

## Upload + metadata

1. Upload `build/images/` folder to Pinata/Filebase -> `IMAGE_CID`.
2. `python pipeline/wayfarers.py metadata --image-cid IMAGE_CID`
3. Upload `build/metadata/` folder -> `META_CID`.
4. Make a hidden placeholder: upload a mystery image + a `hidden.json`
   (`{"name":"Pixel Wayfarers","description":"Unrevealed","image":"ipfs://.../mystery.png"}`) -> `HIDDEN_URI`.

## Contract (`contracts/`, Foundry)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std --no-git
forge test
```

`PixelWayfarers.sol`: 1,000 max supply, price settable by owner, 10 per wallet,
5% ERC-2981 royalty, hidden-until-reveal metadata, provenance hash, one-way freeze.

Launch order:
1. Deploy on Base with `price` = $10 in ETH at launch time, `HIDDEN_URI`, provenance hash.
2. `setSaleActive(true)`; share the mint link.
3. After sellout (or deadline): `reveal("ipfs://META_CID/")`, then `freezeMetadata()`.
4. Collection shows up on OpenSea automatically; claim it and set logo/banner/fees.

Hidden metadata matters: token ids are sequential, so if metadata were public before
mint, bots could time mints to grab legendaries.

## Rules

- No names, characters, sprites or logos from existing games in prompts or traits.
- Test on Base Sepolia before mainnet. Use a fresh deployer wallet.
