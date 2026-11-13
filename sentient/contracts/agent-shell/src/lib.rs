//! The agent shell.
//!
//! Every Sentient agent is a NEAR account created by the registry contract. A parent contract cannot add or delete keys on
//! a sub-account it created, because those actions need the account's own authority. But a contract deployed *on* the
//! account is the account: what it schedules against its own id is signed by the account itself. So the registry deploys
//! this shell to each agent account when it creates it, and from then on it can:
//!
//!  * `revoke`: delete a key, so a seller's key stops existing the moment the NFT changes hands (a deleted key cannot even
//!    pay for a failed call, which closes the "old keeper burns the buyer's gas" attack);
//!  * `grant`: add a function-call key, so a new owner can give the agent a new voice;
//!  * `sweep`: send the account's spare balance (its gas tank) to a person, so the tank is not a one-way trip.
//!
//! It holds no state and trusts exactly one caller: the registry, which is the account's parent in its own name
//! (`a7.sentient.near` -> `sentient.near`). The account's one function-call key can only call the registry, never this
//! shell, so no agent key and no stranger can reach these methods.
//!
//! It is written against the host functions directly, with no allocator and no formatting, because its code is stored in
//! every agent's account and storage staking charges for each byte: a few kilobytes here is a few hundredths of a NEAR per
//! agent. Arguments are plain bytes, laid out as below.
#![no_std]

use near_sys as sys;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Left in the account when sweeping, so the sweep itself and one more call can always pay.
const SWEEP_BUFFER: u128 = 1_000_000_000_000_000_000_000;
/// NEAR's price per byte of storage.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;

const ME: u64 = 0;
const PRED: u64 = 1;
const INPUT: u64 = 2;

fn fail(msg: &[u8]) -> ! {
    unsafe { sys::panic_utf8(msg.len() as u64, msg.as_ptr() as u64) }
}

/// Copy a register into `buf` and return its length.
fn load(reg: u64, buf: &mut [u8]) -> usize {
    unsafe {
        let n = sys::register_len(reg) as usize;
        if n > buf.len() {
            fail(b"argument too long");
        }
        sys::read_register(reg, buf.as_mut_ptr() as u64);
        n
    }
}

/// Fails unless the caller is this account's parent. Returns this account's id.
fn only_registry(me: &mut [u8; 64]) -> usize {
    let mut pred = [0u8; 64];
    unsafe {
        sys::current_account_id(ME);
        sys::predecessor_account_id(PRED);
    }
    let n = load(ME, me);
    let m = load(PRED, &mut pred);
    let mut dot = 0;
    while dot < n && me[dot] != b'.' {
        dot += 1;
    }
    if dot == n || &me[dot + 1..n] != &pred[..m] {
        fail(b"only the registry");
    }
    n
}

fn input(buf: &mut [u8]) -> usize {
    unsafe { sys::input(INPUT) };
    load(INPUT, buf)
}

fn batch_to(id: &[u8]) -> u64 {
    unsafe { sys::promise_batch_create(id.len() as u64, id.as_ptr() as u64) }
}

/// Input: the Borsh bytes of a public key (curve byte, then the key).
#[no_mangle]
pub extern "C" fn revoke() {
    let mut me = [0u8; 64];
    let n = only_registry(&mut me);
    let mut key = [0u8; 80];
    let k = input(&mut key);
    let p = batch_to(&me[..n]);
    unsafe { sys::promise_batch_action_delete_key(p, k as u64, key.as_ptr() as u64) };
}

/// Input: `klen: u8`, the key (Borsh bytes), `rlen: u8`, the receiver account id, then the comma-separated method names.
/// Adds a function-call key with an unlimited allowance.
#[no_mangle]
pub extern "C" fn grant() {
    let mut me = [0u8; 64];
    let n = only_registry(&mut me);
    let mut buf = [0u8; 512];
    let len = input(&mut buf);
    if len < 2 {
        fail(b"bad arguments");
    }
    let klen = buf[0] as usize;
    if 1 + klen + 1 > len {
        fail(b"bad arguments");
    }
    let rlen = buf[1 + klen] as usize;
    let rstart = 2 + klen;
    if rstart + rlen > len {
        fail(b"bad arguments");
    }
    let key = &buf[1..1 + klen];
    let receiver = &buf[rstart..rstart + rlen];
    let methods = &buf[rstart + rlen..len];
    let allowance = [0u8; 16]; // zero means unlimited
    let p = batch_to(&me[..n]);
    unsafe {
        sys::promise_batch_action_add_key_with_function_call(
            p,
            key.len() as u64,
            key.as_ptr() as u64,
            0,
            allowance.as_ptr() as u64,
            receiver.len() as u64,
            receiver.as_ptr() as u64,
            methods.len() as u64,
            methods.as_ptr() as u64,
        )
    };
}

/// Input: `keep: u128` (16 bytes, little endian), then the account id to pay. Sends everything above the storage stake,
/// `keep` and a small buffer.
#[no_mangle]
pub extern "C" fn sweep() {
    let mut me = [0u8; 64];
    only_registry(&mut me);
    let mut buf = [0u8; 96];
    let len = input(&mut buf);
    if len <= 16 {
        fail(b"bad arguments");
    }
    let mut keep_bytes = [0u8; 16];
    keep_bytes.copy_from_slice(&buf[..16]);
    let keep = u128::from_le_bytes(keep_bytes);
    let to = &buf[16..len];
    let mut bal = [0u8; 16];
    unsafe { sys::account_balance(bal.as_mut_ptr() as u64) };
    let balance = u128::from_le_bytes(bal);
    let stake = unsafe { sys::storage_usage() } as u128 * BYTE_COST;
    let free = balance.saturating_sub(stake).saturating_sub(keep).saturating_sub(SWEEP_BUFFER);
    if free == 0 {
        fail(b"nothing to sweep");
    }
    let p = batch_to(to);
    let amount = free.to_le_bytes();
    unsafe { sys::promise_batch_action_transfer(p, amount.as_ptr() as u64) };
}
