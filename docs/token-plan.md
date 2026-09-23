# Token + NFT airdrop plan (draft)

Status: idea stage. Nothing here is announced. Do not mention a token on the site,
in the mint copy or on X before the NFT sale ends (see "Legal" below).

## Model we're copying

Trollface: NFT collection on Ethereum (3,333 Trolls), memecoin $TROLL on Solana,
community-driven airdrops, ~44k token holders. NFT = identity and status, token = liquid
meme that anyone can buy. The NFT holders get a head start, not a guarantee.

## Supply split (1,000,000,000 tokens)

| Bucket | % | Why | Unlock |
|---|---:|---|---|
| Liquidity pool | 45% | Deep pool at launch = less wild price, harder to rug-accuse | Day 0, LP tokens burned or locked 12 months |
| NFT holder airdrop | 15% | Rewards the people who bought first, pumps NFT demand before snapshot | 50% at launch, 50% over 90 days |
| Community campaigns | 15% | Quests, X raids, partner communities, meme contests, CEX/launchpad promos | Released per campaign |
| Treasury | 15% | Future listings, collabs, games, market making | Multisig, public wallet, monthly report |
| Team | 10% | Keeps the team aligned | 3-month cliff, then 12-month linear vest |

Lower team % than most launches on purpose: memecoin buyers read the team number first.
No private sale and no presale to the public: that is where most legal trouble starts.

## NFT airdrop by tier (15% pool)

Weights reward rarity without making commons worthless:

| Tier | NFTs | Weight | Tokens per NFT | Tier share of supply |
|---|---:|---:|---:|---:|
| Common | 600 | 1x | 72,464 | 4.35% |
| Uncommon | 250 | 2x | 144,928 | 3.62% |
| Rare | 100 | 4x | 289,855 | 2.90% |
| Epic | 40 | 8x | 579,710 | 2.32% |
| Legendary | 10 | 25x | 1,811,594 | 1.81% |

Optional boosters (announce the rules, not the numbers, until snapshot):
- **Holder streak:** +25% if the wallet held since mint (rewards not flipping).
- **Unlisted bonus:** +10% if the NFT is not listed for sale at snapshot (protects the floor).
- **Full set:** +10% for holding one of each tier.

## Timeline

1. **Mint + reveal.** No token talk.
2. **Weeks 1-4 after reveal: points, not promises.** Launch "Wayfarer XP" on the site:
   holding NFTs, daily check-ins, meme contests earn XP. XP has no stated value.
   This builds the habit and the leaderboard people screenshot on X.
3. **Announce the token + a surprise snapshot window.** A window (e.g. "sometime in
   the next 14 days") stops people buying one block before and dumping after.
4. **Claim site** on this same Worker: connect Ethereum wallet, sign a message,
   receive tokens (Merkle claim). If the token lives on Solana, the claim asks for a
   Solana address after the Ethereum signature.
5. **Launch day:** liquidity added, LP locked, claims open, campaigns start.

## Which chain for the token

| Chain | For | Against |
|---|---|---|
| Solana | Where memecoins trade, cheap, huge retail flow (Troll did this) | Cross-chain claim (ETH wallet -> SOL address), second tool stack |
| Ethereum mainnet | Same chain as the NFT, simplest claim | Gas spikes, fewer memecoin traders |
| Base | Cheap, Coinbase users, same EVM tooling | Smaller memecoin scene than Solana |

Default pick: **Solana** if the goal is hype and volume, **Base** if the goal is the
least engineering. Decide after the NFT sale based on where the holders are.

## Legal (read before announcing anything)

- Selling NFTs while promising a token airdrop can make the NFT look like an
  investment contract (US "Howey" test). Keep the mint copy about art only.
- Indonesia: crypto assets are supervised by OJK (since January 2025). Talk to a
  lawyer before issuing a token as an Indonesian person or company.
- Never promise price, returns, listings or "utility" dates.
- Block US persons from the claim if counsel says so; many projects geofence.

## Tooling we have

- `uniswap-trading:lp-integration` / `uniswap-driver:liquidity-planner` skills: liquidity pool setup on Base/Ethereum.
- `solana-dev` skill: SPL token, Merkle claim program, Solana wallet connect.
- `privy` skill: email/social login wallets so non-crypto fans can claim.
