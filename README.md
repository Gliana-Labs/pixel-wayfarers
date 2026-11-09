# Pixel Wayfarers

## NEAR HACKATHON 2026: NFTs that earn (track `nfts`)

On NEAR, **each Wayfarer is an account of its own.** Minting #42 also creates `42.pixelwayfarers.testnet`, a real
NEAR account with no access keys, running one shared purse contract (`near/purse`, 1.3 KB, published once as a global
contract by its code hash, the pattern House of Stake's Top Level Accounts use). The NFT then:

- **owns money**: its account's balance, visible on any explorer;
- **earns royalties**: anyone can gift it a hobby item (12 of them: a guitar, a bowl of ramen, a corgi…, plus a short
  note). The money waits in escrow in the collection; when the studio delivers the item, **80% goes straight to the
  token's account** and 20% to the studio, which pays for the painting. Undelivered after 24 h, the buyer takes it all back;
- **holds inventory**: every delivered item is added to the token and stands on the shelf in its room (a dynamic NFT,
  NEP-171 `nft_metadata_update` with the item count);
- **spends its own money**: the holder can have the Wayfarer buy itself an item (`buy_item`, 0.05 NEAR). Its own account
  pays into escrow, the studio paints the item, and if it isn't delivered in 24 h the money goes back to the token. It
  earns, then spends on its hobbies;
- **pays other Wayfarers**: `gift_from` has one Wayfarer gift another a hobby from its own account (0.10 NEAR); 80% lands
  in the other's account on delivery. Money moves from NFT to NFT;
- **earns while you sleep**: with auto-stake on (`set_auto_stake`, holder only), anyone may call `auto_stake` at most
  every 6 hours to stake the token's idle NEAR with the pool its holder chose; the site's cron does, leaving 0.05 NEAR
  liquid. The money only ever becomes a stake in the token's own name;
- **opens a door**: the holders' Tavern at [pixelwayfarers.com/near/?tavern](https://pixelwayfarers.com/near/?tavern)
  checks a fresh NEP-413 signed message and `nft_tokens_for_owner` on every visit, so there's no session to keep;
- **moves with a sale**: `withdraw` pays whoever holds the token at that moment (1 yoctoNEAR, so the holder's wallet
  confirms). Sell the NFT and its account, its money and its access go with it;
- **earns from being sold**: 5% of every sale goes **into the token's own account**, on the collection's built-in market
  (`list`, `buy`, `delist`) and on any marketplace that follows NEP-199 payouts;
- **earns staking rewards**: the holder can stake the token's own NEAR with a NEAR validator (allow-listed pools). The
  stake is held by the token's account, so it moves with a sale too.

The threat model (every way a seller could try to keep the money, and what stops it) is in
[docs/NEAR-PLAN.md](docs/NEAR-PLAN.md).

### Try it (testnet)

1. **Read it, nothing to install:** open [pixelwayfarers.com/near](https://pixelwayfarers.com/near/). See: the Wayfarers
   minted on NEAR, each with the NEAR in its own account. Open one: its account, history (minted, got a gift, bought,
   paid out, transferred) and the items on its shelf.
2. **Use it, no wallet app needed:** press **Try it free** (top right). Your browser makes a key; the site creates
   `g<random>.guest.pixelwayfarers.testnet` for it with 0.8 test NEAR (ten a day per network). Mint, gift a hobby, let it
   buy one, list, buy, withdraw or enter the Tavern; every transaction is signed in your browser and the key never leaves it.
   See: your new Wayfarer's page, then the item on its shelf within about a minute and 80% of its price in the token's
   account. A NEAR wallet (Meteor) works too.
3. **Run the contract tests:** `cd near/collection && cargo test`. See: `29 passed`, including
   `a_sale_in_the_middle_of_a_payout_leaves_the_royalty_with_the_token`.
4. **Run the whole flow on testnet** (free; makes faucet accounts, keys in `~/.near-gliana`, 0600):
   `cd near && npm install && npm run build && npm run e2e:testnet`. See: eighteen `PASS` lines: mint creates the token
   and its keyless account; a gifted item waits in escrow; the royalty lands in the token's account; the holder
   withdraws; after a sale the seller can't, the buyer can; nobody can call the token's account directly; a
   marketplace sale (NEP-199) and a sale on the built-in market each put 5% into the token's account; the token stakes
   its own NEAR with `kiln.pool.f863973.m0`; the token buys itself an item with its own money, gifts #42 one from its own money, and someone else auto-stakes its idle NEAR for it.
5. **Check a token's account yourself:**
   `curl -s https://test.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"44.pixelwayfarers.testnet"}}'`.
   See: `"keys":[]`. Nobody holds a key to it; only the collection can move its money, and only for the holder.

The first version (`pixel-wayfarers.testnet`, tokens #42-#44) is kept as it was; v2 (`pixelwayfarers.testnet`) adds
resale royalties, staking and the built-in market, with a purse that can call a staking pool. v3 (the same account,
code-only upgrade) replaces painted scenes with hobby items and adds `buy_item`; its one-off migration (`drop_scenes`,
`near/scripts/migrate-v3.ts`) cleared the earlier scene pictures.

Items are painted by the worker (`worker/src/near.ts`): one object in that Wayfarer's own palette (its portrait is the
reference) on a flat key colour, then cut out, pixelated and sat on the shelf line by the pixel pipeline, then `fulfil`
signed with a studio key that may only call `fulfil`.

### Security review (2026-11-09)

Reviewed with NEAR's [`near-contract-audit`](https://skills.sh/near/agent-skills/near-contract-audit) skill and Trail of
Bits' [`entry-point-analyzer`](https://skills.sh/trailofbits/skills/entry-point-analyzer). Our own review, not an
independent audit. Every state-changing entry point and who may call it: `mint`, `commission`, `buy` (anyone, paying);
`withdraw`, `stake`, `unstake`, `withdraw_stake`, `list`, `buy_item`, `gift_from`, `set_auto_stake` (the token's current
holder; anything moving its money needs 1 yoctoNEAR); `auto_stake` (anyone, only for tokens whose holder opted in, at
most every 6 hours, only into a stake in the token's name); `delist` (the seller, or anyone once the listing is stale); `refund_expired` (anyone, to the buyer, after
24 h); `fulfil` (the studio account only); `set_prices`, `set_paused`, `add_pool` (owner, 1 yoctoNEAR);
`on_paid_out`, `on_purse_called`, `on_item_paid`, `on_gift_paid`, `drop_scenes`, `nft_resolve_transfer` (`#[private]`); the purse's `pay` and `call` (its parent
collection only).

| Finding | Status |
| --- | --- |
| A staking request was written into the history even when the token's account refused it (not enough NEAR) | Fixed: recorded only when the account accepts, and called "requested" because the pool answers later; the site shows the pool's real staked balance |
| A seller who buys the token back makes their old listing valid again | Documented; the seller can `delist` |
| If creating a token's account ever failed at mint, royalties sent to it would bounce back into the collection | Documented; not seen in testing |
| The collection's own account key could replace its code (and so instruct the purses) | Documented; delete that key at a mainnet launch. The purses themselves have no keys and fixed code |
| A Tavern signature can be replayed within its 10-minute window | Documented; there's no nonce store |
| `auto_stake` is open to anyone: a caller could stake more of an opted-in token's NEAR than the keeper would, leaving it little to spend | Accepted: the money stays the token's (a stake in its own name), it runs at most every 6 hours, and the holder can switch it off and unstake. Nothing can leave the token |
| An order opened by `buy_item` or `gift_from` before its payment arrived could be delivered unpaid | Prevented: the order is opened only in the callback, once the token's account has paid (`on_item_paid`, `on_gift_paid`) |

### Disclosure (hackathon rules Q-002, Q-003, Q-005, Q-015)

- **Before the hackathon** (tag [`pre-hackathon`](https://github.com/Gliana-Labs/pixel-wayfarers/tree/pre-hackathon)):
  the 1,000 artworks, the generation pipeline, the website and a Robinhood Chain contract that was never launched.
  **Built in the window:** everything on NEAR: `near/` (purse, collection, tests, scripts), `worker/src/near.ts`, the
  `/near` page, [docs/NEAR-PLAN.md](docs/NEAR-PLAN.md).
  [The diff](https://github.com/Gliana-Labs/pixel-wayfarers/compare/pre-hackathon...main).
- **Libraries:** near-sdk and near-contract-standards 5.30, @near-js, NEAR Wallet Selector, @noble/curves. Written with
  AI assistance (Claude Code).
- **Our other entry:** [Saku](https://github.com/Gliana-Labs/gliana-near-x402), an AI agent's budget enforced on NEAR
  (tracks `security`, `agents`). The two projects are independent.

---


1,000 AI-generated cozy pixel-art characters of every kind (chefs, pirates, astronauts, wizards...). Every token is generated from its own
rolled traits; the rarer the tier, the richer the prompt, the stronger the model and
the bigger the palette. Minted at 0.003 ETH (~$8) each on Robinhood Chain (Ethereum L2, chain 4663), traded on OpenSea.

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

- `config/` traits, tiers, legendaries (edit these); `pose-template.png` is the fixed pose every non-legendary token is redrawn from (upload it to R2 as `template/pose.png`)
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
python pipeline/review.py                  # local review app on http://localhost:8765: approve / reroll
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

`PixelWayfarers.sol`: max supply 1,000 (owner can only lower it with `cutSupply`), 20 per wallet in the public sale (50 for founders, both counting everything a wallet minted),
price settable by owner, 5% ERC-2981 royalty, hidden-until-reveal, a random `startingIndex` offset drawn after the sale (fair reveal),
metadata, provenance hash, one-way metadata freeze, `contractURI()` for OpenSea.

Deploy (keystore wallet, never paste a private key into a file):

```bash
cast wallet import deployer --interactive        # fresh wallet, fund with a little ETH
export PRICE_WEI=$(cast to-wei 0.003)            # 0.003 ETH (~$8)
export HIDDEN_URI=https://pixelwayfarers.com/hidden.json   # served by the site until reveal
export PROVENANCE=0x<hash from provenance>
export ROYALTY_RECEIVER=0xYourWallet
forge script script/Deploy.s.sol --rpc-url robinhood_testnet --account deployer --broadcast   # test first (chain 46630)
forge script script/Deploy.s.sol --rpc-url robinhood --account deployer --broadcast           # then mainnet (chain 4663)
# verify on Blockscout:
forge verify-contract <addr> src/PixelWayfarers.sol:PixelWayfarers --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/ --rpc-url robinhood
```

## Founders list (phase 1)

1. People follow @pixelwayfarers, post about us on X, then sign up on the site (X handle + post link + wallet).
   The Worker checks the post via X's free oEmbed endpoint: it exists, is by that handle, mentions pixelwayfarers,
   and each post counts for one wallet. Follows are honor-based (paid X API needed to check). Export: `curl -u admin:$ADMIN_PASSWORD https://pixelwayfarers.com/admin/founders`
2. Put the wallets you approve, one per line, in `build/founders-approved.txt`.
3. `cd worker && node tools/founders-tree.mjs ../build/founders-approved.txt`. It prints the root and the two commands:
   upload the proofs for the site, then `setAllowlist(root, 0.002 ETH)` on the contract.
4. `setAllowlistActive(true)` for about 48h, then `setAllowlistActive(false)` + `setSaleActive(true)` for the public sale.
   The site's mint box switches between "Founders mint" and "Mint" by itself. Founders get up to 50 per wallet, the public sale 20; both caps count every mint by that wallet.

## Launch + OpenSea

1. Deploy (above). Put the address in `worker/public/config.js`, push: site mint goes live.
2. `cast send <addr> "setSaleActive(bool)" true --rpc-url robinhood --account deployer`.
3. OpenSea indexes the contract by itself within minutes of the first mint. It reads
   `contractURI()` for name/logo/banner, and `tokenURI()` for each item.
4. On opensea.io, connect the **deployer wallet** -> the collection page -> edit
   (OpenSea Studio): set slug `pixel-wayfarers`, links (site, X), category, creator
   earnings payout address. Then request verification once there is volume.
5. Sale ends: sold out, or call `cutSupply(totalSupply)` to close at what sold.
6. Reveal: `setStartingIndex()` (random offset, sale must be off), then `reveal("ipfs://META_CID/")`, then on OpenSea hit "Refresh metadata"
   on the collection so every item updates, then `freezeMetadata()`.

Rarity on OpenSea: each token's `attributes` include `Rarity` plus the 7 traits.
OpenSea computes per-trait percentages ("4% have this trait") and a rarity rank
automatically once metadata is revealed; nothing extra to submit.

Hidden metadata matters: token ids are sequential, so if metadata were public before
mint, bots could time mints to grab legendaries.

## Rules

- The base style prompt names a game only to hit its art style; never use that name publicly (site, socials, OpenSea, metadata). No characters, sprites or logos from existing games in traits, and reject any render that looks like an existing character.
- Test on Robinhood Chain testnet before mainnet. Use a fresh deployer wallet, funded via the Arbitrum bridge (portal.arbitrum.io).
- RPC goes through `pixelwayfarers.com/api/rpc/{mainnet,testnet}` (a relay in the Worker) because some ISPs, including Indonesian ones, block robinhood.com.
