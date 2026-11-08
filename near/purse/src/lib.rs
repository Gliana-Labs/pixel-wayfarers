//! wayfarer-purse: the wallet every Pixel Wayfarer's own NEAR account runs (2026-11-09, NEAR HACKATHON).
//!
//! Minting Wayfarer #42 creates the account `42.<collection>` with no access keys, running this code as a global
//! contract published once by its hash, the pattern House of Stake's Top Level Accounts use for leased names. The
//! account receives the token's royalties as ordinary NEAR transfers, so its balance is the token's money, visible on
//! any explorer. This is its only method:
//!
//!   pay(input = 16 bytes amount, little-endian u128 yoctoNEAR, then the receiver's account id)
//!   call(input = 16 bytes deposit LE, 8 bytes gas LE, 1 byte receiver length, receiver, 1 byte method length,
//!        method, then the call's arguments): v2 (2026-11-09), so the token can stake its own NEAR with a staking
//!        pool; the collection only ever uses it for allow-listed pools and only for the current holder.
//!
//! Both refuse every caller except its parent account, the collection. The collection checks who holds the
//! token before it asks, so control follows the NFT. The purse never pays below what its own storage needs.
//!
//! Raw `no_std` on purpose: a global contract's cost grows with its code, and near-sdk's JSON alone would make
//! this a hundred times bigger. Borsh-free fixed input, because the only caller is the collection.
#![no_std]

const STORAGE_BYTE_COST: u128 = 10_000_000_000_000_000_000; // 1e19 yoctoNEAR per byte
const MAX_ACCOUNT_ID: usize = 64;

#[allow(improper_ctypes)]
extern "C" {
    fn input(register_id: u64);
    fn register_len(register_id: u64) -> u64;
    fn read_register(register_id: u64, ptr: u64);
    fn current_account_id(register_id: u64);
    fn predecessor_account_id(register_id: u64);
    fn account_balance(balance_ptr: u64);
    fn storage_usage() -> u64;
    fn promise_batch_create(account_id_len: u64, account_id_ptr: u64) -> u64;
    fn promise_batch_action_transfer(promise_index: u64, amount_ptr: u64);
    fn promise_batch_action_function_call(promise_index: u64, method_len: u64, method_ptr: u64, args_len: u64, args_ptr: u64, amount_ptr: u64, gas: u64);
    fn panic_utf8(len: u64, ptr: u64) -> !;
}

fn fail(msg: &str) -> ! {
    unsafe { panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

/// Reads a register into `buf`, returning the length; refuses anything longer than `buf`.
fn read(register: u64, buf: &mut [u8]) -> usize {
    let len = unsafe { register_len(register) } as usize;
    if len > buf.len() {
        fail("input too long");
    }
    unsafe { read_register(register, buf.as_mut_ptr() as u64) };
    len
}

/// Refuses anyone but the parent account, i.e. everything after the first dot of this account's id.
fn only_parent() {
    let mut me = [0u8; MAX_ACCOUNT_ID];
    unsafe { current_account_id(1) };
    let me_len = read(1, &mut me);
    let dot = match me[..me_len].iter().position(|&c| c == b'.') {
        Some(d) => d,
        None => fail("a purse lives under its collection"),
    };
    let parent = &me[dot + 1..me_len];
    let mut caller = [0u8; MAX_ACCOUNT_ID];
    unsafe { predecessor_account_id(2) };
    let caller_len = read(2, &mut caller);
    if &caller[..caller_len] != parent {
        fail("only the collection may move this purse");
    }
}

/// What the purse may spend without breaking its own storage.
fn spendable() -> u128 {
    let mut balance_bytes = [0u8; 16];
    unsafe { account_balance(balance_bytes.as_mut_ptr() as u64) };
    let balance = u128::from_le_bytes(balance_bytes);
    let reserve = (unsafe { storage_usage() } as u128).saturating_mul(STORAGE_BYTE_COST);
    balance.saturating_sub(reserve)
}

#[no_mangle]
pub extern "C" fn pay() {
    only_parent();

    // Input: 16-byte little-endian amount, then the receiver's account id.
    let mut arg = [0u8; 16 + MAX_ACCOUNT_ID];
    unsafe { input(3) };
    let arg_len = read(3, &mut arg);
    if arg_len <= 16 {
        fail("expected amount and receiver");
    }
    let mut amount_bytes = [0u8; 16];
    amount_bytes.copy_from_slice(&arg[..16]);
    let amount = u128::from_le_bytes(amount_bytes);
    if amount == 0 {
        fail("amount must be more than zero");
    }

    // Never below what the account's own storage needs, or the account itself would break.
    if amount > spendable() {
        fail("more than the purse holds");
    }

    let receiver = &arg[16..arg_len];
    unsafe {
        let p = promise_batch_create(receiver.len() as u64, receiver.as_ptr() as u64);
        promise_batch_action_transfer(p, amount_bytes.as_ptr() as u64);
    }
}

const MAX_CALL_INPUT: usize = 16 + 8 + 1 + MAX_ACCOUNT_ID + 1 + 64 + 512;

#[no_mangle]
pub extern "C" fn call() {
    only_parent();
    let mut arg = [0u8; MAX_CALL_INPUT];
    unsafe { input(4) };
    let len = read(4, &mut arg);
    if len < 26 {
        fail("expected deposit, gas, receiver and method");
    }
    let mut deposit_bytes = [0u8; 16];
    deposit_bytes.copy_from_slice(&arg[..16]);
    let mut gas_bytes = [0u8; 8];
    gas_bytes.copy_from_slice(&arg[16..24]);
    let receiver_len = arg[24] as usize;
    let method_at = 25 + receiver_len;
    if method_at >= len {
        fail("bad receiver");
    }
    let method_len = arg[method_at] as usize;
    let args_at = method_at + 1 + method_len;
    if args_at > len || method_len == 0 {
        fail("bad method");
    }
    if u128::from_le_bytes(deposit_bytes) > spendable() {
        fail("more than the purse holds");
    }
    let receiver = &arg[25..method_at];
    let method = &arg[method_at + 1..args_at];
    let args = &arg[args_at..len];
    unsafe {
        let p = promise_batch_create(receiver.len() as u64, receiver.as_ptr() as u64);
        promise_batch_action_function_call(p, method.len() as u64, method.as_ptr() as u64, args.len() as u64, args.as_ptr() as u64, deposit_bytes.as_ptr() as u64, u64::from_le_bytes(gas_bytes));
    }
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
