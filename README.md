# Pixel Wayfarers

1,000 AI-generated cozy pixel-art characters of every kind (chefs, pirates, astronauts, wizards...). Every token is generated from its own
rolled traits; the rarer the tier, the richer the prompt, the stronger the model and
the bigger the palette. Minted at ~$10 each on Ethereum, traded on OpenSea.

## Rarity tiers

| Tier      | Count | Model                 | Palette | Art                                           |
|-----------|------:|-----------------------|--------:|-----------------------------------------------|
| Common    |   600 | flux-2-klein-4b       |      24 | clean, daylight                               |
| Uncommon  |   250 | flux-2-klein-4b       |      32 | detailed, golden hour                         |
| Rare      |   100 | flux-2-klein-4b       |      40 | rim light, sparkles, rare-only traits         |
| Epic      |    40 | flux-2-klein-4b       |      56 | glowing aura, epic-only traits                |
| Legendary |    10 | flux-2-klein-4b       |      64 | hand-written 1/1 scenes (`legendaries.yaml`)  |

Tokens can only get traits of their tier or below, and prefer their own tier
(`same_tier_boost`). Edit everything in `config/traits.yaml`.

## Cost (Workers AI)

All tiers use FLUX.2 klein 4B (~$0.0012 per image) with the original cozy prompt (commit bb72102); tokens the safety filter flags 5 times fall back to klein 9B. The whole collection with
rerolls is a few dollars of AI. Tested against 9B, pro and a game-named prompt: this look won. Needs **Workers Paid ($5/mo)**: pixelation uses ~100ms CPU
per image, over the free plan's 10ms limit.

## Layout

- `config/` traits, tiers, legendaries (edit these)
- `pipeline/wayfarers.py` local: `roll`, `stats`, `pull`, `provenance`, `metadata`
- `worker/` Cloudflare Worker: serves the marketing + mint site (`worker/public/`), and
  at `/admin` runs Workers AI generation, pixelation, R2 storage, Workflows batch jobs
  and a password-protected review gallery
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

## Website (`worker/public/`)

Static HTML/CSS/JS served by the same Worker, so Git integration deploys it too.

- `config.js`: contract address, chain, X and OpenSea links. Empty `contractAddress`
  shows "Mint opens soon"; fill it after deploying and the mint panel goes live
  (connect wallet, switch to Ethereum, mint, wait for receipt).
- `traits.json`: written by `roll`, feeds the trait explorer.
- `collection.json`: OpenSea collection metadata (name, logo, banner), read via `contractURI()`.
- `art/`: showcase images. Swap in your favourites from the final set.
- SEO: title/description, canonical, Open Graph + X card (`brand/og.png`), JSON-LD,
  `robots.txt`, `sitemap.xml`.

Custom domain: buy `pixelwayfarers.com` (Cloudflare Registrar is at cost), then
Workers & Pages -> pixel-wayfarers -> Settings -> Domains & Routes -> Add custom domain.

## Contract (`contracts/`, Foundry)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std --no-git
forge test
```

`PixelWayfarers.sol`: max supply 1,000 (owner can only lower it with `cutSupply`),
price settable by owner, 10 per wallet, 5% ERC-2981 royalty, hidden-until-reveal
metadata, provenance hash, one-way metadata freeze, `contractURI()` for OpenSea.

Deploy (keystore wallet, never paste a private key into a file):

```bash
cast wallet import deployer --interactive        # fresh wallet, fund with a little ETH
export PRICE_WEI=$(cast to-wei 0.004)            # 0.004 ETH (~$10)
export HIDDEN_URI=ipfs://HIDDEN_CID/hidden.json
export PROVENANCE=0x<hash from provenance>
export ROYALTY_RECEIVER=0xYourWallet
forge script script/Deploy.s.sol --rpc-url sepolia --account deployer --broadcast   # test first
forge script script/Deploy.s.sol --rpc-url mainnet --account deployer --broadcast   # then mainnet
```

## Launch + OpenSea

1. Deploy (above). Put the address in `worker/public/config.js`, push: site mint goes live.
2. `cast send <addr> "setSaleActive(bool)" true --rpc-url mainnet --account deployer`.
3. OpenSea indexes the contract by itself within minutes of the first mint. It reads
   `contractURI()` for name/logo/banner, and `tokenURI()` for each item.
4. On opensea.io, connect the **deployer wallet** -> the collection page -> edit
   (OpenSea Studio): set slug `pixel-wayfarers`, links (site, X), category, creator
   earnings payout address. Then request verification once there is volume.
5. Sale ends: sold out, or call `cutSupply(totalSupply)` to close at what sold.
6. Reveal: `reveal("ipfs://META_CID/")`, then on OpenSea hit "Refresh metadata"
   on the collection so every item updates, then `freezeMetadata()`.

Rarity on OpenSea: each token's `attributes` include `Rarity` plus the 7 traits.
OpenSea computes per-trait percentages ("4% have this trait") and a rarity rank
automatically once metadata is revealed; nothing extra to submit.

Hidden metadata matters: token ids are sequential, so if metadata were public before
mint, bots could time mints to grab legendaries.

## Rules

- The base style prompt names a game only to hit its art style; never use that name publicly (site, socials, OpenSea, metadata). No characters, sprites or logos from existing games in traits, and reject any render that looks like an existing character.
- Test on Sepolia before mainnet. Use a fresh deployer wallet.
