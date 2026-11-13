//! Birth, upkeep, death, revival and breeding.

use super::*;

#[near]
impl Sentient {
    /// Mint an agent. The attached deposit becomes: a protocol fee, a seed for the agent's own account (its gas and
    /// storage), a storage fee, and the rest as the agent's starting balance. `genome` is chosen by the minter within
    /// the point budget, or left out to be drawn at random.
    #[payable]
    pub fn mint(&mut self, name: String, persona: String, genome: Option<Genome>, runtime_key: PublicKey) -> u64 {
        let deposit = env::attached_deposit().as_yoctonear();
        let c = self.cfg.clone();
        require!(deposit >= c.mint_min, format!("minting needs at least {} yoctoNEAR attached", c.mint_min));
        let (fee, _) = econ::bps(deposit, c.mint_fee_bps);
        let spent = fee + c.seed_gas + c.storage_fee;
        require!(deposit >= spent + c.min_ledger, "not enough left for the agent to live on");
        let ledger = deposit - spent;
        let g = match genome {
            Some(g) => {
                if let Err(e) = g.check() {
                    env::panic_str(e);
                }
                g
            }
            None => {
                let r = self.rand(b"mint");
                genome::random_genome(&r)
            }
        };
        let owner = env::predecessor_account_id();
        self.totals.received += deposit;
        self.totals.treasury += fee + c.storage_fee;
        let at = now();
        let id = self.create_agent(owner.clone(), name.clone(), persona, g, runtime_key, ledger, 0, None, at);
        self.nft_log("nft_mint", json!([{ "owner_id": owner, "token_ids": [id.to_string()] }]));
        self.emit("minted", id, 0, ledger, &name);
        id
    }

    /// Anyone can add to an agent's balance, and this is also how a dormant agent wakes: once its free balance (after
    /// settling the upkeep it owes) reaches `revive_min`, it is alive again. Waking an agent that already has the money,
    /// without attaching any, is for its owner or operator: otherwise a stranger could restart the rent of an agent its owner
    /// had parked, at the owner's expense.
    #[payable]
    pub fn revive(&mut self, agent_id: u64) {
        let deposit = env::attached_deposit().as_yoctonear();
        let at = now();
        let mut a = self.agent(agent_id);
        if deposit == 0 {
            require!(
                self.controls(&env::predecessor_account_id(), &a),
                "waking an agent without funding it is for its owner or operator"
            );
        }
        self.totals.received += deposit;
        self.touch(&mut a, at);
        self.totals.credit(&mut a, deposit);
        if a.dormant && a.ledger >= self.cfg.revive_min {
            a.dormant = false;
            a.last_upkeep = at;
            a.revivals += 1;
            self.emit("revived", agent_id, 0, a.ledger, "");
        } else if deposit > 0 {
            self.emit("funded", agent_id, 0, deposit, "");
        }
        self.put(a);
    }

    /// Realise upkeep so an agent that has run out is recorded as dormant. Anyone may call it.
    pub fn poke(&mut self, agent_id: u64) {
        let at = now();
        let mut a = self.agent(agent_id);
        self.touch(&mut a, at);
        self.put(a);
    }

    /// The owner takes free balance out. Held money (bonds and stakes) stays until it is released.
    pub fn withdraw(&mut self, agent_id: u64, amount: U128) {
        let at = now();
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        self.touch(&mut a, at);
        require!(amount.0 > 0 && amount.0 <= a.ledger, "more than the agent's free balance");
        self.totals.debit(&mut a, amount.0);
        let owner = a.owner.clone();
        self.put(a);
        self.payout(&owner, amount.0);
        self.emit("withdrawn", agent_id, 0, amount.0, "");
    }

    /// Move free balance into the agent's own account, which pays the gas of the agent's calls. Only the owner may: the
    /// agent's key must not (a compromised runtime could pour the whole ledger into gas and burn it) and neither may an
    /// operator (money in that account can only be burned, never taken back out, so a delegate could destroy the owner's
    /// money). Anyone can also top the account up by plain transfer.
    pub fn refuel(&mut self, agent_id: u64, amount: U128) {
        let at = now();
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        self.touch(&mut a, at);
        require!(amount.0 > 0 && amount.0 <= a.ledger, "more than the agent's free balance");
        self.totals.debit(&mut a, amount.0);
        let account = a.account.clone();
        self.put(a);
        self.payout(&account, amount.0);
        self.emit("refueled", agent_id, 0, amount.0, "");
    }

    /// Set how much of this agent's balance anyone but the owner can put at risk per window (0 to 10,000 basis points).
    /// The owner is never limited. Lower it for an agent whose runtime or operator you trust less.
    pub fn set_risk_bps(&mut self, agent_id: u64, bps: u16) {
        require!(bps <= 10_000, "at most 10,000 basis points");
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        a.risk_bps = bps;
        self.put(a);
    }

    /// Give the agent a new voice: delete its current key (if the contract still honours one) and add this one, through the
    /// shell on the agent's own account. After a sale this is how the new owner gets an agent that signs for itself.
    pub fn set_runtime_key(&mut self, agent_id: u64, key: PublicKey) {
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        require!(key != a.key || !a.key_bound, "that is already the agent's key");
        // Two independent receipts, not one batch: if the old key is already gone (an earlier grant failed, say), the revoke
        // fails, and in a batch that would abort the grant too and leave the owner unable to ever re-key the agent.
        if a.key_bound {
            let _ = self.shell_revoke(&a.account, &a.key);
        }
        let _ = self.shell_grant(Promise::new(a.account.clone()), &key);
        a.key = key;
        a.key_bound = true;
        self.put(a);
        self.emit("rekeyed", agent_id, 0, 0, "");
    }

    /// Send the agent's spare gas back to its owner: everything in its account above its storage stake and `keep`. The
    /// balance that pays an agent's gas is not a one-way trip.
    pub fn sweep_tank(&mut self, agent_id: u64, keep: U128) {
        let a = self.agent(agent_id);
        self.require_owner(&a);
        let mut args = keep.0.to_le_bytes().to_vec();
        args.extend_from_slice(a.owner.as_str().as_bytes());
        let _ = Promise::new(a.account.clone()).function_call("sweep".to_string(), args, NearToken::from_yoctonear(0), GAS_SHELL);
        self.emit("tank_swept", agent_id, 0, 0, "");
    }

    /// Let an account act for the agent (or clear it). After a sale, this is how a new keeper takes over.
    pub fn set_operator(&mut self, agent_id: u64, operator: Option<AccountId>) {
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        a.operator = operator;
        self.put(a);
    }

    /// Offer this agent as a parent to other owners for a fee, or withdraw the offer.
    pub fn set_stud_fee(&mut self, agent_id: u64, fee: Option<U128>) {
        let mut a = self.agent(agent_id);
        self.require_owner(&a);
        a.stud_fee = fee.map(|f| f.0);
        self.put(a);
    }

    /// Breed `parent_a` (yours) with `parent_b` (yours, or one offered for a fee). Each parent pays half of
    /// `breed_cost` from its free balance; the child gets a crossover of their genomes, one trait at a time, with a
    /// little mutation, and starts with what the cost leaves after its account seed and storage. Both parents must be
    /// alive, past their cooldown and proven (a job done or a duel won). The child belongs to the caller.
    #[payable]
    pub fn breed(&mut self, parent_a: u64, parent_b: u64, name: String, persona: String, runtime_key: PublicKey) -> u64 {
        let at = now();
        let c = self.cfg.clone();
        let deposit = env::attached_deposit().as_yoctonear();
        let caller = env::predecessor_account_id();
        require!(parent_a != parent_b, "an agent cannot breed with itself");
        let mut a = self.agent(parent_a);
        let mut b = self.agent(parent_b);
        require!(a.owner == caller, "you must own parent_a");
        self.require_alive(&a, at);
        self.require_alive(&b, at);
        for p in [&a, &b] {
            require!(at >= p.breed_ready_at, "a parent is still recovering from its last litter");
            require!(p.jobs_done + p.duel_wins > 0, "a parent has not yet proved itself with a job done or a duel won");
        }
        let fee = if b.owner == caller {
            0
        } else {
            b.stud_fee.unwrap_or_else(|| env::panic_str("parent_b is not offered for breeding"))
        };
        require!(deposit >= fee, "attach at least the stud fee");

        self.totals.received += deposit;
        self.touch(&mut a, at);
        self.touch(&mut b, at);
        let (half_a, half_b) = (c.breed_cost - c.breed_cost / 2, c.breed_cost / 2);
        require!(a.ledger >= half_a && b.ledger >= half_b, "a parent cannot afford its half of the breeding cost");
        self.totals.debit(&mut a, half_a);
        self.totals.debit(&mut b, half_b);
        let child_ledger = c.breed_cost - c.seed_gas - c.storage_fee;
        self.totals.treasury += c.storage_fee;

        if fee > 0 {
            let (div, keep) = econ::bps(fee, c.dividend_bps);
            self.pay_dividend(&mut b, div);
            self.credit_earnings(&mut b, keep);
            b.earned += div;
        }
        let refund = deposit - fee;
        a.breed_ready_at = at + c.breed_cooldown_secs;
        b.breed_ready_at = at + c.breed_cooldown_secs;
        a.offspring += 1;
        b.offspring += 1;
        let generation = a.generation.max(b.generation) + 1;
        let r = self.rand(b"breed");
        let child_genome = genome::crossover(&a.genome, &b.genome, &r);
        self.put(a);
        self.put(b);
        if refund > 0 {
            self.payout(&caller, refund);
        }
        let id = self.create_agent(
            caller.clone(),
            name.clone(),
            persona,
            child_genome,
            runtime_key,
            child_ledger,
            generation,
            Some((parent_a, parent_b)),
            at,
        );
        self.nft_log("nft_mint", json!([{ "owner_id": caller, "token_ids": [id.to_string()] }]));
        self.emit("born", id, parent_a, child_ledger, &format!("{name} (gen {generation}) of #{parent_a} x #{parent_b}"));
        id
    }
}
