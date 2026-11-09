# Pixel Wayfarers: NFTs that are NEAR accounts

**NEAR HACKATHON 2026 · track `nfts` (NFTs That Do Something) · live on NEAR testnet**

Every Wayfarer NFT is also **its own NEAR account with no keys**. Minting #42 creates `42.pixelwayfarers.testnet`.
That account **owns money, earns it, spends it on its own hobbies, and trades with other Wayfarers**. When the NFT is
sold, the account, its money, its stake and its items go to the buyer.

- **Live app:** [pixelwayfarers.com/near](https://pixelwayfarers.com/near/). **Try it free** makes you a testnet account
  in your browser, so no wallet is needed.
- **For judges:** [pixelwayfarers.com/near/?judge](https://pixelwayfarers.com/near/?judge) shows live numbers and every
  claim with a link to its proof.
- **Item market:** [pixelwayfarers.com/near/?market](https://pixelwayfarers.com/near/?market)

## What a Wayfarer does

| It… | How | Where to see it |
| --- | --- | --- |
| **is an account** | Mint creates `<id>.<collection>` with **zero access keys**. It runs `near/purse`, a 1.86 KB `no_std` contract published once as a NEAR **global contract** by its code hash; the purse pays out only when its parent collection asks. | [#42 on NearBlocks](https://testnet.nearblocks.io/address/42.pixelwayfarers.testnet) |
| **earns** | Anyone gifts it one of **36 hobby items** (`commission`, 0.20 NEAR). The money waits in escrow; on delivery **80% goes into the Wayfarer's own account**. It also gets **5% of every resale** (NEP-199 payouts and the built-in market). | [#65: 0.010 → 0.170 NEAR](https://pixelwayfarers.com/near/?token=65) |
| **holds inventory** | Each delivered item is stored on the token: kind, the Wayfarer it was painted for, and a **rarity rolled from the block's random seed** when it was ordered (common 60, uncommon 25, rare 10, epic 4, legendary 1). The metadata announces the count (`nft_metadata_update`). | [#42's shelf](https://pixelwayfarers.com/near/?token=42) |
| **can be topped up** | Anyone adds NEAR to a Wayfarer's account (`top_up`, at least 0.01); its history records who. From then on the money is the Wayfarer's: the holder can spend, stake or withdraw it. | [#75: topped up by a test account](https://pixelwayfarers.com/near/?token=75) |
| **spends its own money** | The holder has it buy itself an item (`buy_item`, 0.05 NEAR from its own account). If it can't afford it, the purse refuses and nothing happens. | [#63 bought itself a corgi](https://pixelwayfarers.com/near/?token=63) |
| **pays other NFTs** | It gifts another Wayfarer an item (`gift_from`), buys another Wayfarer's listed item (`list_item` / `buy_listed_item`), or makes an offer on any item (`make_offer` / `accept_offer` / `cancel_offer`). It always pays from its own account, and the money sits in escrow until the trade completes or is refunded. | [#42's history](https://pixelwayfarers.com/near/?token=42) |
| **earns while you sleep** | With auto-stake on (`set_auto_stake`), anyone may call `auto_stake` every 6 h to stake its idle NEAR with a validator, still in its own name; the site's cron does. The holder can also stake, unstake and withdraw by hand. | [#64 auto-staking with kiln](https://pixelwayfarers.com/near/?token=64) |
| **moves with a sale** | `withdraw` pays only whoever holds the NFT at that moment (1 yoctoNEAR, so the holder's wallet confirms). | the security review below |
| **opens a door** | The holders' **Tavern** checks a fresh NEP-413 signed message, a full-access key and `nft_tokens_for_owner` on every visit, so there is no session to steal. | [the Tavern](https://pixelwayfarers.com/near/?tavern) |

Standards: NEP-171/177/178/181 (via near-contract-standards 5.30), NEP-199 payouts, NEP-297 events, NEP-413 signed
messages. The threat model (every way a seller could try to keep the money, and what stops it) is in
[docs/NEAR-PLAN.md](docs/NEAR-PLAN.md).

## Try it (nothing to install)

1. Open [pixelwayfarers.com/near](https://pixelwayfarers.com/near/) and press **Try it free** (top right). Your browser
   makes a key, and the site creates `g<random>.guest.pixelwayfarers.testnet` for it with 0.8 test NEAR (ten a day per
   network). The key never leaves your browser. A NEAR wallet (Meteor) works too.
2. **Mint** a Wayfarer. Its page opens: its own account, the NEAR inside it, its shelf and its history.
3. **Gift it a hobby**. Within about a minute the studio paints the item onto its shelf, and 80% of the price is in its
   account.
4. Let it **buy itself** an item, put an item on the **market**, make an **offer** on another Wayfarer's item, turn on
   **auto-stake**, or enter the **Tavern**.

## Run it yourself

Prerequisites: Rust (the `rust-toolchain.toml` files pin 1.95 with `wasm32-unknown-unknown`;
[rustup](https://rustup.rs) installs it on first use), [cargo-near](https://github.com/near/cargo-near) 0.22 or later,
and Node 22 or later.

```bash
git clone https://github.com/Gliana-Labs/pixel-wayfarers && cd pixel-wayfarers/near
npm install

# 1. Contract tests: no network needed.
cd collection && cargo test && cd ..
#    → test result: ok. 53 passed (every refusal and refund path: trades, offers, gifts, auto-stake, payouts)

# 2. Build both contracts to wasm.
npm run build
#    → purse/target/near/wayfarer_purse.wasm (1.86 KB) and collection/target/near/wayfarers.wasm

# 3. The whole flow on NEAR testnet, on a fresh copy you deploy yourself (free: faucet accounts, keys saved owner-only
#    in ~/.near-gliana). Pick any unused name.
COLLECTION=yourname-wayfarers.testnet npm run e2e:testnet
#    → 21 PASS lines: it publishes the purse as a global contract, deploys and initialises the collection, mints a
#      keyless token account, gifts an item (0.01 → 0.17 NEAR in the token's account), withdraws, sells, checks that
#      the seller is locked out, NEP-199 payout, built-in market, staking, buy_item, gift_from, auto_stake, a rarity
#      roll, an item trade, and an accepted offer.
```

Last full run: 21/21 PASS on a fresh `wf-check-18568.testnet` (2026-11-10). The public testnet RPCs sometimes answer
429 or "Transaction has expired"; the script retries those, and re-running it reuses the accounts it made.

The web app is `near/web/app.ts`; `npm run web` bundles it into `worker/public/near/`. The worker (`worker/`) serves
the site, paints items (`worker/src/near.ts`), creates guest accounts and runs the auto-stake keeper; it deploys from
`main` with Cloudflare Workers Builds.

## How it's built

```
browser (/near)        signs with a guest key or a NEAR wallet; reads NEAR RPC directly (3 RPCs, failover)
   │ transactions
   ▼
collection contract    pixelwayfarers.testnet (near/collection, Rust, near-sdk 5.30)
   │  NEP-171 tokens, escrow for gifts, items, offers and trades, rarity rolls, auto-stake list
   │ "pay"/"call" (only it may)
   ▼
token accounts         42.pixelwayfarers.testnet … no keys; run near/purse (global contract, 1.86 KB)
                       hold the money, pay out, stake with allow-listed validator pools

worker (Cloudflare)    paints items (flux-2-klein-4b, cut out and pixelated) and calls `fulfil` with a key that can
                       call only `fulfil`; guest accounts; the auto-stake keeper; the Tavern's NEP-413 check
```

## How it maps to the judging criteria

- **Technical implementation:** per-token accounts with no keys, run by a global contract; every payment a Wayfarer
  makes goes through escrow plus a callback that re-checks and refunds; NEP-199 payouts; staking through the token's
  own account; on-chain rarity. 55 unit tests, a 21-step testnet run, and the security review below.
- **Design:** you can use it without a wallet. Each Wayfarer has a page with its money, its shelf and its history, plus
  an item market with filters and offers, readable errors, and money checks before you sign.
- **Impact:** NFT holders usually own only a picture. A Wayfarer is worth at least the money inside it, which anyone
  can check on an explorer, and other people pay into it (gifts and resales). The same pattern works for memberships,
  game characters and creator tokens.
- **Originality:** NFTs that earn, spend on their own hobbies, and trade items with each other using their own money.
- **Sustainability:** the studio's 20% pays for the painting (one Workers AI image per item), and the
  contracts need no server to keep anyone's money safe. Mainnet comes only after an outside security review (see the
  roadmap on the homepage).

## Security review (2026-11-09)

Reviewed with NEAR's [`near-contract-audit`](https://skills.sh/near/agent-skills/near-contract-audit) skill and Trail of
Bits' [`entry-point-analyzer`](https://skills.sh/trailofbits/skills/entry-point-analyzer). Our own review, not an
independent audit. Every state-changing entry point and who may call it: `mint`, `commission`, `buy` (anyone, paying);
`withdraw`, `stake`, `unstake`, `withdraw_stake`, `list`, `buy_item`, `gift_from`, `set_auto_stake`, `list_item`, `buy_listed_item`, `make_offer`, `accept_offer` (the token's current
holder; anything moving its money needs 1 yoctoNEAR); `auto_stake` (anyone, only for tokens whose holder opted in, at
most every 6 hours, only into a stake in the token's name); `delist` (the seller, or anyone once the listing is stale); `refund_expired` (anyone, to the buyer, after
24 h); `fulfil` (the studio account only); `set_prices`, `set_paused`, `add_pool` (owner, 1 yoctoNEAR);
`on_paid_out`, `on_purse_called`, `on_item_paid`, `on_gift_paid`, `on_item_traded`, `on_offer_paid`, `drop_scenes`, `migrate_inventory`, `nft_resolve_transfer` (`#[private]`); the purse's `pay` and `call` (its parent
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
| An item could be sold twice, or under a stale price, between `buy_listed_item` and its payment landing | Prevented: `on_item_traded` re-checks the listing (same price, still held by whoever listed it, room on the buyer's shelf) and refunds the buyer Wayfarer otherwise |
| Offer money could be stranded if the offering holder disappears | Prevented: anyone may `cancel_offer` after 7 days, and the money always goes back to the offering Wayfarer's account, never to the caller |
| Rarity from `random_seed` is known to the block producer | Accepted for a hobby item: a validator could at most skew which tier an item rolls in its own block |

## Disclosure (hackathon rules Q-002, Q-003, Q-005, Q-015)

- **Before the hackathon** (tag [`pre-hackathon`](https://github.com/Gliana-Labs/pixel-wayfarers/tree/pre-hackathon)):
  the 1,000 artworks, the generation pipeline, the website and a Robinhood Chain contract that was never launched
  (now described in [docs/BEFORE-NEAR.md](docs/BEFORE-NEAR.md)).
  **Built in the window:** everything on NEAR: `near/` (purse, collection, tests, scripts), `worker/src/near.ts`, the
  `/near` page, [docs/NEAR-PLAN.md](docs/NEAR-PLAN.md).
  [The diff](https://github.com/Gliana-Labs/pixel-wayfarers/compare/pre-hackathon...main).
- **Libraries:** near-sdk and near-contract-standards 5.30, @near-js, NEAR Wallet Selector, @noble/curves. Written with
  AI assistance (Claude Code).
- **Our other entry:** [Saku](https://github.com/Gliana-Labs/gliana-near-x402), an AI agent's budget enforced on NEAR
  (tracks `security`, `agents`). The two projects are independent.
