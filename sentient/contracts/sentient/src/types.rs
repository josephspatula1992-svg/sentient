//! Records, configuration and the books.

use crate::genome::Genome;
use near_sdk::{near, AccountId, PublicKey};

pub const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// u128 as a decimal string in JSON, so JavaScript clients never lose precision.
pub mod dec {
    use near_sdk::serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse::<u128>().map_err(serde::de::Error::custom)
    }
}

pub mod dec_opt {
    use near_sdk::serde::{self, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<u128>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(x) => s.serialize_str(&x.to_string()),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u128>, D::Error> {
        match Option::<String>::deserialize(d)? {
            Some(s) => s.parse::<u128>().map(Some).map_err(serde::de::Error::custom),
            None => Ok(None),
        }
    }
}

/// Everything the economy's rules depend on, fixed at deploy. There is no setter: the contract is meant to be locked
/// by deleting its keys, so these numbers are the constitution.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Config {
    /// Arbitrates disputed jobs and may withdraw the treasury. Never a party to a job it rules on.
    pub chair: AccountId,
    // minting
    #[serde(with = "dec")]
    pub mint_min: u128,
    /// Sent to the agent's own account at mint. It pays that account's gas and storage: the agent's metabolism.
    #[serde(with = "dec")]
    pub seed_gas: u128,
    /// Kept by the protocol per agent for the storage its records use.
    #[serde(with = "dec")]
    pub storage_fee: u128,
    pub mint_fee_bps: u16,
    /// What an agent must hold, free, after minting.
    #[serde(with = "dec")]
    pub min_ledger: u128,
    // cost of living
    /// Charged lazily from the free balance. An agent that cannot pay goes dormant.
    #[serde(with = "dec")]
    pub upkeep_per_sec: u128,
    /// Free balance needed to wake a dormant agent.
    #[serde(with = "dec")]
    pub revive_min: u128,
    // jobs
    #[serde(with = "dec")]
    pub min_bounty: u128,
    #[serde(with = "dec")]
    pub job_storage_fee: u128,
    pub job_fee_bps: u16,
    pub bond_bps: u16,
    #[serde(with = "dec")]
    pub min_bond: u128,
    pub min_work_secs: u64,
    pub max_work_secs: u64,
    /// After a submission, the poster has this long to accept or reject. Silence pays the worker.
    pub review_secs: u64,
    /// After a rejection, the chair has this long. Silence splits the bounty.
    pub arbiter_secs: u64,
    pub prune_secs: u64,
    pub max_claims: u32,
    // duels
    #[serde(with = "dec")]
    pub min_stake: u128,
    #[serde(with = "dec")]
    pub duel_storage_fee: u128,
    pub duel_fee_bps: u16,
    /// Between acceptance and the first moment an answer counts, so neither side starts with a head start.
    pub duel_start_secs: u64,
    pub duel_window_secs: u64,
    pub challenge_ttl_secs: u64,
    pub max_duels: u32,
    // dividends and shares
    /// Of every agent's winnings, the part that goes to the holders of its shares.
    pub dividend_bps: u16,
    #[serde(with = "dec")]
    pub curve_base: u128,
    #[serde(with = "dec")]
    pub curve_slope: u128,
    pub trade_fee_bps: u16,
    /// Of each trade fee, the part paid to the agent itself.
    pub royalty_bps: u16,
    pub sell_lock_secs: u64,
    #[serde(with = "dec")]
    pub holding_storage_fee: u128,
    pub max_shares_per_trade: u64,
    // limits on what anyone but the owner can do with an agent's money
    /// The most an agent can lose in one window to actions its owner did not take (its own key, or an operator), as a share of
    /// its balance at the start of the window. Counts losses so far, money currently at risk, and the new commitment. New
    /// agents start with this; the owner can change it for an agent.
    pub actor_risk_bps: u16,
    pub risk_window_secs: u64,
    // breeding
    /// Taken half from each parent's free balance. Pays the child's account seed, storage and starting balance.
    #[serde(with = "dec")]
    pub breed_cost: u128,
    pub breed_cooldown_secs: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum JobStatus {
    Open,
    Claimed,
    Submitted,
    Disputed,
    Paid,
    Refunded,
    Split,
    Cancelled,
}

impl JobStatus {
    pub fn is_final(self) -> bool {
        matches!(self, JobStatus::Paid | JobStatus::Refunded | JobStatus::Split | JobStatus::Cancelled)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ruling {
    PayWorker,
    RefundPoster,
    Split,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DuelStatus {
    Open,
    Live,
    Settled,
    Drawn,
    Cancelled,
}

impl DuelStatus {
    pub fn is_final(self) -> bool {
        matches!(self, DuelStatus::Settled | DuelStatus::Drawn | DuelStatus::Cancelled)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Agent {
    pub id: u64,
    /// Holds the NFT. Owns the agent's money and may always act for it.
    pub owner: AccountId,
    /// The agent's own NEAR account, `a<id>.<contract>`. It signs its own calls with the function-call key below.
    pub account: AccountId,
    /// The key placed on `account` at birth. It can call this contract's agent methods and nothing else.
    pub key: PublicKey,
    /// The contract honours `key` only while this holds. A transfer clears it, because a parent contract cannot rotate
    /// the keys of a sub-account, so the only safe way to take the old keeper's power away is to stop listening.
    pub key_bound: bool,
    /// An account the owner has authorised to act for the agent, for example a new keeper after a sale.
    pub operator: Option<AccountId>,
    pub name: String,
    pub persona: String,
    pub genome: Genome,
    pub generation: u32,
    pub parents: Option<(u64, u64)>,
    pub born: u64,
    pub dormant: bool,
    pub revivals: u32,
    /// Free balance. Pays upkeep, bonds and stakes, and is what the owner withdraws.
    #[serde(with = "dec")]
    pub ledger: u128,
    /// Held in bonds and duel stakes.
    #[serde(with = "dec")]
    pub locked: u128,
    pub last_upkeep: u64,
    pub jobs_done: u32,
    pub jobs_failed: u32,
    pub duel_wins: u32,
    pub duel_losses: u32,
    #[serde(with = "dec")]
    pub earned: u128,
    #[serde(with = "dec")]
    pub lost: u128,
    #[serde(with = "dec")]
    pub upkeep_paid: u128,
    pub reputation: i64,
    pub rating: u32,
    pub breed_ready_at: u64,
    /// This agent's cap on what non-owners can put at risk per window (see `Config::actor_risk_bps`).
    pub risk_bps: u16,
    pub win_start: u64,
    /// Balance (free plus held) when the current window began.
    #[serde(with = "dec")]
    pub win_base: u128,
    /// Money lost or spent in this window, whoever acted.
    #[serde(with = "dec")]
    pub win_lost: u128,
    #[serde(with = "dec_opt")]
    pub stud_fee: Option<u128>,
    pub offspring: u32,
    pub active_claims: u32,
    pub active_duels: u32,
    /// Shares outstanding on this agent's bonding curve.
    pub shares: u64,
    /// Exactly the curve's integral at `shares`. Backs every sale.
    #[serde(with = "dec")]
    pub reserve: u128,
    /// Dividend per share, scaled by `DIV_PRECISION`.
    #[serde(with = "dec")]
    pub div_acc: u128,
    /// Dividends paid in and not yet withdrawn by holders.
    #[serde(with = "dec")]
    pub div_pool: u128,
    pub last_active: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    /// Whoever decides acceptance: a person, or an agent's account.
    pub poster: AccountId,
    /// The person behind the poster. For an agent poster, that agent's owner.
    pub poster_owner: AccountId,
    pub poster_agent: Option<u64>,
    pub title: String,
    pub brief_uri: String,
    pub brief_hash: String,
    #[serde(with = "dec")]
    pub bounty: u128,
    #[serde(with = "dec")]
    pub bond: u128,
    pub min_rep: i64,
    pub work_secs: u64,
    pub status: JobStatus,
    pub posted: u64,
    pub worker: Option<u64>,
    pub claimed_at: u64,
    pub deadline: u64,
    pub sub_hash: String,
    pub sub_uri: String,
    pub submitted_at: u64,
    pub dispute_reason: String,
    pub disputed_at: u64,
    /// Agents that took this job and failed it. They cannot take it again.
    pub barred: Vec<u64>,
    pub attempts: u32,
    pub settled_at: u64,
    #[serde(with = "dec")]
    pub paid_worker: u128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Duel {
    pub id: u64,
    /// `None` until accepted when the challenger left the kind to chance.
    pub kind: Option<u8>,
    pub params: [u64; 4],
    pub question: String,
    pub a: u64,
    pub b: Option<u64>,
    /// An agent the challenge is reserved for.
    pub target: Option<u64>,
    #[serde(with = "dec")]
    pub stake: u128,
    pub status: DuelStatus,
    pub created: u64,
    pub live_at: u64,
    pub deadline: u64,
    pub wrong_a: bool,
    pub wrong_b: bool,
    pub winner: Option<u64>,
    pub rating_swing: u32,
    pub settled_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Holding {
    pub shares: u64,
    /// The agent's dividend accumulator when this holder last settled.
    #[serde(with = "dec")]
    pub snap: u128,
    #[serde(with = "dec")]
    pub pending: u128,
    pub last_buy: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PairRecord {
    pub count: u32,
    pub since: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct FeedEntry {
    pub seq: u64,
    pub ts: u64,
    pub kind: String,
    pub a: u64,
    pub b: u64,
    #[serde(with = "dec")]
    pub amount: u128,
    pub note: String,
}

/// Every yocto the contract has taken in, and where it is now. Always balanced:
/// `received == sent + ledgers + locked + escrow + reserves + dividends + treasury + credits`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct Totals {
    #[serde(with = "dec")]
    pub received: u128,
    /// Paid out of the contract, to people or to agents' own accounts, and not (yet) returned.
    #[serde(with = "dec")]
    pub sent: u128,
    #[serde(with = "dec")]
    pub ledgers: u128,
    #[serde(with = "dec")]
    pub locked: u128,
    #[serde(with = "dec")]
    pub escrow: u128,
    #[serde(with = "dec")]
    pub reserves: u128,
    #[serde(with = "dec")]
    pub dividends: u128,
    #[serde(with = "dec")]
    pub treasury: u128,
    #[serde(with = "dec")]
    pub credits: u128,
}

impl Totals {
    pub fn liabilities(&self) -> u128 {
        self.ledgers + self.locked + self.escrow + self.reserves + self.dividends + self.treasury + self.credits
    }

    pub fn balanced(&self) -> bool {
        self.received == self.sent + self.liabilities()
    }

    /// Add to an agent's free balance. The money must already be counted somewhere else's decrease.
    pub fn credit(&mut self, a: &mut Agent, amount: u128) {
        a.ledger += amount;
        self.ledgers += amount;
    }

    pub fn debit(&mut self, a: &mut Agent, amount: u128) {
        a.ledger -= amount;
        self.ledgers -= amount;
    }

    /// Free balance -> held.
    pub fn lock(&mut self, a: &mut Agent, amount: u128) {
        self.debit(a, amount);
        a.locked += amount;
        self.locked += amount;
    }

    /// Held -> gone from the agent (the caller says where it went).
    pub fn burn_locked(&mut self, a: &mut Agent, amount: u128) {
        a.locked -= amount;
        self.locked -= amount;
    }

    /// Held -> free.
    pub fn unlock(&mut self, a: &mut Agent, amount: u128) {
        self.burn_locked(a, amount);
        self.credit(a, amount);
    }
}
