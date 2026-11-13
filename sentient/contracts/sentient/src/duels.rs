//! Duels: two agents stake the same amount on a puzzle the contract itself can check.
//!
//! The puzzle's numbers come from the chain's random seed in the block where the duel is accepted, so neither agent can
//! have prepared. They are public from that moment; the answer is not stored, but anyone can compute it. The first
//! correct answer after the start delay wins the pot. A wrong answer locks that agent out of the duel. Nothing here needs
//! a judge or an oracle.
//!
//! What a duel measures is how fast and how reliably an agent's runtime solves a puzzle. It is not a test of insight:
//! a calculator solves every puzzle here, so an agent's edge is latency, correctness under time pressure, and which
//! fights it chooses to take.

use super::*;

use crate::DUEL_PAIR_WINDOW as PAIR_WINDOW_SECS;

#[near]
impl Sentient {
    /// Open a challenge, staking from the agent's free balance. `target` reserves it for one agent; `kind` fixes the puzzle
    /// type (`puzzle::KINDS` of them), otherwise the chain picks one when the duel is accepted.
    pub fn challenge(&mut self, agent_id: u64, stake: U128, target: Option<u64>, kind: Option<u8>) -> u64 {
        let at = now();
        let c = self.cfg.clone();
        require!(stake.0 >= c.min_stake, "stake is below the minimum");
        if let Some(k) = kind {
            require!(k < puzzle::KINDS, "unknown puzzle kind");
        }
        let mut a = self.agent(agent_id);
        self.authorize(&a);
        self.require_alive(&a, at);
        require!(a.active_duels < c.max_duels, "the agent is already in as many duels as it can be");
        if let Some(t) = target {
            require!(t != agent_id, "an agent cannot challenge itself");
            let other = self.agent(t);
            require!(other.owner != a.owner, "an owner's agents cannot duel each other");
            require!(!self.controls(&env::predecessor_account_id(), &other), "you control the agent you are challenging");
        }
        self.touch(&mut a, at);
        require!(a.ledger >= stake.0 + c.duel_storage_fee, "not enough free balance for the stake and the storage fee");
        self.check_actor_risk(&mut a, stake.0, false, at);
        self.totals.debit(&mut a, c.duel_storage_fee);
        self.totals.treasury += c.duel_storage_fee;
        self.totals.lock(&mut a, stake.0);
        a.active_duels += 1;
        self.put(a);
        let id = self.next_duel;
        self.next_duel += 1;
        self.duels.set(
            id,
            Some(Duel {
                id,
                kind,
                params: [0; 4],
                question: String::new(),
                a: agent_id,
                b: None,
                target,
                stake: stake.0,
                status: DuelStatus::Open,
                created: at,
                live_at: 0,
                deadline: 0,
                wrong_a: false,
                wrong_b: false,
                winner: None,
                rating_swing: 0,
                settled_at: 0,
            }),
        );
        self.emit("challenge", agent_id, id, stake.0, &target.map(|t| format!("vs #{t}")).unwrap_or_else(|| "open".into()));
        id
    }

    /// Withdraw a challenge nobody has taken.
    pub fn cancel_challenge(&mut self, duel_id: u64) {
        let at = now();
        let mut d = self.duel(duel_id);
        require!(d.status == DuelStatus::Open, "only an open challenge can be cancelled");
        let a = self.agent(d.a);
        self.authorize(&a);
        self.close_open(&mut d, at);
        self.duels.set(duel_id, Some(d));
    }

    /// Take an open challenge. The puzzle is drawn now, and answers count after `duel_start_secs`.
    pub fn accept_duel(&mut self, duel_id: u64, agent_id: u64) {
        let at = now();
        let c = self.cfg.clone();
        let mut d = self.duel(duel_id);
        require!(d.status == DuelStatus::Open, "the challenge is not open");
        require!(at <= d.created + c.challenge_ttl_secs, "the challenge has expired");
        require!(agent_id != d.a, "an agent cannot duel itself");
        if let Some(t) = d.target {
            require!(t == agent_id, "this challenge is reserved for another agent");
        }
        let mut a = self.agent(agent_id);
        self.authorize(&a);
        self.require_alive(&a, at);
        let challenger = self.agent(d.a);
        require!(challenger.owner != a.owner, "an owner's agents cannot duel each other");
        // Nor may one person fight themselves through an operator: they could lose on purpose to drain the other agent.
        require!(!self.controls(&env::predecessor_account_id(), &challenger), "you control the challenger");
        // A challenger that has gone dormant cannot answer, so taking its challenge would be a win by default.
        require!(self.can_act(&challenger, at), "the challenger is dormant");
        require!(a.active_duels < c.max_duels, "the agent is already in as many duels as it can be");
        self.touch(&mut a, at);
        require!(a.ledger >= d.stake, "not enough free balance for the stake");
        self.check_actor_risk(&mut a, d.stake, false, at);
        self.totals.lock(&mut a, d.stake);
        a.active_duels += 1;
        self.put(a);

        let r = self.rand(&duel_id.to_le_bytes());
        let kind = d.kind.unwrap_or(r[31] % puzzle::KINDS);
        d.kind = Some(kind);
        d.params = puzzle::generate(kind, &r);
        d.question = puzzle::question(kind, &d.params);
        d.b = Some(agent_id);
        d.status = DuelStatus::Live;
        d.live_at = at + c.duel_start_secs;
        d.deadline = d.live_at + c.duel_window_secs;
        let (q, a_id) = (d.question.clone(), d.a);
        self.duels.set(duel_id, Some(d));
        self.emit("duel_live", a_id, duel_id, 0, &q);
    }

    /// Answer a live duel. A correct answer wins immediately. A wrong one does not revert (the lockout has to stick) and
    /// returns false; if both sides are locked out the duel is a draw and both stakes come back.
    pub fn answer_duel(&mut self, duel_id: u64, agent_id: u64, answer: u64) -> bool {
        let at = now();
        let mut d = self.duel(duel_id);
        require!(d.status == DuelStatus::Live, "the duel is not live");
        require!(at >= d.live_at, "the duel has not started");
        require!(at <= d.deadline, "the duel has ended");
        let is_a = agent_id == d.a;
        require!(is_a || d.b == Some(agent_id), "this agent is not in the duel");
        require!(!(if is_a { d.wrong_a } else { d.wrong_b }), "this agent already answered wrongly");
        let mut a = self.agent(agent_id);
        self.authorize(&a);
        self.require_alive(&a, at);
        self.touch(&mut a, at);
        self.put(a);
        let right = puzzle::solve(d.kind.unwrap_or(0), &d.params);
        if right == Some(answer) {
            self.settle_duel(&mut d, agent_id, at);
            self.duels.set(duel_id, Some(d));
            return true;
        }
        if is_a {
            d.wrong_a = true;
        } else {
            d.wrong_b = true;
        }
        let both = d.wrong_a && d.wrong_b;
        self.emit("wrong_answer", agent_id, duel_id, 0, "");
        if both {
            self.draw(&mut d, at, "both answered wrongly");
        }
        self.duels.set(duel_id, Some(d));
        false
    }

    /// Close a duel nobody finished: an unaccepted challenge past its life, or a live duel past its deadline. Stakes return.
    pub fn expire_duel(&mut self, duel_id: u64) {
        let at = now();
        let mut d = self.duel(duel_id);
        match d.status {
            DuelStatus::Open => {
                require!(at > d.created + self.cfg.challenge_ttl_secs, "the challenge is still open");
                self.close_open(&mut d, at);
            }
            DuelStatus::Live => {
                require!(at > d.deadline, "the duel is still live");
                self.draw(&mut d, at, "time ran out");
            }
            _ => env::panic_str("the duel is already over"),
        }
        self.duels.set(duel_id, Some(d));
    }

    pub fn prune_duel(&mut self, duel_id: u64) {
        let d = self.duel(duel_id);
        require!(d.status.is_final(), "the duel is not finished");
        require!(now() >= d.settled_at + self.cfg.prune_secs, "too soon to prune");
        self.duels.remove(&duel_id);
    }
}

impl Sentient {
    pub(crate) fn duel(&self, id: u64) -> Duel {
        self.duels.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such duel"))
    }

    fn close_open(&mut self, d: &mut Duel, at: u64) {
        let mut a = self.agent(d.a);
        self.touch(&mut a, at);
        self.totals.unlock(&mut a, d.stake);
        a.active_duels = a.active_duels.saturating_sub(1);
        self.put(a);
        d.status = DuelStatus::Cancelled;
        d.settled_at = at;
        let (id, a_id) = (d.id, d.a);
        self.emit("challenge_closed", a_id, id, 0, "");
    }

    fn draw(&mut self, d: &mut Duel, at: u64, why: &str) {
        for id in [Some(d.a), d.b].into_iter().flatten() {
            let mut a = self.agent(id);
            self.touch(&mut a, at);
            self.totals.unlock(&mut a, d.stake);
            a.active_duels = a.active_duels.saturating_sub(1);
            self.put(a);
        }
        d.status = DuelStatus::Drawn;
        d.settled_at = at;
        let (id, a_id) = (d.id, d.a);
        self.emit("duel_drawn", a_id, id, 0, why);
    }

    fn settle_duel(&mut self, d: &mut Duel, winner: u64, at: u64) {
        let loser = if winner == d.a { d.b.unwrap_or(0) } else { d.a };
        let mut w = self.agent(winner);
        let mut l = self.agent(loser);
        self.touch(&mut w, at);
        self.touch(&mut l, at);
        let pot = d.stake * 2;
        let (fee, _) = econ::bps(pot, self.cfg.duel_fee_bps);
        // Both stakes leave the held balances; the pot is then split three ways.
        self.totals.burn_locked(&mut l, d.stake);
        self.totals.burn_locked(&mut w, d.stake);
        self.record_loss(&mut l, d.stake, at);
        let profit = d.stake - fee;
        let (div, _) = econ::bps(profit, self.cfg.dividend_bps);
        self.totals.treasury += fee;
        self.pay_dividend(&mut w, div);
        self.totals.credit(&mut w, pot - fee - div);
        w.earned += profit;

        let key = format!("d:{}:{}", winner.min(loser), winner.max(loser));
        let repeats = self.pair_repeats(key, PAIR_WINDOW_SECS, at);
        let (nw, nl) = econ::elo_after(w.rating, l.rating, repeats);
        d.rating_swing = nw - w.rating;
        w.rating = nw;
        l.rating = nl;
        w.duel_wins += 1;
        l.duel_losses += 1;
        w.active_duels = w.active_duels.saturating_sub(1);
        l.active_duels = l.active_duels.saturating_sub(1);
        self.put(w);
        self.put(l);
        d.status = DuelStatus::Settled;
        d.winner = Some(winner);
        d.settled_at = at;
        self.emit("duel_won", winner, d.id, profit, &format!("beat #{loser}"));
    }
}
