# Pixel Wayfarers on NEAR: NFTs that earn

NEAR HACKATHON 2026, track **NFTs That Do Something** (`nfts`). Deadline 2026-11-14 23:59 UTC.

## The idea

1,000 pixel-art characters (art and metadata made before the hackathon, on IPFS). On NEAR each Wayfarer is
**an account that earns**: anyone can commission a new scene starring a Wayfarer ("your chef Wayfarer in a Bali
night market"). The scene is generated in the collection's own style from that token's traits, and the commission
is split on chain: most of it to **the Wayfarer's own purse**, the rest to the studio that pays for the generation.
The purse belongs to the token, not to whoever holds it, so a sale moves the money and the right to it together.

**Each Wayfarer is a real NEAR account.** Minting #42 also creates `42.<collection>`, a sub-account that runs one
shared purse contract (published once as a global contract, by code hash, so it can never change and costs each
token about 100 bytes, the same pattern as House of Stake's Top Level Accounts). Royalties are sent straight to that
account, so its balance is visible on any explorer. The purse obeys only its parent, the collection, and the
collection only obeys whoever holds token #42 right now.
Each delivered scene is added to the token: the NFT's gallery grows (a dynamic NFT).

## What gets built in the window

| Part | What |
|---|---|
| `near/purse/` | The shared purse: `pay(receiver_id, amount)`, callable only by its parent account (the collection). No keys on the account. |
| `near/contract/` | NEP-171 collection (+ approvals, enumeration, metadata). Mint creates the token's purse account, commission escrow, `fulfil`, `refund_expired`, `withdraw` by the current owner, per-token history (earned, paid out, holders), NEP-297 events. Tests, including a sale in the middle of a payout. |
| `worker/` (existing) | Picks up commissions, generates the scene with the GlianaAI gateway in the collection's style, pixelates it, stores it, calls `fulfil` with a key that may only call `fulfil`. |
| `worker/public/` (existing site) | Mint, gallery, a page per Wayfarer (purse, history, scenes, commission button), and the **Tavern**: a page only current holders can open (NEP-413 signed message, checked against `nft_token` on every request). |
| Stretch | Each Wayfarer also gets its own **Base address through Chain Signatures** (derived from the collection and the token id), so it can earn USDC on another chain; only the current holder can have it signed out. |

## Threat model: every way a seller could try to keep the money

Rule: **earnings belong to the token.** Whoever holds the token when `withdraw` runs gets the purse.

| Attempt | What stops it |
|---|---|
| Withdraw the purse just before selling | Allowed, and visible: the purse balance is a public view and shown on every page and in the history. A buyer prices what's in it at the time. |
| Withdraw after selling | `withdraw` checks `nft_token(id).owner_id == predecessor` at that moment. The seller is no longer the owner. |
| Use the purse account directly | It has no access keys at all, and its only method refuses any caller but the collection. |
| Start a withdraw, then sell, and catch a royalty that lands in between | `withdraw` names an exact amount, read from the purse balance; the purse refuses to pay more than it holds when the call arrives. A royalty arriving after that stays for the new holder. The seller could only get it by guessing an amount that includes a royalty landing in the same one or two blocks; that window is documented, and every payout is in the history. |
| Keep an approval to pull the token back | NEP-178: every transfer clears all approvals. |
| A commission paid during the sale ("sale mid-payout") | The royalty is credited to the token's purse in the same call as the commission, not to a person. Whoever holds the token at withdrawal gets it. Tested. |
| Front-run the buyer's transfer with a withdraw | Same block ordering as any NEAR call; the seller still owned it then, and the history records it. No double spend: the purse is zeroed before the transfer out is sent, and restored if that transfer fails. |
| Reentrancy on withdraw | State first (purse to 0, history entry), then the transfer promise; a callback gives it back only on failure. |
| Keep holder-only access (the Tavern) | No sessions or cookies to keep: every Tavern request carries a fresh NEP-413 signature (nonce, minutes-long expiry) and the worker re-reads `nft_token` each time. |
| Keep the token's Base wallet (stretch) | No key exists to keep: the contract asks the MPC to sign only when the current owner calls it. |
| The studio takes a commission and never delivers | The money is escrowed: neither share is released until `fulfil`. After 24 h the buyer can call `refund_expired` and get all of it back. |
| The studio delivers junk to collect | It can't change who gets paid: the royalty goes to the token either way, and the scene is public on the token. Reputation risk only; a dispute flow is out of scope. |
| The fulfil key is stolen | It may only call `fulfil`, which can only attach a scene to a commission that exists and release its escrow as split. It can't withdraw purses or mint. |
| Stake the token's money with a pool the seller controls | Only allow-listed pools; a pool pays back only the delegator, which is the token's account. |
| List it, sell elsewhere, then let the stale listing be bought | `buy` checks the lister still holds it, and anyone can clear a stale listing. |
| Raise the price between a buyer's look and their purchase | `buy` takes the exact listed price; a relist at another price makes the old purchase fail. |
| The collection owner rugs | Owner powers: set the mint price and the studio's share (capped at 50%) and pause new commissions. No power over purses or tokens. Listed in the README. |

## Days

1. Contract + tests + testnet deploy.
2. Worker: commission pickup, generation, `fulfil`.
3. Site: mint, token page, commission, Tavern.
4. Mainnet (operator funds the account), real commissions; stretch if time allows.
5. Video, README, X thread, submit as our second project (rule Q-015 allows two).
