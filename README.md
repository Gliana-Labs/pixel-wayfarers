# Pixel Harvest

1,000 AI-generated cozy-farm pixel-art NFTs. Every token is generated from its own
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
rerolls is under $5; the free 10k neurons/day covers testing.
Free alternative: local ComfyUI + an SDXL pixel-art LoRA on your own GPU (more setup).

## Pipeline

```bash
pip install -r requirements.txt
cp .env.example .env              # add CF_ACCOUNT_ID + CF_API_TOKEN (Workers AI permission)

python pipeline/harvest.py style --count 8     # candidates in art/style-candidates/
cp art/style-candidates/3.png art/style-ref.png # pick your favourite = style anchor
python pipeline/harvest.py roll                 # build/manifest.json + trait stats
python pipeline/harvest.py generate --ids 1-20  # test a batch first
python pipeline/harvest.py pixelate
python pipeline/harvest.py sheet                # review build/sheets/*.png
python pipeline/harvest.py generate --ids 7,19 --force   # reroll bad ones
python pipeline/harvest.py generate             # the rest (resumable)
python pipeline/harvest.py pixelate
python pipeline/harvest.py provenance           # hash of final images
```

`roll` is deterministic (seed in config). Re-running it after editing traits
changes the manifest, so finish trait design before generating.

## Upload + metadata

1. Upload `build/images/` folder to Pinata/Filebase -> `IMAGE_CID`.
2. `python pipeline/harvest.py metadata --image-cid IMAGE_CID`
3. Upload `build/metadata/` folder -> `META_CID`.
4. Make a hidden placeholder: upload a mystery image + a `hidden.json`
   (`{"name":"Pixel Harvest","description":"Unrevealed","image":"ipfs://.../mystery.png"}`) -> `HIDDEN_URI`.

## Contract (`contracts/`, Foundry)

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cd contracts
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std --no-git
forge test
```

`PixelHarvest.sol`: 1,000 max supply, price settable by owner, 10 per wallet,
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
