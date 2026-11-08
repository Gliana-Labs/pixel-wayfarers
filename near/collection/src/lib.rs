//! Pixel Wayfarers on NEAR: NFTs that earn (NEAR HACKATHON 2026, track "NFTs That Do Something").
//!
//! A NEP-171 collection (with NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration, NEP-297 events) where each
//! token is also an account:
//!
//!   - Minting Wayfarer #42 creates `42.<this account>`, with no access keys, running the shared purse
//!     (near/purse) as a global contract fixed by its code hash. The purse pays out only when this contract asks.
//!   - Anyone can `commission` a scene starring a Wayfarer. The money waits in escrow here. When the studio delivers
//!     (`fulfil`), the royalty goes straight to the token's own account and the studio keeps its share; if it never
//!     delivers, the buyer takes everything back after 24 h (`refund_expired`). Each delivered scene is added to the
//!     token, so its gallery grows.
//!   - The money in a token's account belongs to the token. `withdraw` pays it to whoever holds the token at that
//!     moment, so selling the NFT sells the account, its balance and the right to it together.
//!   - Every token keeps its own history: minted, transferred, earned, paid out.
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
const MOST_SCENES: usize = 24;
const MOST_NOTE: usize = 140;
/// Scene presets the studio knows how to paint in the collection's style. Free text is only a short note.
pub const SCENES: u8 = 12;
const PAY_GAS: Gas = Gas::from_tgas(10);
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
    Scenes,
    History,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Commission {
    pub id: U64,
    pub token_id: TokenId,
    pub buyer: AccountId,
    pub scene: u8,
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
    pub scenes: u8,
    pub delivery_window_s: U64,
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
    scenes: LookupMap<TokenId, Vec<String>>,
    history: LookupMap<TokenId, Vec<Entry>>,
}

#[near]
impl Wayfarers {
    /// `purse_code_hash`: the global contract every token account runs (near/purse), published before this.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(owner: AccountId, studio: AccountId, purse_code_hash: Base58CryptoHash, mint_price: U128, purse_deposit: U128, commission_price: U128, studio_bps: u16, max_supply: u32, starting_index: u32, media_base: String, reference_base: String) -> Self {
        require!(studio_bps <= MOST_STUDIO_BPS, "the studio's share is at most half");
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
            scenes: LookupMap::new(Key::Scenes),
            history: LookupMap::new(Key::History),
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
            description: Some("A pixel wayfarer that is also a NEAR account: it earns from every scene commissioned with it, and pays whoever holds it.".to_string()),
            media: Some(format!("{}/{art}.png", self.media_base)),
            media_hash: None,
            copies: Some(1),
            issued_at: Some(env::block_timestamp_ms().to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(json!({ "account": account, "scenes": 0 }).to_string()),
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

    /// Commission a scene starring `token_id`: `scene` is one of the studio's presets (0..SCENES), `note` up to 140
    /// characters. Attach exactly `commission_price`. It waits in escrow until delivered or refunded.
    #[payable]
    pub fn commission(&mut self, token_id: TokenId, scene: u8, note: Option<String>) -> U64 {
        require!(!self.paused, "commissions are paused");
        require!(self.tokens.owner_by_id.get(&token_id).is_some(), "no such Wayfarer");
        require!(scene < SCENES, "no such scene");
        let note = note.unwrap_or_default();
        require!(note.chars().count() <= MOST_NOTE, "the note is at most 140 characters");
        require!(env::attached_deposit().as_yoctonear() == self.commission_price, format!("attach exactly {} yoctoNEAR", self.commission_price));
        let id = self.next_commission;
        self.next_commission += 1;
        let c = Commission { id: U64(id), token_id, buyer: env::predecessor_account_id(), scene, note, amount: U128(self.commission_price), at: U64(now_s()) };
        log_event("commission", json!(c));
        self.commissions.insert(id, c);
        U64(id)
    }

    /// The studio delivers: the scene is added to the token, the royalty goes to the token's own account, the
    /// studio takes its share. Only the studio account may call this.
    pub fn fulfil(&mut self, id: U64, scene_uri: String) {
        require!(env::predecessor_account_id() == self.studio, "only the studio delivers");
        require!(scene_uri.len() <= 200 && scene_uri.starts_with("https://"), "scene_uri: an https URL, at most 200 characters");
        let before = env::storage_usage();
        let c = self.commissions.remove(&id.0).unwrap_or_else(|| env::panic_str("no such commission"));
        let royalty = c.amount.0 * u128::from(10_000 - self.studio_bps) / 10_000;
        let mut studio_cut = c.amount.0 - royalty;
        // Straight to the token's own account, whoever holds the token right now: the money is the token's.
        let purse = env::promise_batch_create(&self.purse_of(c.token_id.clone()));
        env::promise_batch_action_transfer(purse, NearToken::from_yoctonear(royalty));
        let mut scenes = self.scenes.get(&c.token_id).cloned().unwrap_or_default();
        scenes.push(scene_uri.clone());
        if scenes.len() > MOST_SCENES {
            scenes.remove(0);
        }
        let count = scenes.len();
        self.scenes.insert(c.token_id.clone(), scenes);
        self.update_extra(&c.token_id, count);
        self.record(&c.token_id, "earned", &c.buyer, royalty);
        // The new scene's storage comes out of the studio's share, never the token's royalty.
        let grew = u128::from(env::storage_usage().saturating_sub(before)) * env::storage_byte_cost().as_yoctonear();
        require!(studio_cut >= grew, "the studio's share doesn't cover the scene's storage");
        studio_cut -= grew;
        if studio_cut > 0 {
            let p = env::promise_batch_create(&self.studio);
            env::promise_batch_action_transfer(p, NearToken::from_yoctonear(studio_cut));
        }
        log_event("fulfilled", json!({ "id": id, "token_id": c.token_id, "scene_uri": scene_uri, "royalty": U128(royalty) }));
    }

    /// Anyone may return an undelivered commission to its buyer once its window has passed.
    pub fn refund_expired(&mut self, id: U64) {
        let c = self.commissions.get(&id.0).cloned().unwrap_or_else(|| env::panic_str("no such commission"));
        require!(now_s() >= c.at.0 + DELIVERY_WINDOW_S, "still inside its delivery window");
        self.commissions.remove(&id.0);
        let p = env::promise_batch_create(&c.buyer);
        env::promise_batch_action_transfer(p, NearToken::from_yoctonear(c.amount.0));
        log_event("refunded", json!({ "id": id, "token_id": c.token_id, "buyer": c.buyer }));
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

    /// Writes the payout into the token's history only if the purse actually paid.
    #[private]
    pub fn on_paid_out(&mut self, token_id: TokenId, to: AccountId, amount: U128) -> bool {
        let paid = env::promise_result_checked(0, 64).is_ok();
        if paid {
            self.record(&token_id, "paid_out", &to, amount.0);
        }
        paid
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

    // ── views ────────────────────────────────────────────────────────────────

    /// The token's own NEAR account: `<token_id>.<this account>`.
    pub fn purse_of(&self, token_id: TokenId) -> AccountId {
        format!("{token_id}.{}", env::current_account_id()).parse().unwrap_or_else(|_| env::panic_str("token id makes no account id"))
    }

    pub fn history(&self, token_id: TokenId) -> Vec<Entry> {
        self.history.get(&token_id).cloned().unwrap_or_default().into_iter().rev().collect()
    }

    pub fn scenes(&self, token_id: TokenId) -> Vec<String> {
        self.scenes.get(&token_id).cloned().unwrap_or_default()
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
            scenes: SCENES,
            delivery_window_s: U64(DELIVERY_WINDOW_S),
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

    fn record(&mut self, token_id: &TokenId, what: &str, account: &AccountId, amount: u128) {
        let mut h = self.history.get(token_id).cloned().unwrap_or_default();
        if h.len() >= MOST_HISTORY {
            h.remove(0);
        }
        h.push(Entry { at: U64(now_s()), what: what.to_string(), account: account.clone(), amount: U128(amount) });
        self.history.insert(token_id.clone(), h);
    }

    /// The token's metadata says how many scenes it has: a dynamic NFT, announced with nft_metadata_update.
    fn update_extra(&mut self, token_id: &TokenId, scenes: usize) {
        let account = self.purse_of(token_id.clone());
        if let Some(by_id) = self.tokens.token_metadata_by_id.as_mut() {
            if let Some(mut m) = by_id.get(token_id) {
                m.extra = Some(json!({ "account": account, "scenes": scenes }).to_string());
                m.updated_at = Some(env::block_timestamp_ms().to_string());
                by_id.insert(token_id, &m);
            }
        }
        env::log_str(&format!("EVENT_JSON:{}", json!({ "standard": "nep171", "version": "1.2.0", "event": "nft_metadata_update", "data": [{ "token_ids": [token_id] }] })));
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
        Wayfarers::new(accounts(0), accounts(1), [7u8; 32].into(), U128(NEAR), U128(NEAR / 100), U128(PRICE), 2_000, 1_000, 41, "ipfs://art".into(), "ipfs://meta".into())
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
        c.fulfil(job, "https://pixelwayfarers.com/scenes/1.png".into());
        assert!(c.pending(None, None).is_empty());
        let h = c.history(id.clone());
        assert_eq!((h[0].what.as_str(), h[0].amount.0), ("earned", PRICE * 8 / 10));
        assert_eq!(c.scenes(id.clone()).len(), 1);
        assert!(c.nft_token(id).unwrap().metadata.unwrap().extra.unwrap().contains("\"scenes\":1"));
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
        c.fulfil(job, "https://pixelwayfarers.com/scenes/2.png".into());
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
    fn a_scene_must_be_an_https_url() {
        let mut c = collection();
        let id = mint_to(&mut c, accounts(2));
        ctx(accounts(3), PRICE, 1_700_000_100);
        let job = c.commission(id, 0, None);
        ctx(accounts(1), 0, 1_700_000_200);
        c.fulfil(job, "javascript:alert(1)".into());
    }
}
