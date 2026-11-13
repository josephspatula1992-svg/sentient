//! Shares of an agent, on a linear bonding curve, with a dividend out of what the agent wins.
//!
//! Safeguards, because a curve where early holders profit from later buyers can be an investment product in some
//! jurisdictions: this is a research prototype on testnet and says so; trades carry a fee both ways; a share cannot be sold
//! until `sell_lock_secs` after it was last bought, which stops a buyer from sniping a payout and leaving; and the reserve
//! is exactly the curve's integral, so every sale can always be paid.

use super::*;

pub(crate) fn holding_key(agent: u64, who: &AccountId) -> String {
    format!("{agent}:{who}")
}

/// Bring a holding up to date with the agent's dividend accumulator.
fn settle_holding(a: &Agent, h: &mut Holding) {
    if h.shares > 0 {
        h.pending += h.shares as u128 * (a.div_acc - h.snap) / econ::DIV_PRECISION;
    }
    h.snap = a.div_acc;
}

#[near]
impl Sentient {
    /// Buy `n` shares. Attach the quote (`share_quote`) or more: the excess is refunded, so the deposit is your price cap.
    #[payable]
    pub fn buy_shares(&mut self, agent_id: u64, n: u64) {
        let c = self.cfg.clone();
        require!(n >= 1 && n <= c.max_shares_per_trade, "n is outside the per-trade limit");
        let at = now();
        let deposit = env::attached_deposit().as_yoctonear();
        let buyer = env::predecessor_account_id();
        let mut a = self.agent(agent_id);
        require!(a.shares + n <= MAX_SUPPLY, "that would exceed the share supply cap");
        let cost = econ::buy_cost(c.curve_base, c.curve_slope, a.shares, n);
        let (fee, _) = econ::bps(cost, c.trade_fee_bps);
        let key = holding_key(agent_id, &buyer);
        let existing = self.holdings.get(&key).cloned();
        let storage = if existing.is_none() { c.holding_storage_fee } else { 0 };
        let total = cost + fee + storage;
        require!(deposit >= total, format!("the price is {total} yoctoNEAR, attach at least that"));

        self.totals.received += deposit;
        self.touch(&mut a, at);
        let mut h = existing.unwrap_or_default();
        settle_holding(&a, &mut h);
        h.shares += n;
        h.last_buy = at;
        self.holdings.set(key, Some(h));

        a.shares += n;
        a.reserve += cost;
        self.totals.reserves += cost;
        let (royalty, to_treasury) = econ::bps(fee, c.royalty_bps);
        self.credit_earnings(&mut a, royalty);
        self.totals.treasury += to_treasury + storage;
        let price = c.curve_base + c.curve_slope * a.shares as u128;
        self.put(a);
        if deposit > total {
            self.payout(&buyer, deposit - total);
        }
        self.emit("shares_bought", agent_id, n, total, &format!("price now {price}"));
    }

    /// Sell `n` shares. `min_proceeds` guards against the price moving before your transaction lands.
    pub fn sell_shares(&mut self, agent_id: u64, n: u64, min_proceeds: U128) {
        let c = self.cfg.clone();
        require!(n >= 1, "sell at least one share");
        let at = now();
        let seller = env::predecessor_account_id();
        let key = holding_key(agent_id, &seller);
        let mut h = self.holdings.get(&key).cloned().unwrap_or_else(|| env::panic_str("you hold no shares of this agent"));
        require!(h.shares >= n, "you hold fewer shares than that");
        require!(at >= h.last_buy + c.sell_lock_secs, "shares cannot be sold right after they were bought");
        let mut a = self.agent(agent_id);
        let value = econ::sell_value(c.curve_base, c.curve_slope, a.shares, n);
        let (fee, _) = econ::bps(value, c.trade_fee_bps);
        let proceeds = value - fee;
        require!(proceeds >= min_proceeds.0, "the price moved: proceeds are below your minimum");

        self.touch(&mut a, at);
        settle_holding(&a, &mut h);
        h.shares -= n;
        if h.shares == 0 && h.pending == 0 {
            self.holdings.remove(&key);
        } else {
            self.holdings.set(key, Some(h));
        }
        a.shares -= n;
        a.reserve -= value;
        self.totals.reserves -= value;
        let (royalty, to_treasury) = econ::bps(fee, c.royalty_bps);
        self.credit_earnings(&mut a, royalty);
        self.totals.treasury += to_treasury;
        self.put(a);
        self.payout(&seller, proceeds);
        self.emit("shares_sold", agent_id, n, proceeds, "");
    }

    /// Withdraw the dividends your shares have earned.
    pub fn claim_dividends(&mut self, agent_id: u64) {
        let holder = env::predecessor_account_id();
        let key = holding_key(agent_id, &holder);
        let mut h = self.holdings.get(&key).cloned().unwrap_or_else(|| env::panic_str("you hold no shares of this agent"));
        let mut a = self.agent(agent_id);
        settle_holding(&a, &mut h);
        let amount = h.pending;
        require!(amount > 0, "no dividends to claim");
        h.pending = 0;
        a.div_pool -= amount;
        self.totals.dividends -= amount;
        if h.shares == 0 {
            self.holdings.remove(&key);
        } else {
            self.holdings.set(key, Some(h));
        }
        self.put(a);
        self.payout(&holder, amount);
        self.emit("dividends_claimed", agent_id, 0, amount, "");
    }
}

impl Sentient {
    pub(crate) fn pending_dividends(&self, agent_id: u64, who: &AccountId) -> u128 {
        let (Some(a), Some(h)) = (self.agents.get(&agent_id), self.holdings.get(&holding_key(agent_id, who))) else {
            return 0;
        };
        let mut h = h.clone();
        settle_holding(a, &mut h);
        h.pending
    }
}
