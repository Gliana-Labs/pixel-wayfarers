//! Pixel Wayfarers on NEAR: NFTs that earn (NEAR HACKATHON 2026, track "NFTs That Do Something").
//!
//! A NEP-171 collection (with NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration, NEP-297 events) where each
//! token is also an account:
//!
//!   - Minting Wayfarer #42 creates `42.<this account>`, with no access keys, running the shared purse
//!     (near/purse) as a global contract fixed by its code hash. The purse pays out only when this contract asks.
//!   - Anyone can gift a Wayfarer a hobby item (`commission`: a guitar, a ramen bowl, a corgi). The money waits in
//!     escrow here. When the studio delivers (`fulfil`), the royalty goes straight to the token's own account and the
//!     studio keeps its share; if it never delivers, the buyer takes everything back after 24 h (`refund_expired`).
//!     Each delivered item is added to the token, so its inventory grows.
//!   - The money in a token's account belongs to the token. `withdraw` pays it to whoever holds the token at that
//!     moment, so selling the NFT sells the account, its balance and the right to it together.
//!   - Every token keeps its own history: minted, transferred, earned, paid out, sold, staked.
//!   - v2 (2026-11-09): NEP-199 payouts send `resale_bps` of every marketplace sale to the token's own account, so a
//!     Wayfarer also earns from being sold; and the holder can stake the token's own NEAR with an allow-listed staking
//!     pool, so its money earns staking rewards. The staked position belongs to the token's account and moves with a sale.
//!   - v3 (2026-11-09): hobby items replace the earlier painted scenes, and the holder can have the Wayfarer buy an
//!     item with its own earnings (`buy_item`): it earns, then spends on its hobbies. It can also gift another
//!     Wayfarer a hobby from its own money (`gift_from`), so NFTs pay each other; and with auto-stake on
//!     (`set_auto_stake`) a keeper stakes its idle NEAR for it, so it earns staking rewards by itself.
//!
//! docs/NEAR-PLAN.md has the threat model: every way a seller could try to keep the money, and what stops it.

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::metadata::{NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC};
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::{NonFungibleToken, NonFungibleTokenEnumeration, Token, TokenId};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{Base58CryptoHash, U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseOrValue};
use std::collections::HashMap;

/// A commission nobody delivered in this long can be refunded in full by anyone, to its buyer.
pub const DELIVERY_WINDOW_S: u64 = 24 * 3_600;
/// The studio's share of a commission can't be raised past half: the token earns at least as much as the studio.
pub const MOST_STUDIO_BPS: u16 = 5_000;
const MOST_HISTORY: usize = 30;
/// Paid at mint and kept by the contract: room for a full history (MOST_HISTORY entries of ~130 bytes), so the
/// entries transfers add later never come out of anyone else's money.
const HISTORY_RESERVE_BYTES: u64 = 30 * 130;
const MOST_ITEMS: usize = 24;
const MOST_NOTE: usize = 140;
/// Hobby items the studio knows how to paint in the collection's style. Free text is only a short note.
pub const ITEMS: u8 = 36;
const PAY_GAS: Gas = Gas::from_tgas(10);
/// The most a resale can send to the token's own account: 10%.
pub const MOST_RESALE_BPS: u16 = 1_000;
const POOL_GAS: Gas = Gas::from_tgas(60);
const AFTER_PAY_GAS: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Owners,
    Metadata,
    Enumeration,
    Approvals,
    ContractMetadata,
    Commissions,
    Items,
    History,
    /// Kept outside the state struct (v2 already holds state on testnet), as its own prefix.
    Listings,
    /// Orders a Wayfarer paid for itself (`buy_item`): the studio keeps the whole price. Outside the struct, like Listings.
    SelfBought,
}

/// What one Wayfarer pays, from its own account, to gift another a hobby (`gift_from`): low enough that a Wayfarer
/// that has received one gift (0.16 NEAR) can afford to pass one on.
pub const PEER_GIFT_PRICE: u128 = 100_000_000_000_000_000_000_000; // 0.1 NEAR
/// Auto-stake runs at most this often per Wayfarer, and never for less than AUTO_STAKE_MIN.
pub const AUTO_STAKE_GAP_S: u64 = 6 * 3_600;
pub const AUTO_STAKE_MIN: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// What a Wayfarer pays the studio, out of its own account, for one hobby item (`buy_item`).
pub const ITEM_PRICE: u128 = 50_000_000_000_000_000_000_000; // 0.05 NEAR

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Commission {
    pub id: U64,
    pub token_id: TokenId,
    pub buyer: AccountId,
    pub item: u8,
    pub note: String,
    pub amount: U128,
    pub at: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Entry {
    pub at: U64,
    /// minted, transferred, earned, paid_out
    pub what: String,
    pub account: AccountId,
    pub amount: U128,
}

/// A Wayfarer offered for sale on the collection's own market.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Listing {
    pub seller: AccountId,
    pub price: U128,
    /// Covers the listing's storage; goes back to the seller when it's sold or delisted.
    pub deposit: U128,
    pub at: U64,
}

/// Paid when listing, returned when sold or delisted: room for the listing in storage.
pub const LISTING_DEPOSIT: u128 = 10_000_000_000_000_000_000_000; // 0.01 NEAR

/// NEP-199.
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

#[near(serializers = [json])]
pub struct Config {
    pub owner: AccountId,
    pub studio: AccountId,
    pub purse_code_hash: Base58CryptoHash,
    pub mint_price: U128,
    pub purse_deposit: U128,
    pub commission_price: U128,
    pub studio_bps: u16,
    pub minted: u32,
    pub max_supply: u32,
    pub paused: bool,
    pub items: u8,
    pub delivery_window_s: U64,
    pub resale_bps: u16,
    pub pools: Vec<AccountId>,
    pub item_price: U128,
    pub peer_gift_price: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Wayfarers {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    owner: AccountId,
    /// The only account that may deliver a commission. Its worker holds a key that may only call `fulfil`.
    studio: AccountId,
    purse_code_hash: [u8; 32],
    mint_price: u128,
    /// NEAR each new token account starts with, for its own storage.
    purse_deposit: u128,
    commission_price: u128,
    studio_bps: u16,
    minted: u32,
    max_supply: u32,
    /// From the pre-reveal provenance: the n-th mint gets artwork ((n - 1 + starting_index) % max_supply) + 1.
    starting_index: u32,
    media_base: String,
    reference_base: String,
    paused: bool,
    commissions: IterableMap<u64, Commission>,
    next_commission: u64,
    items: LookupMap<TokenId, Vec<String>>,
    history: LookupMap<TokenId, Vec<Entry>>,
    /// Share of a marketplace sale (NEP-199) that goes to the token's own account.
    resale_bps: u16,
    /// Staking pools a token's money may be delegated to.
    pools: Vec<AccountId>,
}

#[near]
impl Wayfarers {
    /// `purse_code_hash`: the global contract every token account runs (near/purse), published before this.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(owner: AccountId, studio: AccountId, purse_code_hash: Base58CryptoHash, mint_price: U128, purse_deposit: U128, commission_price: U128, studio_bps: u16, max_supply: u32, starting_index: u32, media_base: String, reference_base: String, resale_bps: u16, pools: Vec<AccountId>) -> Self {
        require!(studio_bps <= MOST_STUDIO_BPS, "the studio's share is at most half");
        require!(resale_bps <= MOST_RESALE_BPS, "the token's share of a resale is at most 10%");
        require!(max_supply > 0 && starting_index < max_supply, "starting_index must be below max_supply");
        let metadata = NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Pixel Wayfarers".to_string(),
            symbol: "WAYFR".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        };
        Self {
            tokens: NonFungibleToken::new(Key::Owners, owner.clone(), Some(Key::Metadata), Some(Key::Enumeration), Some(Key::Approvals)),
            metadata: LazyOption::new(Key::ContractMetadata, Some(&metadata)),
            owner,
            studio,
            purse_code_hash: purse_code_hash.into(),
            mint_price: mint_price.0,
            purse_deposit: purse_deposit.0,
            commission_price: commission_price.0,
            studio_bps,
            minted: 0,
            max_supply,
            starting_index,
            media_base,
            reference_base,
            paused: false,
            commissions: IterableMap::new(Key::Commissions),
            next_commission: 1,
            items: LookupMap::new(Key::Items),
            history: LookupMap::new(Key::History),
            resale_bps,
            pools,
        }
    }

    // ── minting ──────────────────────────────────────────────────────────────

    /// Mint the next Wayfarer to the caller. Attach `mint_price` + `purse_deposit` + the token's storage (0.02 NEAR
    /// covers it; any extra comes back). The token's own account is created in the same call.
    #[payable]
    pub fn mint(&mut self) -> Token {
        require!(!self.paused, "minting is paused");
        require!(self.minted < self.max_supply, "all Wayfarers are minted");
        let buyer = env::predecessor_account_id();
        let before = env::storage_usage();
        let art = (self.minted + self.starting_index) % self.max_supply + 1;
        let token_id = art.to_string();
        let account = self.purse_of(token_id.clone());
        let metadata = TokenMetadata {
            title: Some(format!("Pixel Wayfarers #{art}")),
            description: Some("A pixel wayfarer that is also a NEAR account: it earns from every hobby item gifted to it, and pays whoever holds it.".to_string()),
            media: Some(format!("{}/{art}.png", self.media_base)),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(json!({ "account": account, "items": 0 }).to_string()),
            reference: Some(format!("{}/{art}.json", self.reference_base)),
            reference_hash: None,
        };
        let token = self.tokens.internal_mint_with_refund(token_id.clone(), buyer.clone(), Some(metadata), None);
        self.minted += 1;
        self.record(&token_id, "minted", &buyer, 0);
        NftMint { owner_id: &buyer, token_ids: &[&token_id], memo: None }.emit();
        let bytes = env::storage_usage().saturating_sub(before) + HISTORY_RESERVE_BYTES;
        let storage = u128::from(bytes) * env::storage_byte_cost().as_yoctonear();
        let needed = storage + self.mint_price + self.purse_deposit;
        let attached = env::attached_deposit().as_yoctonear();
        require!(attached >= needed, format!("attach at least {needed} yoctoNEAR"));
        // The token's account: created, funded for its own storage, running the purse by code hash. No keys at all.
        let purse = env::promise_batch_create(&account);
        env::promise_batch_action_create_account(purse);
        env::promise_batch_action_transfer(purse, NearToken::from_yoctonear(self.purse_deposit));
        env::promise_batch_action_use_global_contract(purse, &self.purse_code_hash);
        if self.mint_price > 0 {
            let p = env::promise_batch_create(&self.owner);
            env::promise_batch_action_transfer(p, NearToken::from_yoctonear(self.mint_price));
        }
        if attached > needed {
            let p = env::promise_batch_create(&buyer);
            env::promise_batch_action_transfer(p, NearToken::from_yoctonear(attached - needed));
        }
        token
    }

    // ── commissions ──────────────────────────────────────────────────────────

    /// Gift `token_id` a hobby item: `item` is one of the studio's items (0..ITEMS), `note` up to 140
    /// characters. Attach exactly `commission_price`. It waits in escrow until delivered or refunded.
    #[payable]
    pub fn commission(&mut self, token_id: TokenId, item: u8, note: Option<String>) -> U64 {
        require!(!self.paused, "commissions are paused");
        require!(self.tokens.owner_by_id.get(&token_id).is_some(), "no such Wayfarer");
        require!(item < ITEMS, "no such item");
        let note = note.unwrap_or_default();
        require!(note.chars().count() <= MOST_NOTE, "the note is at most 140 characters");
        require!(env::attached_deposit().as_yoctonear() == self.commission_price, format!("attach exactly {} yoctoNEAR", self.commission_price));
        let id = self.next_commission;
        self.next_commission += 1;
        let c = Commission { id: U64(id), token_id, buyer: env::predecessor_account_id(), item, note, amount: U128(self.commission_price), at: U64(now_s()) };
        log_event("commission", json!(c));
        self.commissions.insert(id, c);
        U64(id)
    }

    /// The studio delivers: the item is added to the token, the royalty goes to the token's own account, the
    /// studio takes its share. Only the studio account may call this.
    pub fn fulfil(&mut self, id: U64, item_uri: String) {
        require!(env::predecessor_account_id() == self.studio, "only the studio delivers");
        require!(item_uri.len() <= 200 && item_uri.starts_with("https://"), "item_uri: an https URL, at most 200 characters");
        let before = env::storage_usage();
        let c = self.commissions.remove(&id.0).unwrap_or_else(|| env::panic_str("no such commission"));
        // A Wayfarer buying its own item pays the studio the whole price: a purchase, not a royalty to itself.
        let bought = self_bought().remove(&id.0).is_some();
        let royalty = if bought { 0 } else { c.amount.0 * u128::from(10_000 - self.studio_bps) / 10_000 };
        let mut studio_cut = c.amount.0 - royalty;
        // Straight to the token's own account, whoever holds the token right now: the money is the token's.
        transfer(&self.purse_of(c.token_id.clone()), royalty);
        let mut items = self.items.get(&c.token_id).cloned().unwrap_or_default();
        items.push(item_uri.clone());
        if items.len() > MOST_ITEMS {
            items.remove(0);
        }
        let count = items.len();
        self.items.insert(c.token_id.clone(), items);
        self.update_extra(&c.token_id, count);
        if !bought {
            self.record(&c.token_id, "earned", &c.buyer, royalty);
        }
        // The new item's storage comes out of the studio's share, never the token's royalty.
        let grew = u128::from(env::storage_usage().saturating_sub(before)) * env::storage_byte_cost().as_yoctonear();
        require!(studio_cut >= grew, "the studio's share doesn't cover the item's storage");
        studio_cut -= grew;
        if studio_cut > 0 {
            let p = env::promise_batch_create(&self.studio);
            env::promise_batch_action_transfer(p, NearToken::from_yoctonear(studio_cut));
        }
        log_event("fulfilled", json!({ "id": id, "token_id": c.token_id, "item_uri": item_uri, "royalty": U128(royalty) }));
    }

    /// v3 migration, run once by the collection's own key: drops the pictures delivered before v3 (painted scenes,
    /// under /scenes/) so a token's inventory holds only items, and refreshes each token's item count.
    #[private]
    pub fn drop_scenes(&mut self, token_ids: Vec<TokenId>) {
        for t in token_ids {
            let kept: Vec<String> = self.items.get(&t).cloned().unwrap_or_default().into_iter().filter(|u| !u.contains("/scenes/")).collect();
            let n = kept.len();
            if n == 0 {
                self.items.remove(&t);
            } else {
                self.items.insert(t.clone(), kept);
            }
            self.update_extra(&t, n);
        }
    }

    /// Anyone may return an undelivered commission to its buyer once its window has passed.
    pub fn refund_expired(&mut self, id: U64) {
        let c = self.commissions.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such commission"));
        require!(now_s() >= c.at.0 + DELIVERY_WINDOW_S, "still inside its delivery window");
        self.commissions.remove(&id.0);
        // A Wayfarer's own order goes back to the Wayfarer: its buyer is the token's account.
        self_bought().remove(&id.0);
        let p = env::promise_batch_create(&c.buyer);
        env::promise_batch_action_transfer(p, NearToken::from_yoctonear(c.amount.0));
        log_event("refunded", json!({ "id": id, "token_id": c.token_id, "buyer": c.buyer }));
    }

    /// The holder has the Wayfarer buy itself a hobby item with its own money. Its account pays `ITEM_PRICE` into
    /// escrow here, and the order opens only once that payment arrived (`on_item_paid`); the purse refuses to dip
    /// below its own storage, and then nothing happens. The studio paints it like any commission and keeps the whole
    /// price. Not delivered in 24 h: `refund_expired` sends the money back to the token's account. Attach 1 yoctoNEAR.
    #[payable]
    pub fn buy_item(&mut self, token_id: TokenId, item: u8) {
        self.only_holder(&token_id);
        require!(!self.paused, "commissions are paused");
        require!(item < ITEMS, "no such item");
        let mut input = ITEM_PRICE.to_le_bytes().to_vec();
        input.extend_from_slice(env::current_account_id().as_bytes());
        let pay = env::promise_batch_create(&self.purse_of(token_id.clone()));
        env::promise_batch_action_function_call(pay, "pay", &input, NearToken::from_yoctonear(0), PAY_GAS);
        let after = env::promise_then(pay, env::current_account_id(), "on_item_paid", json!({ "token_id": token_id, "item": item }).to_string().as_bytes(), NearToken::from_yoctonear(0), AFTER_PAY_GAS);
        env::promise_return(after);
    }

    /// The holder of `token_id` has it gift `to_token_id` a hobby from its own money (PEER_GIFT_PRICE): money moving
    /// from one NFT to another. Its account pays into escrow here; the order opens only once that payment arrived. It
    /// is then an ordinary gift: on delivery the royalty goes to `to_token_id`'s account and the studio keeps its
    /// share; not delivered in 24 h, the money goes back to the giver's account. Attach 1 yoctoNEAR.
    #[payable]
    pub fn gift_from(&mut self, token_id: TokenId, to_token_id: TokenId, item: u8) {
        self.only_holder(&token_id);
        require!(!self.paused, "commissions are paused");
        require!(item < ITEMS, "no such item");
        require!(token_id != to_token_id, "a Wayfarer can't gift itself; buy_item is for that");
        require!(self.tokens.owner_by_id.get(&to_token_id).is_some(), "no such Wayfarer to gift");
        let mut input = PEER_GIFT_PRICE.to_le_bytes().to_vec();
        input.extend_from_slice(env::current_account_id().as_bytes());
        let pay = env::promise_batch_create(&self.purse_of(token_id.clone()));
        env::promise_batch_action_function_call(pay, "pay", &input, NearToken::from_yoctonear(0), PAY_GAS);
        let after = env::promise_then(pay, env::current_account_id(), "on_gift_paid", json!({ "from": token_id, "to": to_token_id, "item": item }).to_string().as_bytes(), NearToken::from_yoctonear(0), AFTER_PAY_GAS);
        env::promise_return(after);
    }

    /// Opens the Wayfarer-to-Wayfarer gift only if the giver's account actually paid.
    #[private]
    pub fn on_gift_paid(&mut self, from: TokenId, to: TokenId, item: u8) -> Option<U64> {
        env::promise_result_checked(0, 64).ok()?;
        let id = self.next_commission;
        self.next_commission += 1;
        let c = Commission { id: U64(id), token_id: to.clone(), buyer: self.purse_of(from.clone()), item, note: String::new(), amount: U128(PEER_GIFT_PRICE), at: U64(now_s()) };
        log_event("commission", json!(c));
        self.commissions.insert(id, c);
        let to_account = self.purse_of(to);
        self.record(&from, "gave", &to_account, PEER_GIFT_PRICE);
        Some(U64(id))
    }

    /// Opens the Wayfarer's own order only if its account actually paid.
    #[private]
    pub fn on_item_paid(&mut self, token_id: TokenId, item: u8) -> Option<U64> {
        env::promise_result_checked(0, 64).ok()?;
        let id = self.next_commission;
        self.next_commission += 1;
        let c = Commission { id: U64(id), token_id: token_id.clone(), buyer: self.purse_of(token_id.clone()), item, note: String::new(), amount: U128(ITEM_PRICE), at: U64(now_s()) };
        log_event("commission", json!(c));
        self.commissions.insert(id, c);
        self_bought().insert(&id, &());
        let studio = self.studio.clone();
        self.record(&token_id, "bought", &studio, ITEM_PRICE);
        Some(U64(id))
    }

    // ── the token's money ────────────────────────────────────────────────────

    /// Pay `amount` out of the token's own account to whoever holds the token now. Attach 1 yoctoNEAR: a web
    /// wallet's sign-in key can't, so only the holder's wallet can confirm a payout.
    #[payable]
    pub fn withdraw(&mut self, token_id: TokenId, amount: U128) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        let holder = env::predecessor_account_id();
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(owner == holder, "only the Wayfarer's current holder");
        require!(amount.0 > 0, "amount must be more than zero");
        // The purse's whole input: 16-byte little-endian amount, then the receiver (near/purse).
        let mut input = amount.0.to_le_bytes().to_vec();
        input.extend_from_slice(holder.as_bytes());
        let pay = env::promise_batch_create(&self.purse_of(token_id.clone()));
        env::promise_batch_action_function_call(pay, "pay", &input, NearToken::from_yoctonear(0), PAY_GAS);
        let after = env::promise_then(pay, env::current_account_id(), "on_paid_out", json!({ "token_id": token_id, "to": holder, "amount": amount }).to_string().as_bytes(), NearToken::from_yoctonear(0), AFTER_PAY_GAS);
        env::promise_return(after);
    }

    /// Writes a staking request into the token's history only if the token's account accepted it.
    #[private]
    pub fn on_purse_called(&mut self, token_id: TokenId, what: String, account: AccountId, amount: U128) -> bool {
        let ok = env::promise_result_checked(0, 64).is_ok();
        if ok {
            self.record(&token_id, &what, &account, amount.0);
        }
        ok
    }

    /// Writes the payout into the token's history only if the purse actually paid.
    #[private]
    pub fn on_paid_out(&mut self, token_id: TokenId, to: AccountId, amount: U128) -> bool {
        let paid = env::promise_result_checked(0, 64).is_ok();
        if paid {
            self.record(&token_id, "paid_out", &to, amount.0);
        }
        paid
    }

    // ── resale royalties (NEP-199) ───────────────────────────────────────────

    /// How a marketplace should split `balance` from a sale: `resale_bps` to the token's own account, the rest to the
    /// seller. The token earns from being sold, and the money stays with the token for its next holder.
    pub fn nft_payout(&self, token_id: TokenId, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(max_len_payout.map_or(true, |m| m >= 2), "max_len_payout must allow 2 entries");
        let to_token = balance.0 * u128::from(self.resale_bps) / 10_000;
        let mut payout = HashMap::new();
        payout.insert(owner, U128(balance.0 - to_token));
        if to_token > 0 {
            payout.insert(self.purse_of(token_id), U128(to_token));
        }
        Payout { payout }
    }

    /// NEP-199: transfer for a marketplace sale and answer how to split the price.
    #[payable]
    pub fn nft_transfer_payout(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, balance: U128, max_len_payout: Option<u32>) -> Payout {
        near_sdk::assert_one_yocto();
        let payout = self.nft_payout(token_id.clone(), balance, max_len_payout);
        self.tokens.nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
        self.record(&token_id, "sold", &receiver_id, balance.0);
        payout
    }

    // ── the collection's own market ──────────────────────────────────────────
    // A sale here moves the token, its account and its money in one transaction: the seller gets the price minus
    // `resale_bps`, which goes into the token's own account. Any NEP-199 marketplace gets the same split.

    /// Offer the Wayfarer for `price`. Holder only; attach 0.01 NEAR for the listing's storage (it comes back).
    #[payable]
    pub fn list(&mut self, token_id: TokenId, price: U128) {
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(owner == env::predecessor_account_id(), "only the Wayfarer's current holder");
        require!(env::attached_deposit().as_yoctonear() >= LISTING_DEPOSIT, "attach 0.01 NEAR for the listing's storage");
        require!(price.0 > 0, "price must be more than zero");
        let mut listings = listings();
        if let Some(old) = listings.get(&token_id) {
            // Relisting: the earlier deposit goes back to whoever paid it.
            transfer(&old.seller, old.deposit.0);
        }
        listings.insert(&token_id, &Listing { seller: owner, price, deposit: U128(env::attached_deposit().as_yoctonear()), at: U64(now_s()) });
        log_event("listed", json!({ "token_id": token_id, "price": price }));
    }

    /// Take the offer down. The holder may; so may anyone once the lister no longer holds it.
    pub fn delist(&mut self, token_id: TokenId) {
        let mut listings = listings();
        let l = listings.get(&token_id).unwrap_or_else(|| env::panic_str("not listed"));
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(env::predecessor_account_id() == l.seller || owner != l.seller, "only the seller, while they hold it");
        listings.remove(&token_id);
        transfer(&l.seller, l.deposit.0);
    }

    /// Buy a listed Wayfarer: attach exactly its price. The token, its own account and everything in it are yours.
    #[payable]
    pub fn buy(&mut self, token_id: TokenId) {
        let mut listings = listings();
        let l = listings.get(&token_id).unwrap_or_else(|| env::panic_str("not for sale"));
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(owner == l.seller, "that listing is stale: the seller no longer holds it");
        require!(env::attached_deposit().as_yoctonear() == l.price.0, format!("attach exactly {} yoctoNEAR", l.price.0));
        let buyer = env::predecessor_account_id();
        require!(buyer != l.seller, "that's your own listing");
        listings.remove(&token_id);
        self.tokens.internal_transfer(&l.seller, &buyer, &token_id, None, Some("bought on the Wayfarers market".to_string()));
        let to_token = l.price.0 * u128::from(self.resale_bps) / 10_000;
        if to_token > 0 {
            transfer(&self.purse_of(token_id.clone()), to_token);
        }
        transfer(&l.seller, l.price.0 - to_token + l.deposit.0);
        self.record(&token_id, "sold", &buyer, l.price.0);
    }

    pub fn listing(&self, token_id: TokenId) -> Option<Listing> {
        listings().get(&token_id)
    }

    // ── staking the token's own money ────────────────────────────────────────

    /// Delegate `amount` of the token's own NEAR to an allow-listed pool. The stake belongs to the token's account,
    /// so it moves with a sale. Holder only, 1 yoctoNEAR.
    #[payable]
    pub fn stake(&mut self, token_id: TokenId, pool: AccountId, amount: U128) {
        self.only_holder(&token_id);
        require!(self.pools.contains(&pool), "not one of the collection's staking pools");
        require!(amount.0 > 0, "amount must be more than zero");
        self.purse_call(&token_id, &pool, "deposit_and_stake", b"{}", amount.0, "stake_requested", amount.0);
    }

    /// Auto-stake on (`Some(pool)`, one of the collection's pools) or off (`None`) for this Wayfarer. Holder only, 1
    /// yoctoNEAR. The setting stays with the token when it's sold; the new holder can switch it off.
    #[payable]
    pub fn set_auto_stake(&mut self, token_id: TokenId, pool: Option<AccountId>) {
        self.only_holder(&token_id);
        let mut on = auto_stakes();
        match pool {
            Some(pool) => {
                require!(self.pools.contains(&pool), "not one of the collection's staking pools");
                on.insert(token_id.clone(), (pool, 0));
            }
            None => {
                on.remove(&token_id);
            }
        }
        save_auto_stake(&on);
        log_event("auto_stake", json!({ "token_id": token_id, "pool": on.get(&token_id).map(|(p, _)| p) }));
    }

    /// The keeper's call (anyone may make it; the site's cron does): stakes `amount` of an auto-staking Wayfarer's
    /// own NEAR with the pool its holder chose, at most once every AUTO_STAKE_GAP_S. Nothing leaves the token: the
    /// money becomes a stake in the token's own name, and the purse refuses to dip below its storage. The worst a
    /// caller can do is stake more of it than the keeper would (it leaves 0.05 NEAR liquid); the holder can unstake.
    pub fn auto_stake(&mut self, token_id: TokenId, amount: U128) {
        let mut on = auto_stakes();
        let (pool, last) = on.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("auto-stake is off for this Wayfarer"));
        require!(now_s() >= last + AUTO_STAKE_GAP_S, "this Wayfarer staked less than 6 hours ago");
        require!(amount.0 >= AUTO_STAKE_MIN, "auto-stake moves at least 0.01 NEAR");
        on.insert(token_id.clone(), (pool.clone(), now_s()));
        save_auto_stake(&on);
        self.purse_call(&token_id, &pool, "deposit_and_stake", b"{}", amount.0, "auto_staked", amount.0);
    }

    /// The pool a Wayfarer auto-stakes with, if it does.
    pub fn auto_stake_of(&self, token_id: TokenId) -> Option<AccountId> {
        auto_stakes().get(&token_id).map(|(p, _)| p.clone())
    }

    /// Every auto-staking Wayfarer with its pool and when it last staked (seconds), for the keeper.
    pub fn auto_stakers(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<(TokenId, AccountId, U64)> {
        auto_stakes().into_iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(100) as usize).map(|(t, (p, at))| (t, p, U64(at))).collect()
    }

    /// Start unstaking `amount` (NEAR's pools release it about 4 epochs later). Holder only, 1 yoctoNEAR.
    #[payable]
    pub fn unstake(&mut self, token_id: TokenId, pool: AccountId, amount: U128) {
        self.only_holder(&token_id);
        require!(self.pools.contains(&pool), "not one of the collection's staking pools");
        self.purse_call(&token_id, &pool, "unstake", json!({ "amount": amount }).to_string().as_bytes(), 0, "unstake_requested", amount.0);
    }

    /// Bring unstaked NEAR back into the token's account. Holder only, 1 yoctoNEAR.
    #[payable]
    pub fn withdraw_stake(&mut self, token_id: TokenId, pool: AccountId) {
        self.only_holder(&token_id);
        require!(self.pools.contains(&pool), "not one of the collection's staking pools");
        self.purse_call(&token_id, &pool, "withdraw_all", b"{}", 0, "withdraw_requested", 0);
    }

    // ── owner ────────────────────────────────────────────────────────────────
    // No power over a token, its account or its money: only prices, the studio's share (at most half) and pausing.

    #[payable]
    pub fn set_prices(&mut self, mint_price: U128, commission_price: U128, studio_bps: u16) {
        self.only_owner();
        require!(studio_bps <= MOST_STUDIO_BPS, "the studio's share is at most half");
        self.mint_price = mint_price.0;
        self.commission_price = commission_price.0;
        self.studio_bps = studio_bps;
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.only_owner();
        self.paused = paused;
    }

    /// Which pools a token may stake with. The owner can only add pools, never remove one, so a token can always
    /// unstake and withdraw from any pool it staked with.
    #[payable]
    pub fn add_pool(&mut self, pool: AccountId) {
        self.only_owner();
        if !self.pools.contains(&pool) {
            self.pools.push(pool);
        }
    }

    // ── views ────────────────────────────────────────────────────────────────

    /// The token's own NEAR account: `<token_id>.<this account>`.
    pub fn purse_of(&self, token_id: TokenId) -> AccountId {
        format!("{token_id}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("token id makes no account id"))
    }

    pub fn history(&self, token_id: TokenId) -> Vec<Entry> {
        self.history.get(&token_id).cloned().unwrap_or_default().into_iter().rev().collect()
    }

    pub fn items(&self, token_id: TokenId) -> Vec<String> {
        self.items.get(&token_id).cloned().unwrap_or_default()
    }

    /// Commissions waiting for the studio, oldest first.
    pub fn pending(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Commission> {
        let mut all: Vec<Commission> = self.commissions.values().cloned().collect();
        all.sort_by_key(|c| c.id.0);
        all.into_iter().skip(from_index.unwrap_or(0) as usize).take(limit.unwrap_or(50) as usize).collect()
    }

    pub fn config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            studio: self.studio.clone(),
            purse_code_hash: self.purse_code_hash.into(),
            mint_price: U128(self.mint_price),
            purse_deposit: U128(self.purse_deposit),
            commission_price: U128(self.commission_price),
            studio_bps: self.studio_bps,
            minted: self.minted,
            max_supply: self.max_supply,
            paused: self.paused,
            items: ITEMS,
            delivery_window_s: U64(DELIVERY_WINDOW_S),
            resale_bps: self.resale_bps,
            pools: self.pools.clone(),
            item_price: U128(ITEM_PRICE),
            peer_gift_price: U128(PEER_GIFT_PRICE),
        }
    }
}

// ── NEP-171 core, with the token's history kept on every transfer ─────────────

#[near]
impl NonFungibleTokenCore for Wayfarers {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.tokens.nft_transfer(receiver_id.clone(), token_id.clone(), approval_id, memo);
        self.record(&token_id, "transferred", &receiver_id, 0);
    }

    #[payable]
    fn nft_transfer_call(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>, msg: String) -> PromiseOrValue<bool> {
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Wayfarers {
    #[private]
    fn nft_resolve_transfer(&mut self, previous_owner_id: AccountId, receiver_id: AccountId, token_id: TokenId, approved_account_ids: Option<HashMap<AccountId, u64>>) -> bool {
        let kept = self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id.clone(), token_id.clone(), approved_account_ids);
        // true: the receiver kept it. Only then did ownership move.
        if kept {
            self.record(&token_id, "transferred", &receiver_id, 0);
        }
        kept
    }
}

#[near]
impl NonFungibleTokenApproval for Wayfarers {
    #[payable]
    fn nft_approve(&mut self, token_id: TokenId, account_id: AccountId, msg: Option<String>) -> Option<near_sdk::Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }
    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }
    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }
    fn nft_is_approved(&self, token_id: TokenId, approved_account_id: AccountId, approval_id: Option<u64>) -> bool {
        self.tokens.nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Wayfarers {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }
    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }
    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }
    fn nft_tokens_for_owner(&self, account_id: AccountId, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Wayfarers {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap_or_else(|| env::panic_str("no metadata"))
    }
}

impl Wayfarers {
    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
    }

    /// Only whoever holds the token now, confirmed by their wallet (1 yoctoNEAR).
    fn only_holder(&self, token_id: &TokenId) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach 1 yoctoNEAR");
        let owner = self.tokens.owner_by_id.get(token_id).unwrap_or_else(|| env::panic_str("no such Wayfarer"));
        require!(owner == env::predecessor_account_id(), "only the Wayfarer's current holder");
    }

    /// Asks the token's account to call `method` on `receiver` (near/purse `call`), and writes `what` into the token's
    /// history only if the purse accepted (it refuses to spend below its own storage). The pool's answer arrives later;
    /// the site reads the real staked balance from the pool, so history says "requested", not "staked".
    fn purse_call(&self, token_id: &TokenId, receiver: &AccountId, method: &str, args: &[u8], deposit: u128, what: &str, amount: u128) {
        let mut input = deposit.to_le_bytes().to_vec();
        input.extend_from_slice(&POOL_GAS.as_gas().to_le_bytes());
        input.push(receiver.as_str().len() as u8);
        input.extend_from_slice(receiver.as_bytes());
        input.push(method.len() as u8);
        input.extend_from_slice(method.as_bytes());
        input.extend_from_slice(args);
        let p = env::promise_batch_create(&self.purse_of(token_id.clone()));
        env::promise_batch_action_function_call(p, "call", &input, NearToken::from_yoctonear(0), POOL_GAS.saturating_add(PAY_GAS));
        let after = env::promise_then(p, env::current_account_id(), "on_purse_called", json!({ "token_id": token_id, "what": what, "account": receiver, "amount": U128(amount) }).to_string().as_bytes(), NearToken::from_yoctonear(0), AFTER_PAY_GAS);
        env::promise_return(after);
    }

    fn record(&mut self, token_id: &TokenId, what: &str, account: &AccountId, amount: u128) {
        let mut h = self.history.get(token_id).cloned().unwrap_or_default();
        if h.len() >= MOST_HISTORY {
            h.remove(0);
        }
        h.push(Entry { at: U64(now_s()), what: what.to_string(), account: account.clone(), amount: U128(amount) });
        self.history.insert(token_id.clone(), h);
    }

    /// The token's metadata says how many items it has: a dynamic NFT, announced with nft_metadata_update.
    fn update_extra(&mut self, token_id: &TokenId, items: usize) {
        let account = self.purse_of(token_id.clone());
        if let Some(by_id) = self.tokens.token_metadata_by_id.as_mut() {
            if let Some(mut m) = by_id.get(token_id) {
                m.extra = Some(json!({ "account": account, "items": items }).to_string());
                m.updated_at = Some(env::block_timestamp_ms().to_string());
                by_id.insert(token_id, &m);
            }
        }
        env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.2.0", "event": "nft_metadata_update", "data": [{ "token_ids": [token_id] }] })));
    }
}

fn listings() -> near_sdk::collections::LookupMap<TokenId, Listing> {
    near_sdk::collections::LookupMap::new(Key::Listings)
}

/// Wayfarers whose holder switched auto-stake on: token -> (pool, last run), stored as one value under its own key.
/// Not an UnorderedMap: one built outside the state struct forgets its length between calls, so it can't be listed.
/// At most max_supply entries.
const AUTO_STAKE_KEY: &[u8] = b"auto-stake";
fn auto_stakes() -> std::collections::BTreeMap<TokenId, (AccountId, u64)> {
    env::storage_read(AUTO_STAKE_KEY).map(|b| near_sdk::borsh::from_slice(&b).unwrap_or_else(|_| env::panic_str("bad auto-stake state"))).unwrap_or_default()
}
fn save_auto_stake(m: &std::collections::BTreeMap<TokenId, (AccountId, u64)>) {
    env::storage_write(AUTO_STAKE_KEY, &near_sdk::borsh::to_vec(m).unwrap_or_else(|_| env::panic_str("can't save auto-stake")));
}

fn self_bought() -> near_sdk::collections::LookupMap<u64, ()> {
    near_sdk::collections::LookupMap::new(Key::SelfBought)
}

fn transfer(to: &AccountId, amount: u128) {
    if amount > 0 {
        let p = env::promise_batch_create(to);
        env::promise_batch_action_transfer(p, NearToken::from_yoctonear(amount));
    }
}

fn now_s() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn log_event(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "wayfarers", "version": "1.0.0", "event": event, "data": data })));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const PRICE: u128 = 200_000_000_000_000_000_000_000; // 0.2 NEAR commission

    fn ctx(who: AccountId, deposit: u128, now_s: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id("wayfarers.near".parse().unwrap())
            .predecessor_account_id(who)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(now_s * 1_000_000_000)
            .account_balance(NearToken::from_near(100))
            .build());
    }

    /// owner accounts(0), studio accounts(1); starting_index 41, so the first mint is artwork #42.
    fn collection() -> Wayfarers {
        ctx(accounts(0), 0, 1_700_000_000);
        Wayfarers::new(accounts(0), accounts(1), [7u8; 32].into(), U128(NEAR), U128(NEAR / 100), U128(PRICE), 2_000, 1_000, 41, "ipfs://art".into(), "ipfs://meta".into(), 500, vec!["kiln.pool.near".parse().unwrap()])
    }

    fn mint_to(c: &mut Wayfarers, who: AccountId) -> TokenId {
        ctx(who, 2 * NEAR, 1_700_000_000);
        c.mint().token_id
    }

    #[test]
    fn mint_gives_the_token_its_own_account_and_a_history() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        assert_eq!(id, "42");
        assert_eq!(c.purse_of(id.clone()).as_str(), "42.wayfarers.near");
        let t = c.nft_token(id.clone()).unwrap();
        assert_eq!(t.owner_id, accounts(2));
        assert!(t.metadata.unwrap().extra.unwrap().contains("42.wayfarers.near"));
        assert_eq!(c.history(id)[0].what, "minted");
    }

    #[test]
    #[should_panic(expected = "attach at least")]
    fn mint_without_enough_deposit_is_refused() {
        let mut c = collection();
        ctx(accounts(2), NEAR / 2, 1_700_000_000);
        c.mint();
    }

    #[test]
    fn a_delivered_commission_pays_the_token_and_grows_its_gallery() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), PRICE, 1_700_000_100);
        let job = c.commission(id.clone(), 3, Some("at a Bali night market".into()));
        assert_eq!(c.pending(None, None).len(), 1);
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "https://pixelwayfarers.com/items/1.png".into());
        assert!(c.pending(None, None).is_empty());
        let h = c.history(id.clone());
        assert_eq!((h[0].what.as_str(), h[0].amount.0), ("earned", PRICE * 8 / 10));
        assert_eq!(c.items(id.clone()).len(), 1);
        assert!(c.nft_token(id).unwrap().metadata.unwrap().extra.unwrap().contains("\"items\":1"));
    }

    #[test]
    #[should_panic(expected = "only the studio delivers")]
    fn nobody_but_the_studio_can_deliver() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), PRICE, 1_700_000_100);
        let job = c.commission(id, 0, None);
        ctx(accounts(0), 0, 1_700_000_200); // not even the collection's owner
        c.fulfil(job, "https://x.example/1.png".into());
    }

    #[test]
    fn an_undelivered_commission_goes_back_after_a_day_and_not_before() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), PRICE, 1_700_000_000);
        let job = c.commission(id, 0, None);
        ctx(accounts(4), 0, 1_700_000_000 + DELIVERY_WINDOW_S - 1);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.refund_expired(job))).is_err());
        ctx(accounts(4), 0, 1_700_000_000 + DELIVERY_WINDOW_S);
        c.refund_expired(job);
        assert!(c.pending(None, None).is_empty());
    }

    #[test]
    #[should_panic(expected = "only the Wayfarer's current holder")]
    fn nobody_else_can_withdraw_a_tokens_money() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), 1, 1_700_000_100);
        c.withdraw(id, U128(1));
    }

    #[test]
    #[should_panic(expected = "attach 1 yoctoNEAR")]
    fn a_withdraw_needs_the_holders_wallet_to_confirm() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 0, 1_700_000_100);
        c.withdraw(id, U128(1));
    }

    #[test]
    fn selling_the_nft_sells_the_money_the_seller_cant_withdraw_after() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 1, 1_700_000_100);
        c.withdraw(id.clone(), U128(1)); // the seller can while they hold it
        c.nft_transfer(accounts(3), id.clone(), None, None);
        ctx(accounts(2), 1, 1_700_000_200);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(id.clone(), U128(1)))).is_err());
        ctx(accounts(3), 1, 1_700_000_200);
        c.withdraw(id.clone(), U128(1));
        let h = c.history(id);
        assert_eq!((h[0].what.as_str(), &h[0].account), ("transferred", &accounts(3)));
    }

    #[test]
    fn a_sale_in_the_middle_of_a_payout_leaves_the_royalty_with_the_token() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        // Commissioned while the seller holds it...
        ctx(accounts(4), PRICE, 1_700_000_100);
        let job = c.commission(id.clone(), 5, None);
        // ...sold before it's delivered...
        ctx(accounts(2), 1, 1_700_000_150);
        c.nft_transfer(accounts(3), id.clone(), None, None);
        // ...delivered after: the royalty goes to the token's account, and only the new holder can take it out.
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "https://pixelwayfarers.com/items/2.png".into());
        assert_eq!(c.history(id.clone())[0].what, "earned");
        ctx(accounts(2), 1, 1_700_000_300);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(id.clone(), U128(PRICE / 2)))).is_err());
        ctx(accounts(3), 1, 1_700_000_300);
        c.withdraw(id, U128(PRICE / 2));
    }

    #[test]
    fn approvals_end_with_a_sale_so_the_seller_cant_pull_it_back() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), NEAR / 100, 1_700_000_100);
        c.nft_approve(id.clone(), accounts(5), None);
        assert!(c.nft_is_approved(id.clone(), accounts(5), None));
        ctx(accounts(2), 1, 1_700_000_150);
        c.nft_transfer(accounts(3), id.clone(), None, None);
        assert!(!c.nft_is_approved(id, accounts(5), None));
    }

    #[test]
    fn a_marketplace_sale_pays_the_token_its_share_and_moves_it() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        let p = c.nft_payout(id.clone(), U128(10 * NEAR), Some(10)).payout;
        assert_eq!(p.get(&accounts(2)).unwrap().0, 10 * NEAR * 95 / 100);
        assert_eq!(p.get(&c.purse_of(id.clone())).unwrap().0, 10 * NEAR * 5 / 100);
        // The marketplace, holding an approval, sells it to accounts(3).
        ctx(accounts(2), NEAR / 100, 1_700_000_100);
        c.nft_approve(id.clone(), accounts(5), None);
        ctx(accounts(5), 1, 1_700_000_200);
        let out = c.nft_transfer_payout(accounts(3), id.clone(), Some(1), None, U128(10 * NEAR), Some(10));
        assert_eq!(out.payout.len(), 2);
        assert_eq!(c.nft_token(id.clone()).unwrap().owner_id, accounts(3));
        assert_eq!((c.history(id.clone())[0].what.as_str(), c.history(id)[0].amount.0), ("sold", 10 * NEAR));
    }

    #[test]
    fn the_built_in_market_sells_the_token_and_its_account_together() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), LISTING_DEPOSIT, 1_700_000_100);
        c.list(id.clone(), U128(3 * NEAR));
        assert_eq!(c.listing(id.clone()).unwrap().price.0, 3 * NEAR);
        ctx(accounts(3), 3 * NEAR, 1_700_000_200);
        c.buy(id.clone());
        assert_eq!(c.nft_token(id.clone()).unwrap().owner_id, accounts(3));
        assert!(c.listing(id.clone()).is_none());
        let h = c.history(id.clone());
        assert_eq!((h[0].what.as_str(), &h[0].account, h[0].amount.0), ("sold", &accounts(3), 3 * NEAR));
        // The old seller lost every right with the sale.
        ctx(accounts(2), 1, 1_700_000_300);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.withdraw(id.clone(), U128(1)))).is_err());
    }

    #[test]
    #[should_panic(expected = "that listing is stale")]
    fn a_listing_dies_when_the_seller_moves_the_token() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), LISTING_DEPOSIT, 1_700_000_100);
        c.list(id.clone(), U128(NEAR));
        ctx(accounts(2), 1, 1_700_000_150);
        c.nft_transfer(accounts(4), id.clone(), None, None);
        ctx(accounts(3), NEAR, 1_700_000_200);
        c.buy(id);
    }

    #[test]
    #[should_panic(expected = "attach exactly")]
    fn a_buyer_pays_the_exact_price() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), LISTING_DEPOSIT, 1_700_000_100);
        c.list(id.clone(), U128(NEAR));
        ctx(accounts(3), NEAR / 2, 1_700_000_200);
        c.buy(id);
    }

    #[test]
    #[should_panic(expected = "max_len_payout must allow 2 entries")]
    fn a_payout_needs_room_for_the_token() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        c.nft_payout(id, U128(NEAR), Some(1));
    }

    #[test]
    fn the_holder_stakes_the_tokens_money_and_it_stays_with_the_token() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 1, 1_700_000_100);
        c.stake(id.clone(), "kiln.pool.near".parse().unwrap(), U128(NEAR / 10));
        c.nft_transfer(accounts(3), id.clone(), None, None);
        // Only the new holder can unstake it now.
        ctx(accounts(2), 1, 1_700_000_200);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.unstake(id.clone(), "kiln.pool.near".parse().unwrap(), U128(NEAR / 10)))).is_err());
        ctx(accounts(3), 1, 1_700_000_200);
        c.unstake(id.clone(), "kiln.pool.near".parse().unwrap(), U128(NEAR / 10));
        c.withdraw_stake(id.clone(), "kiln.pool.near".parse().unwrap());
        // The history entries come from on_purse_called once the token's account accepts.
        ctx("wayfarers.near".parse().unwrap(), 0, 1_700_000_300);
        assert_eq!(c.history(id)[0].what, "transferred");
    }

    fn callback(result: near_sdk::PromiseResult) {
        testing_env!(
            VMContextBuilder::new().current_account_id("wayfarers.near".parse().unwrap()).predecessor_account_id("wayfarers.near".parse().unwrap()).block_timestamp(1_700_000_150 * 1_000_000_000).account_balance(NearToken::from_near(100)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![result]
        );
    }

    #[test]
    fn a_wayfarer_buys_its_own_item_and_the_studio_keeps_the_price() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 1, 1_700_000_100);
        c.buy_item(id.clone(), 4);
        // The order opens only once the token's account has paid.
        callback(near_sdk::PromiseResult::Successful(vec![]));
        let job = c.on_item_paid(id.clone(), 4).unwrap();
        let p = c.pending(None, None);
        assert_eq!((p.len(), p[0].buyer.as_str(), p[0].amount.0), (1, "42.wayfarers.near", ITEM_PRICE));
        assert_eq!(c.history(id.clone())[0].what, "bought");
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "https://pixelwayfarers.com/items/1.png".into());
        assert_eq!(c.items(id.clone()).len(), 1);
        // No "earned" entry: the Wayfarer paid, it didn't earn.
        assert!(c.history(id).iter().all(|e| e.what != "earned"));
    }

    #[test]
    fn the_v3_migration_drops_old_scenes_and_keeps_items() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        for (n, uri) in ["https://pixelwayfarers.com/scenes/testnet/1.png", "https://pixelwayfarers.com/items/testnet/2.png"].into_iter().enumerate() {
            ctx(accounts(3), PRICE, 1_700_000_100 + n as u64);
            let job = c.commission(id.clone(), 0, None);
            ctx(accounts(1), 0, 1_700_000_200 + n as u64);
            c.fulfil(job, uri.into());
        }
        ctx("wayfarers.near".parse().unwrap(), 0, 1_700_000_300);
        c.drop_scenes(vec![id.clone()]);
        assert_eq!(c.items(id.clone()), vec!["https://pixelwayfarers.com/items/testnet/2.png".to_string()]);
        assert!(c.nft_token(id).unwrap().metadata.unwrap().extra.unwrap().contains("\"items\":1"));
    }

    #[test]
    fn one_wayfarer_gifts_another_and_the_other_earns() {
        let mut c = collection();
        let giver = mint_to(&mut c, accounts(2));
        let other = mint_to(&mut c, accounts(3));
        ctx(accounts(2), 1, 1_700_000_100);
        c.gift_from(giver.clone(), other.clone(), 7);
        callback(near_sdk::PromiseResult::Successful(vec![]));
        let job = c.on_gift_paid(giver.clone(), other.clone(), 7).unwrap();
        let p = c.pending(None, None);
        assert_eq!((p[0].token_id.as_str(), p[0].buyer.as_str()), ("43", "42.wayfarers.near"));
        assert_eq!(c.history(giver)[0].what, "gave");
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "https://pixelwayfarers.com/items/testnet/x/1.png".into());
        let h = c.history(other.clone());
        let last = &h[0]; // newest first
        assert_eq!((last.what.as_str(), last.account.as_str(), last.amount.0), ("earned", "42.wayfarers.near", PEER_GIFT_PRICE * 8 / 10));
        assert_eq!(c.items(other).len(), 1);
    }

    #[test]
    #[should_panic(expected = "only the Wayfarer's current holder")]
    fn only_the_holder_spends_a_wayfarers_money_on_gifts() {
        let mut c = collection();
        let giver = mint_to(&mut c, accounts(2));
        let other = mint_to(&mut c, accounts(3));
        ctx(accounts(3), 1, 1_700_000_100);
        c.gift_from(giver, other, 7);
    }

    #[test]
    fn auto_stake_needs_the_holder_and_runs_at_most_every_six_hours() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        // Off until the holder switches it on.
        ctx(accounts(4), 0, 1_700_000_100);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.auto_stake(id.clone(), U128(NEAR / 10)))).is_err());
        ctx(accounts(3), 1, 1_700_000_100);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.set_auto_stake(id.clone(), Some("kiln.pool.near".parse().unwrap())))).is_err());
        ctx(accounts(2), 1, 1_700_000_100);
        c.set_auto_stake(id.clone(), Some("kiln.pool.near".parse().unwrap()));
        assert_eq!(c.auto_stakers(None, None), vec![(id.clone(), "kiln.pool.near".parse().unwrap(), U64(0))]);
        // Anyone can run it, once per window.
        ctx(accounts(4), 0, 1_700_000_200);
        c.auto_stake(id.clone(), U128(NEAR / 10));
        ctx(accounts(4), 0, 1_700_000_300);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.auto_stake(id.clone(), U128(NEAR / 10)))).is_err());
        ctx(accounts(4), 0, 1_700_000_200 + AUTO_STAKE_GAP_S);
        c.auto_stake(id.clone(), U128(NEAR / 10));
        // The holder switches it off.
        ctx(accounts(2), 1, 1_700_100_000);
        c.set_auto_stake(id.clone(), None);
        assert!(c.auto_stake_of(id).is_none());
    }

    #[test]
    #[should_panic(expected = "not one of the collection's staking pools")]
    fn auto_stake_only_with_allow_listed_pools() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 1, 1_700_000_100);
        c.set_auto_stake(id, Some("attacker.near".parse().unwrap()));
    }

    #[test]
    fn a_refused_item_payment_opens_no_order() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        callback(near_sdk::PromiseResult::Failed);
        assert!(c.on_item_paid(id, 4).is_none());
        assert!(c.pending(None, None).is_empty());
    }

    #[test]
    #[should_panic(expected = "only the Wayfarer's current holder")]
    fn only_the_holder_spends_the_wayfarers_money_on_items() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), 1, 1_700_000_100);
        c.buy_item(id, 4);
    }

    #[test]
    fn an_undelivered_item_goes_back_to_the_wayfarer() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        callback(near_sdk::PromiseResult::Successful(vec![]));
        let job = c.on_item_paid(id, 1).unwrap();
        ctx(accounts(5), 0, 1_700_000_150 + DELIVERY_WINDOW_S);
        c.refund_expired(job);
        assert!(c.pending(None, None).is_empty());
    }

    #[test]
    #[should_panic(expected = "not one of the collection's staking pools")]
    fn only_allow_listed_pools() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(2), 1, 1_700_000_100);
        c.stake(id, "attacker.near".parse().unwrap(), U128(NEAR / 10));
    }

    #[test]
    #[should_panic(expected = "the studio's share is at most half")]
    fn the_studio_share_is_capped() {
        let mut c = collection();
        ctx(accounts(0), 1, 1_700_000_000);
        c.set_prices(U128(NEAR), U128(PRICE), 5_001);
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn only_the_owner_sets_prices() {
        let mut c = collection();
        ctx(accounts(2), 1, 1_700_000_000);
        c.set_prices(U128(0), U128(1), 0);
    }

    #[test]
    #[should_panic(expected = "an https URL")]
    fn an_item_must_be_an_https_url() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), PRICE, 1_700_000_100);
        let job = c.commission(id, 0, None);
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "javascript:alert(1)".into());
    }
}
