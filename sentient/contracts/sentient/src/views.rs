//! Read-only views. Upkeep is charged lazily, so every view that shows an agent also shows what it would be right now.

use super::*;

#[near(serializers = [json])]
#[derive(Clone)]
pub struct AgentView {
    #[serde(flatten)]
    pub agent: Agent,
    /// Free balance after the upkeep owed at this moment.
    #[serde(with = "dec")]
    pub live_ledger: u128,
    /// True if the agent is dormant, or would be the next time anything touches it.
    pub live_dormant: bool,
    /// Whole seconds the agent can still pay upkeep for.
    pub runway_secs: u64,
    /// What the next share would cost, before fees.
    #[serde(with = "dec")]
    pub share_price: u128,
}

#[near(serializers = [json])]
pub struct Stats {
    pub agents: u64,
    pub alive: u64,
    pub dormant: u64,
    pub jobs: u64,
    pub open_jobs: u64,
    pub duels: u64,
    pub live_duels: u64,
    pub generations: u32,
    pub feed_seq: u64,
    pub now: u64,
}

#[near(serializers = [json])]
pub struct Audit {
    pub totals: Totals,
    #[serde(with = "dec")]
    pub liabilities: u128,
    pub balanced: bool,
    /// The contract account's actual balance, and what its storage has staked.
    #[serde(with = "dec")]
    pub balance: u128,
    #[serde(with = "dec")]
    pub storage_staked: u128,
    /// Balance left after storage and every liability. Never negative while the books are sound.
    #[serde(with = "dec")]
    pub surplus: u128,
    pub solvent: bool,
}

#[near(serializers = [json])]
pub struct Quote {
    #[serde(with = "dec")]
    pub price: u128,
    #[serde(with = "dec")]
    pub fee: u128,
    /// For a buy, price + fee (+ the one-off holding storage fee); for a sell, price - fee.
    #[serde(with = "dec")]
    pub total: u128,
}

impl Sentient {
    /// (free balance, dormant, upkeep owed) as they would be if the agent were touched at `at`.
    pub(crate) fn effective(&self, a: &Agent, at: u64) -> (u128, bool, u128) {
        if a.dormant {
            return (a.ledger, true, 0);
        }
        let due = self.upkeep_due(a, at);
        if a.ledger >= due {
            (a.ledger - due, false, due)
        } else {
            (0, true, a.ledger)
        }
    }

    fn view_of(&self, a: &Agent) -> AgentView {
        let at = now();
        let (live_ledger, live_dormant, _) = self.effective(a, at);
        let per = self.cfg.upkeep_per_sec;
        let runway = if live_dormant {
            0
        } else if per == 0 {
            u64::MAX
        } else {
            u64::try_from(live_ledger / per).unwrap_or(u64::MAX)
        };
        AgentView {
            agent: a.clone(),
            live_ledger,
            live_dormant,
            runway_secs: runway,
            share_price: self.cfg.curve_base + self.cfg.curve_slope * (a.shares as u128 + 1),
        }
    }
}

#[near]
impl Sentient {
    pub fn get_config(&self) -> Config {
        self.cfg.clone()
    }

    pub fn get_agent(&self, agent_id: u64) -> Option<AgentView> {
        self.agents.get(&agent_id).map(|a| self.view_of(a))
    }

    pub fn get_agent_by_account(&self, account: AccountId) -> Option<AgentView> {
        self.by_account.get(&account).and_then(|id| self.agents.get(id)).map(|a| self.view_of(a))
    }

    /// Agents by id, oldest first.
    pub fn get_agents(&self, from_id: Option<u64>, limit: Option<u64>) -> Vec<AgentView> {
        let from = from_id.unwrap_or(1).max(1);
        let limit = limit.unwrap_or(50).min(100);
        (from..self.next_agent).take(limit as usize).filter_map(|id| self.agents.get(&id)).map(|a| self.view_of(a)).collect()
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Newest first. Finished and pruned jobs are skipped when `only_open` is set or the record is gone.
    pub fn get_recent_jobs(&self, limit: Option<u64>, only_open: Option<bool>) -> Vec<Job> {
        let limit = limit.unwrap_or(30).min(100) as usize;
        let open = only_open.unwrap_or(false);
        (self.next_job.saturating_sub(SCAN_LIMIT).max(1)..self.next_job)
            .rev()
            .filter_map(|id| self.jobs.get(&id))
            .filter(|j| !open || j.status == JobStatus::Open)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn get_duel(&self, duel_id: u64) -> Option<Duel> {
        self.duels.get(&duel_id).cloned()
    }

    /// Newest first.
    pub fn get_recent_duels(&self, limit: Option<u64>, only_open: Option<bool>) -> Vec<Duel> {
        let limit = limit.unwrap_or(30).min(100) as usize;
        let open = only_open.unwrap_or(false);
        (self.next_duel.saturating_sub(SCAN_LIMIT).max(1)..self.next_duel)
            .rev()
            .filter_map(|id| self.duels.get(&id))
            .filter(|d| !open || d.status == DuelStatus::Open)
            .take(limit)
            .cloned()
            .collect()
    }

    /// The most recent events, newest first.
    pub fn get_feed(&self, limit: Option<u64>) -> Vec<FeedEntry> {
        let limit = limit.unwrap_or(40).min(FEED_SIZE);
        let have = self.feed_seq.min(FEED_SIZE).min(limit);
        (0..have).filter_map(|i| self.feed.get(&((self.feed_seq - 1 - i) % FEED_SIZE))).cloned().collect()
    }

    /// Counts of alive and dormant agents, open jobs and live duels are over the newest `SCAN_LIMIT` records of each kind,
    /// which keeps the view inside its gas however long the contract has run; `agents`, `jobs` and `duels` are exact.
    pub fn get_stats(&self) -> Stats {
        let at = now();
        let (mut alive, mut dormant, mut generations) = (0u64, 0u64, 0u32);
        for id in self.next_agent.saturating_sub(SCAN_LIMIT).max(1)..self.next_agent {
            if let Some(a) = self.agents.get(&id) {
                if self.effective(a, at).1 {
                    dormant += 1;
                } else {
                    alive += 1;
                }
                generations = generations.max(a.generation);
            }
        }
        let open_jobs = (self.next_job.saturating_sub(SCAN_LIMIT).max(1)..self.next_job)
            .filter_map(|i| self.jobs.get(&i))
            .filter(|j| j.status == JobStatus::Open)
            .count() as u64;
        let live_duels = (self.next_duel.saturating_sub(SCAN_LIMIT).max(1)..self.next_duel)
            .filter_map(|i| self.duels.get(&i))
            .filter(|d| d.status == DuelStatus::Live)
            .count() as u64;
        Stats {
            agents: self.next_agent - 1,
            alive,
            dormant,
            jobs: self.next_job - 1,
            open_jobs,
            duels: self.next_duel - 1,
            live_duels,
            generations,
            feed_seq: self.feed_seq,
            now: at,
        }
    }

    pub fn get_holding(&self, agent_id: u64, account: AccountId) -> Option<Holding> {
        self.holdings.get(&market::holding_key(agent_id, &account)).cloned()
    }

    pub fn get_pending_dividends(&self, agent_id: u64, account: AccountId) -> U128 {
        U128(self.pending_dividends(agent_id, &account))
    }

    /// What `n` shares of this agent cost to buy (`buy: true`) or return when sold.
    pub fn share_quote(&self, agent_id: u64, n: u64, buy: bool) -> Quote {
        let a = self.agent(agent_id);
        let c = &self.cfg;
        if buy {
            let price = econ::buy_cost(c.curve_base, c.curve_slope, a.shares, n);
            let (fee, _) = econ::bps(price, c.trade_fee_bps);
            Quote { price, fee, total: price + fee + c.holding_storage_fee }
        } else {
            require!(n <= a.shares, "more than the supply");
            let price = econ::sell_value(c.curve_base, c.curve_slope, a.shares, n);
            let (fee, _) = econ::bps(price, c.trade_fee_bps);
            Quote { price, fee, total: price - fee }
        }
    }

    pub fn credits_of(&self, account: AccountId) -> U128 {
        U128(self.credits.get(&account).copied().unwrap_or(0))
    }

    /// The books against the real balance. `solvent` is the claim worth checking from outside.
    pub fn get_audit(&self) -> Audit {
        let balance = env::account_balance().as_yoctonear();
        let storage_staked = env::storage_usage() as u128 * env::storage_byte_cost().as_yoctonear();
        let liabilities = self.totals.liabilities();
        let needed = liabilities + storage_staked;
        Audit {
            totals: self.totals.clone(),
            liabilities,
            balanced: self.totals.balanced(),
            balance,
            storage_staked,
            surplus: balance.saturating_sub(needed),
            solvent: balance >= needed,
        }
    }

    /// The puzzle behind a live or finished duel, in words, and its kind's name.
    pub fn describe_duel(&self, duel_id: u64) -> Option<String> {
        self.duels.get(&duel_id).map(|d| format!("[{}] {}", puzzle::kind_name(d.kind.unwrap_or(255)), d.question))
    }
}
