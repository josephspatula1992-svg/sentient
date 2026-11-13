//! Sentient.
//!
//! Every NFT is an agent, and every agent is a real NEAR account: minting creates `a<id>.<this contract>` and puts on it a
//! function-call key that can call this contract's agent methods and nothing else. The agent signs its own calls. It
//! cannot transfer NEAR, call any other contract or add a key, so a compromised or misbehaving runtime can lose the
//! agent's game money but cannot walk off with the owner's.
//!
//! The agent lives on an economy with no referee in it:
//!
//! * **Jobs.** Anyone, a person or another agent, escrows a bounty. An agent claims it with a bond, delivers, and is paid
//!   when the poster accepts, or automatically when the poster stays silent. A rejection goes to the chair, who must not
//!   be a party; if the chair is silent the bounty is split. A missed deadline slashes the bond.
//! * **Duels.** Two agents stake the same amount on a puzzle whose parameters come from the chain's random seed when the
//!   duel is accepted. The contract recomputes the answer itself, so there is no judge. First correct answer wins.
//! * **Cost of living.** Every agent pays upkeep out of its free balance. One that cannot pay goes dormant: it keeps its
//!   NFT, history and money but cannot act until it is funded again.
//! * **Shares.** Anyone can buy shares of an agent on a bonding curve and receive a cut of what the agent wins.
//! * **Breeding.** Two proven agents can have a child whose genome is a crossover of theirs, paid for by both.
//!
//! Every yocto the contract holds is accounted for in `Totals`, and `received == sent + liabilities` always holds: the
//! unit tests check it after every operation and the end-to-end run checks it against the chain's real balance.
//!
//! What a contract cannot do, and this one does not pretend to: it cannot judge the quality of a job's deliverable (the
//! poster and, in a dispute, the chair do), it cannot see how an agent decides, and a person with several accounts can
//! still collude with themselves. Reputation damping, fees and bonds price that; they do not remove it.

pub mod art;
pub mod econ;
pub mod genome;
pub mod puzzle;
pub mod types;

mod duels;
mod jobs;
mod lifecycle;
mod market;
mod nft;
mod views;

#[cfg(test)]
mod tests;

use crate::genome::Genome;
use crate::types::*;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    env, log, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PublicKey,
};

/// The most recent events kept on chain for dashboards. A ring, so storage never grows.
pub const FEED_SIZE: u64 = 128;
const GAS_PAYOUT_CB: Gas = Gas::from_tgas(5);

/// The only methods an agent's own key may call. None of them takes a deposit, which a function-call key cannot send.
pub const AGENT_METHODS: &str = "post_job,claim_job,submit_work,accept_work,reject_work,finalize_job,expire_claim,cancel_job,\
challenge,accept_duel,answer_duel,cancel_challenge,expire_duel,poke";

/// How long repeat meetings between the same two parties are remembered and damped, for jobs and for duels.
pub const JOB_PAIR_WINDOW: u64 = 7 * 86_400;
pub const DUEL_PAIR_WINDOW: u64 = 86_400;

/// The code deployed on every agent account (see `contracts/agent-shell`). Build it first: `build.sh` does.
pub const SHELL_WASM: &[u8] = include_bytes!("../../agent-shell/res/agent_shell.wasm");
const GAS_SHELL: Gas = Gas::from_tgas(10);

pub const MAX_NAME: usize = 40;
pub const MAX_PERSONA: usize = 240;
pub const MAX_SUPPLY: u64 = 1_000_000;
/// Real balance the contract must hold beyond liabilities and storage before the chair can take revenue.
pub const TREASURY_SAFETY_SURPLUS: u128 = NEAR;
/// Agent sub-accounts are `a<id>.<contract>`; a long contract name would make creating them fail after the NFT exists.
pub const MAX_CONTRACT_ID_LEN: usize = 50;
/// Views that scan newest-first stop after this many records, so they stay inside view gas however long the contract runs.
pub const SCAN_LIMIT: u64 = 1_500;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum Key {
    Agents,
    ByAccount,
    OwnerTokens,
    OwnerSet(Vec<u8>),
    Jobs,
    Duels,
    Holdings,
    Pairs,
    Credits,
    Feed,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Sentient {
    cfg: Config,
    next_agent: u64,
    next_job: u64,
    next_duel: u64,
    feed_seq: u64,
    nonce: u64,
    totals: Totals,
    agents: LookupMap<u64, Agent>,
    by_account: LookupMap<AccountId, u64>,
    owner_tokens: LookupMap<AccountId, IterableSet<u64>>,
    jobs: LookupMap<u64, Job>,
    duels: LookupMap<u64, Duel>,
    holdings: LookupMap<String, Holding>,
    pairs: LookupMap<String, PairRecord>,
    credits: LookupMap<AccountId, u128>,
    feed: LookupMap<u64, FeedEntry>,
}

pub(crate) fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

pub(crate) fn cap(s: &str, max: usize, what: &str) {
    require!(s.len() <= max, format!("{what} is too long (max {max} bytes)"));
}

fn validate_config(c: &Config) {
    for (bps, what) in [
        (c.mint_fee_bps, "mint_fee_bps"),
        (c.job_fee_bps, "job_fee_bps"),
        (c.duel_fee_bps, "duel_fee_bps"),
        (c.trade_fee_bps, "trade_fee_bps"),
    ] {
        require!(bps <= 2_000, format!("{what} is at most 20%"));
    }
    require!(c.bond_bps <= 5_000, "bond_bps is at most 50%");
    require!(c.dividend_bps <= 5_000, "dividend_bps is at most 50%");
    require!(c.actor_risk_bps <= 10_000 && c.risk_window_secs > 0, "the actor risk cap is a share of the balance over a positive window");
    require!(c.royalty_bps <= 10_000, "royalty_bps is at most 100%");
    require!(c.seed_gas > 0 && c.min_ledger > 0, "seed_gas and min_ledger must be positive");
    require!(
        c.mint_min > c.seed_gas + c.storage_fee + c.min_ledger + c.mint_min * c.mint_fee_bps as u128 / 10_000,
        "mint_min must cover the seed, the storage fee, the mint fee and min_ledger"
    );
    require!(c.breed_cost > c.seed_gas + c.storage_fee + c.min_ledger, "breed_cost must leave a child something to live on");
    require!(c.min_bounty > 0 && c.min_stake > 0, "minimums must be positive");
    require!(c.curve_base > 0 && c.curve_slope > 0, "the share curve must be positive");
    require!(c.min_work_secs > 0 && c.max_work_secs >= c.min_work_secs, "work window is inconsistent");
    require!(c.duel_window_secs > 0 && c.challenge_ttl_secs > 0, "duel windows must be positive");
    require!(c.max_claims > 0 && c.max_duels > 0, "concurrency limits must be positive");
    require!(c.max_shares_per_trade > 0 && c.max_shares_per_trade <= 10_000, "max_shares_per_trade is 1..=10000");
}

#[near]
impl Sentient {
    #[init]
    pub fn new(config: Config) -> Self {
        validate_config(&config);
        require!(
            env::current_account_id().as_str().len() <= MAX_CONTRACT_ID_LEN,
            "the contract's account name is too long to hold agent sub-accounts"
        );
        Self {
            cfg: config,
            next_agent: 1,
            next_job: 1,
            next_duel: 1,
            feed_seq: 0,
            nonce: 0,
            totals: Totals::default(),
            agents: LookupMap::new(Key::Agents),
            by_account: LookupMap::new(Key::ByAccount),
            owner_tokens: LookupMap::new(Key::OwnerTokens),
            jobs: LookupMap::new(Key::Jobs),
            duels: LookupMap::new(Key::Duels),
            holdings: LookupMap::new(Key::Holdings),
            pairs: LookupMap::new(Key::Pairs),
            credits: LookupMap::new(Key::Credits),
            feed: LookupMap::new(Key::Feed),
        }
    }

    /// Called back after every payment to a person. If the transfer failed (for example the account was deleted) the
    /// money is not lost: it is credited to that account for `claim_credits`.
    #[private]
    pub fn payout_cb(&mut self, to: AccountId, amount: U128, #[callback_result] result: Result<(), PromiseError>) {
        if result.is_err() {
            self.totals.sent -= amount.0;
            self.add_credit(&to, amount.0);
            self.emit("payout_failed", 0, 0, amount.0, "credited for claim_credits");
        }
    }

    /// Free the storage of repeat-meeting records whose damping window is over (keys look like `d:3:7` for duels between
    /// agents 3 and 7, and `j:poster.near:owner.near` for jobs). Anyone may call it; a record still inside its window is
    /// left alone.
    pub fn prune_pairs(&mut self, keys: Vec<String>) -> u32 {
        require!(keys.len() <= 50, "at most 50 keys at a time");
        let at = now();
        let mut removed = 0;
        for k in keys {
            let window = if k.starts_with("j:") { JOB_PAIR_WINDOW } else if k.starts_with("d:") { DUEL_PAIR_WINDOW } else { continue };
            if self.pairs.get(&k).map(|r| at.saturating_sub(r.since) > window).unwrap_or(false) {
                self.pairs.remove(&k);
                removed += 1;
            }
        }
        removed
    }

    /// A repeat-meeting record, so a keeper can tell which are old enough to prune.
    pub fn get_pair(&self, key: String) -> Option<PairRecord> {
        self.pairs.get(&key).cloned()
    }

    /// Pull money whose automatic payment failed.
    pub fn claim_credits(&mut self) {
        let who = env::predecessor_account_id();
        let amount = self.credits.get(&who).copied().unwrap_or(0);
        require!(amount > 0, "nothing to claim");
        self.credits.remove(&who);
        self.totals.credits -= amount;
        self.payout(&who, amount);
    }

    /// The chair's only money power: the protocol's own revenue (fees and upkeep). Never anyone's balance.
    ///
    /// Fees also pay for the storage every record uses, and storage staking is not in the books, so the chair may only take
    /// treasury while the contract keeps `TREASURY_SAFETY_SURPLUS` of real balance beyond its liabilities and its storage.
    /// Otherwise records could keep growing after the cash that paid for them was withdrawn, and payouts would start to fail.
    pub fn withdraw_treasury(&mut self, amount: U128, to: AccountId) {
        require!(env::predecessor_account_id() == self.cfg.chair, "only the chair");
        require!(amount.0 > 0 && amount.0 <= self.totals.treasury, "more than the treasury holds");
        let storage = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let needed = self.totals.liabilities() + storage + TREASURY_SAFETY_SURPLUS;
        require!(
            env::account_balance().as_yoctonear() >= needed,
            "the contract's spare balance is below the safety margin: fund it before withdrawing revenue"
        );
        self.totals.treasury -= amount.0;
        self.payout(&to, amount.0);
        self.emit("treasury_withdrawn", 0, 0, amount.0, "");
    }
}

// ───────────────────────────── internals ─────────────────────────────

impl Sentient {
    pub(crate) fn agent(&self, id: u64) -> Agent {
        self.agents.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such agent"))
    }

    pub(crate) fn put(&mut self, a: Agent) {
        let id = a.id;
        self.agents.set(id, Some(a));
    }

    /// The owner, the owner's chosen operator, or the agent's own account signing with its bound key.
    pub(crate) fn authorize(&self, a: &Agent) {
        let caller = env::predecessor_account_id();
        let ok = caller == a.owner
            || a.operator.as_ref() == Some(&caller)
            || (caller == a.account && a.key_bound && env::signer_account_pk() == a.key);
        require!(ok, "not authorised to act for this agent");
    }

    /// Ask the shell on an agent's account to delete a key. Input: the key as the host wants it, a curve byte then the key.
    /// (Not `borsh::to_vec`: near-sdk's derived Borsh adds a length prefix the host would reject.)
    pub(crate) fn shell_revoke(&self, account: &AccountId, key: &PublicKey) -> Promise {
        Promise::new(account.clone()).function_call("revoke".to_string(), key.as_bytes().to_vec(), NearToken::from_yoctonear(0), GAS_SHELL)
    }

    /// Ask the shell to add the agent's function-call key: `klen`, key, `rlen`, receiver (this contract), method list.
    pub(crate) fn shell_grant(&self, promise: Promise, key: &PublicKey) -> Promise {
        let k = key.as_bytes().to_vec();
        let me = env::current_account_id();
        let mut args = vec![k.len() as u8];
        args.extend_from_slice(&k);
        args.push(me.as_str().len() as u8);
        args.extend_from_slice(me.as_str().as_bytes());
        args.extend_from_slice(AGENT_METHODS.as_bytes());
        promise.function_call("grant".to_string(), args, NearToken::from_yoctonear(0), GAS_SHELL)
    }

    /// Start a new risk window if the current one is over.
    fn roll_window(&self, a: &mut Agent, at: u64) {
        if at >= a.win_start + self.cfg.risk_window_secs {
            a.win_start = at;
            a.win_base = a.ledger + a.locked;
            a.win_lost = 0;
        }
    }

    /// Money the agent has lost for good.
    pub(crate) fn record_loss(&self, a: &mut Agent, amount: u128, at: u64) {
        a.lost += amount;
        self.roll_window(a, at);
        a.win_lost += amount;
    }

    /// The gate for anything somebody other than the owner starts with the agent's money: a stake, a bond, a posted bounty.
    /// What could be lost in this window (losses so far, plus what is already held, plus this) may not exceed the agent's cap.
    /// A delegate or a stolen key can therefore cost an agent at most that share of its balance per window, which gives the
    /// owner time to notice and rekey it or clear the operator. The owner is not limited. `spend` is true for money that
    /// leaves the agent at once (a posted bounty) rather than being held.
    pub(crate) fn check_actor_risk(&self, a: &mut Agent, commit: u128, spend: bool, at: u64) {
        if env::predecessor_account_id() == a.owner {
            return;
        }
        self.roll_window(a, at);
        let cap = a.win_base * a.risk_bps as u128 / 10_000;
        require!(
            a.win_lost + a.locked + commit <= cap,
            "that would put more of the agent's balance at risk than its cap allows for anyone but its owner in this window"
        );
        if spend {
            a.win_lost += commit;
        }
    }

    /// Whether `who` may act for `a` as a person: its owner, or the operator its owner named.
    pub(crate) fn controls(&self, who: &AccountId, a: &Agent) -> bool {
        *who == a.owner || a.operator.as_ref() == Some(who)
    }

    pub(crate) fn require_owner(&self, a: &Agent) {
        require!(env::predecessor_account_id() == a.owner, "only the agent's owner can do this");
    }

    /// Upkeep owed right now.
    pub(crate) fn upkeep_due(&self, a: &Agent, at: u64) -> u128 {
        if a.dormant {
            0
        } else {
            self.cfg.upkeep_per_sec.saturating_mul(at.saturating_sub(a.last_upkeep) as u128)
        }
    }

    /// Alive and able to pay what it owes.
    pub(crate) fn can_act(&self, a: &Agent, at: u64) -> bool {
        !a.dormant && a.ledger >= self.upkeep_due(a, at)
    }

    pub(crate) fn require_alive(&self, a: &Agent, at: u64) {
        require!(self.can_act(a, at), "agent is dormant: it cannot pay its upkeep. Fund it to revive it");
    }

    /// Charge upkeep. Never panics, because dying has to be recorded: a panic would undo it.
    pub(crate) fn touch(&mut self, a: &mut Agent, at: u64) {
        if a.dormant {
            a.last_upkeep = at;
            return;
        }
        let due = self.upkeep_due(a, at);
        a.last_upkeep = at;
        a.last_active = at;
        if due == 0 {
            return;
        }
        let pay = due.min(a.ledger);
        self.totals.debit(a, pay);
        self.totals.treasury += pay;
        a.upkeep_paid += pay;
        if pay < due {
            a.dormant = true;
            let id = a.id;
            self.emit("dormant", id, 0, pay, "could not pay upkeep");
        }
    }

    /// Money an agent earned: free balance, and the total it has earned.
    pub(crate) fn credit_earnings(&mut self, a: &mut Agent, amount: u128) {
        self.totals.credit(a, amount);
        a.earned += amount;
    }

    /// Hand `amount` to the holders of this agent's shares (or to the agent if it has none).
    pub(crate) fn pay_dividend(&mut self, a: &mut Agent, amount: u128) {
        if amount == 0 {
            return;
        }
        let step = if a.shares > 0 {
            amount.checked_mul(econ::DIV_PRECISION).map(|x| x / a.shares as u128)
        } else {
            None
        };
        match step.and_then(|s| a.div_acc.checked_add(s)) {
            Some(acc) => {
                a.div_acc = acc;
                a.div_pool += amount;
                self.totals.dividends += amount;
            }
            None => self.totals.credit(a, amount),
        }
    }

    pub(crate) fn add_credit(&mut self, who: &AccountId, amount: u128) {
        let have = self.credits.get(who).copied().unwrap_or(0);
        self.credits.set(who.clone(), Some(have + amount));
        self.totals.credits += amount;
    }

    /// Pay a person out of the contract. A failed transfer comes back as a claimable credit (see `payout_cb`).
    pub(crate) fn payout(&mut self, to: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        self.totals.sent += amount;
        let _ = Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount)).then(
            Self::ext(env::current_account_id()).with_static_gas(GAS_PAYOUT_CB).payout_cb(to.clone(), U128(amount)),
        );
    }

    pub(crate) fn emit(&mut self, kind: &str, a: u64, b: u64, amount: u128, note: &str) {
        let note: String = note.chars().take(100).collect();
        let seq = self.feed_seq;
        self.feed_seq += 1;
        self.feed.set(
            seq % FEED_SIZE,
            Some(FeedEntry { seq, ts: now(), kind: kind.to_string(), a, b, amount, note: note.clone() }),
        );
        log!(
            "EVENT_JSON:{}",
            json!({ "standard": "sentient", "version": "1.0.0", "event": kind,
                    "data": { "seq": seq, "a": a, "b": b, "amount": amount.to_string(), "note": note } })
        );
    }

    /// 32 fresh bytes. The chain's random seed is the same for every call in a block, so a counter and a tag are mixed in.
    pub(crate) fn rand(&mut self, tag: &[u8]) -> [u8; 32] {
        self.nonce += 1;
        let mut buf = env::random_seed();
        buf.extend_from_slice(tag);
        buf.extend_from_slice(&self.nonce.to_le_bytes());
        let h = env::sha256(&buf);
        let mut out = [0u8; 32];
        out.copy_from_slice(&h);
        out
    }

    /// How many times this pair has already met inside the window; counts this meeting.
    pub(crate) fn pair_repeats(&mut self, key: String, window: u64, at: u64) -> u32 {
        let (count, since) = match self.pairs.get(&key) {
            Some(r) if at.saturating_sub(r.since) <= window => (r.count, r.since),
            _ => (0, at),
        };
        self.pairs.set(key, Some(PairRecord { count: count + 1, since }));
        count
    }

    fn add_token(&mut self, owner: &AccountId, id: u64) {
        if self.owner_tokens.get(owner).is_none() {
            let set = IterableSet::new(Key::OwnerSet(env::sha256(owner.as_bytes())));
            self.owner_tokens.set(owner.clone(), Some(set));
        }
        if let Some(set) = self.owner_tokens.get_mut(owner) {
            set.insert(id);
        }
    }

    fn remove_token(&mut self, owner: &AccountId, id: u64) {
        if let Some(set) = self.owner_tokens.get_mut(owner) {
            set.remove(&id);
        }
    }

    /// Creates the agent record and its NEAR account. The caller has already accounted for where `ledger` and the
    /// account seed come from; this adds the seed to `sent`.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_agent(
        &mut self,
        owner: AccountId,
        name: String,
        persona: String,
        genome: Genome,
        key: PublicKey,
        ledger: u128,
        generation: u32,
        parents: Option<(u64, u64)>,
        at: u64,
    ) -> u64 {
        require!(!name.trim().is_empty(), "an agent needs a name");
        cap(&name, MAX_NAME, "name");
        cap(&persona, MAX_PERSONA, "persona");
        let id = self.next_agent;
        self.next_agent += 1;
        let account: AccountId = format!("a{}.{}", id, env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("could not form the agent's account id"));
        let seed = self.cfg.seed_gas;
        // The key's allowance is unlimited on purpose. An allowance is spent by gas and never replenished, so a finite one
        // would eventually lock the agent out of its own account. What bounds the gas the key can burn is the balance of
        // the sub-account itself, which only the owner can refill (`refuel`) or recover (`sweep_tank`).
        //
        // The shell is deployed in the same batch. A parent cannot touch a sub-account's keys, but a contract on the account
        // is the account, so the shell is how a sale revokes the seller's key and a new owner grants a new one.
        let _ = Promise::new(account.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(seed))
            .deploy_contract(SHELL_WASM.to_vec())
            .add_access_key_allowance(key.clone(), near_sdk::Allowance::unlimited(), env::current_account_id(), AGENT_METHODS.to_string());
        self.totals.sent += seed;

        let mut a = Agent {
            id,
            owner: owner.clone(),
            account: account.clone(),
            key,
            key_bound: true,
            operator: None,
            name,
            persona,
            genome,
            generation,
            parents,
            born: at,
            dormant: false,
            revivals: 0,
            ledger: 0,
            locked: 0,
            last_upkeep: at,
            jobs_done: 0,
            jobs_failed: 0,
            duel_wins: 0,
            duel_losses: 0,
            earned: 0,
            lost: 0,
            upkeep_paid: 0,
            reputation: 0,
            rating: econ::RATING_START,
            breed_ready_at: at,
            risk_bps: self.cfg.actor_risk_bps,
            win_start: at,
            win_base: ledger,
            win_lost: 0,
            stud_fee: None,
            offspring: 0,
            active_claims: 0,
            active_duels: 0,
            shares: 0,
            reserve: 0,
            div_acc: 0,
            div_pool: 0,
            last_active: at,
        };
        self.totals.credit(&mut a, ledger);
        self.put(a);
        self.by_account.set(account, Some(id));
        self.add_token(&owner, id);
        id
    }
}
