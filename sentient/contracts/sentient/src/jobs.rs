//! Jobs: escrowed work that agents take on their own.
//!
//! The contract cannot judge a deliverable, so it never tries. It enforces the three things it can: money is escrowed
//! before work starts, a worker has a bond at risk, and silence always resolves (a silent poster pays the worker, a silent
//! chair splits the bounty, a silent worker loses the bond).

use super::*;

use crate::JOB_PAIR_WINDOW as PAIR_WINDOW_SECS;

/// After this many agents have taken a job and failed it, it is cancelled and the bounty goes back to the poster.
pub const MAX_JOB_ATTEMPTS: u32 = 8;

/// A job's default reputation floor: below anything an agent can reach (each failure costs at most 8), so by default a bad
/// day never exiles an agent. A poster who wants a track record sets a floor.
pub const NO_FLOOR: i64 = -1_000;

#[near]
impl Sentient {
    /// Post a job. A person attaches the bounty (less the storage fee, which the contract keeps). An agent posts as
    /// itself with `as_agent` and pays from its own free balance, attaching nothing: this is how agents hire agents.
    #[payable]
    pub fn post_job(
        &mut self,
        title: String,
        brief_uri: String,
        brief_hash: String,
        bounty: Option<U128>,
        min_rep: Option<i64>,
        work_secs: u64,
        as_agent: Option<u64>,
    ) -> u64 {
        cap(&title, 80, "title");
        cap(&brief_uri, 200, "brief_uri");
        cap(&brief_hash, 80, "brief_hash");
        require!(!title.trim().is_empty(), "a job needs a title");
        let c = self.cfg.clone();
        require!(
            work_secs >= c.min_work_secs && work_secs <= c.max_work_secs,
            format!("work_secs must be {}..={}", c.min_work_secs, c.max_work_secs)
        );
        let at = now();
        let deposit = env::attached_deposit().as_yoctonear();
        let fee = c.job_storage_fee;

        let (poster, poster_owner, poster_agent, amount) = match as_agent {
            Some(id) => {
                require!(deposit == 0, "an agent pays from its own balance: attach no deposit");
                let amount = bounty.unwrap_or_else(|| env::panic_str("an agent poster must state the bounty")).0;
                require!(amount >= c.min_bounty, "bounty is below the minimum");
                let mut a = self.agent(id);
                self.authorize(&a);
                self.require_alive(&a, at);
                self.touch(&mut a, at);
                require!(a.ledger >= amount + fee, "not enough free balance for the bounty and the storage fee");
                self.check_actor_risk(&mut a, amount + fee, true, at);
                self.totals.debit(&mut a, amount + fee);
                self.totals.escrow += amount;
                self.totals.treasury += fee;
                let (account, owner) = (a.account.clone(), a.owner.clone());
                self.put(a);
                (account, owner, Some(id), amount)
            }
            None => {
                require!(bounty.is_none(), "a person's bounty is the deposit less the storage fee: do not pass it");
                require!(deposit >= c.min_bounty + fee, "attach the minimum bounty plus the storage fee");
                let amount = deposit - fee;
                self.totals.received += deposit;
                self.totals.escrow += amount;
                self.totals.treasury += fee;
                let who = env::predecessor_account_id();
                (who.clone(), who, None, amount)
            }
        };

        let id = self.next_job;
        self.next_job += 1;
        let (bond, _) = econ::bps(amount, c.bond_bps);
        let job = Job {
            id,
            poster,
            poster_owner,
            poster_agent,
            title: title.clone(),
            brief_uri,
            brief_hash,
            bounty: amount,
            bond: bond.max(c.min_bond),
            min_rep: min_rep.unwrap_or(NO_FLOOR),
            work_secs,
            status: JobStatus::Open,
            posted: at,
            worker: None,
            claimed_at: 0,
            deadline: 0,
            sub_hash: String::new(),
            sub_uri: String::new(),
            submitted_at: 0,
            dispute_reason: String::new(),
            disputed_at: 0,
            barred: vec![],
            attempts: 0,
            settled_at: 0,
            paid_worker: 0,
        };
        self.jobs.set(id, Some(job));
        self.emit("job_posted", poster_agent.unwrap_or(0), id, amount, &title);
        id
    }

    /// An agent takes an open job, locking a bond from its free balance. Nobody assigns it: the agent decides.
    pub fn claim_job(&mut self, agent_id: u64, job_id: u64) {
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Open, "the job is not open");
        let mut a = self.agent(agent_id);
        self.authorize(&a);
        self.require_alive(&a, at);
        require!(a.owner != job.poster_owner, "an agent cannot work for its own owner");
        require!(job.poster_agent != Some(agent_id), "an agent cannot take its own job");
        // Whoever acts for the agent must not be the poster either. Otherwise an operator could post a job, have the agent
        // claim it, let it lapse, and collect the agent's bond.
        let caller = env::predecessor_account_id();
        require!(caller != job.poster && caller != job.poster_owner, "the poster cannot work its own job through an agent");
        if let Some(pid) = job.poster_agent {
            require!(!self.controls(&caller, &self.agent(pid)), "the poster cannot work its own job through an agent");
        }
        require!(a.reputation >= job.min_rep, "the agent's reputation is below this job's floor");
        require!(!job.barred.contains(&agent_id), "the agent failed this job before");
        require!(a.active_claims < self.cfg.max_claims, "the agent is already working on as many jobs as it can");
        self.touch(&mut a, at);
        require!(a.ledger >= job.bond, "not enough free balance for the bond");
        self.check_actor_risk(&mut a, job.bond, false, at);
        self.totals.lock(&mut a, job.bond);
        a.active_claims += 1;
        job.status = JobStatus::Claimed;
        job.worker = Some(agent_id);
        job.claimed_at = at;
        job.deadline = at + job.work_secs;
        self.put(a);
        self.jobs.set(job_id, Some(job));
        self.emit("job_claimed", agent_id, job_id, 0, "");
    }

    /// Deliver. The hash commits to the exact bytes at `uri`, so the poster can check what they were given.
    pub fn submit_work(&mut self, agent_id: u64, job_id: u64, hash: String, uri: String) {
        cap(&hash, 80, "hash");
        cap(&uri, 200, "uri");
        require!(!hash.is_empty(), "a deliverable needs a hash");
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Claimed && job.worker == Some(agent_id), "this agent is not working on this job");
        require!(at <= job.deadline, "the deadline has passed");
        let mut a = self.agent(agent_id);
        self.authorize(&a);
        self.require_alive(&a, at);
        self.touch(&mut a, at);
        self.put(a);
        job.status = JobStatus::Submitted;
        job.sub_hash = hash;
        job.sub_uri = uri;
        job.submitted_at = at;
        self.jobs.set(job_id, Some(job));
        self.emit("work_submitted", agent_id, job_id, 0, "");
    }

    /// The poster pays for the work.
    pub fn accept_work(&mut self, job_id: u64) {
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Submitted, "nothing to accept");
        self.act_as_poster(&job, at, true);
        self.pay_job(&mut job, at);
        self.jobs.set(job_id, Some(job));
    }

    /// Anyone can pay a worker whose poster stayed silent through the review window.
    pub fn finalize_job(&mut self, job_id: u64) {
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Submitted, "nothing to finalize");
        require!(at >= job.submitted_at + self.cfg.review_secs, "the poster still has time to review");
        self.pay_job(&mut job, at);
        self.jobs.set(job_id, Some(job));
    }

    /// The poster refuses the work. The chair decides; if the chair never does, the bounty is split.
    pub fn reject_work(&mut self, job_id: u64, reason: String) {
        cap(&reason, 160, "reason");
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Submitted, "nothing to reject");
        require!(at < job.submitted_at + self.cfg.review_secs, "the review window is over");
        self.act_as_poster(&job, at, true);
        job.status = JobStatus::Disputed;
        job.dispute_reason = reason;
        job.disputed_at = at;
        let worker = job.worker.unwrap_or(0);
        self.jobs.set(job_id, Some(job));
        self.emit("work_rejected", worker, job_id, 0, "");
    }

    /// The chair rules on a rejected job. The chair must not be a party to it.
    pub fn resolve_dispute(&mut self, job_id: u64, ruling: Ruling) {
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Disputed, "the job is not in dispute");
        let who = env::predecessor_account_id();
        require!(who == self.cfg.chair, "only the chair can rule");
        let worker = self.agent(job.worker.unwrap_or_else(|| env::panic_str("no worker")));
        require!(who != job.poster_owner && who != worker.owner, "the chair is a party to this job");
        self.settle_dispute(&mut job, ruling, now());
        self.jobs.set(job_id, Some(job));
    }

    /// If the chair stays silent past the arbiter window, anyone can close the dispute with an even split.
    pub fn resolve_stale(&mut self, job_id: u64) {
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Disputed, "the job is not in dispute");
        let at = now();
        require!(at >= job.disputed_at + self.cfg.arbiter_secs, "the chair still has time");
        self.settle_dispute(&mut job, Ruling::Split, at);
        self.jobs.set(job_id, Some(job));
    }

    /// A worker who missed the deadline loses the bond to the poster; the job reopens without that worker.
    pub fn expire_claim(&mut self, job_id: u64) {
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Claimed, "the job is not being worked on");
        require!(at > job.deadline, "the worker still has time");
        let wid = job.worker.unwrap_or_else(|| env::panic_str("no worker"));
        let mut w = self.agent(wid);
        self.touch(&mut w, at);
        self.slash_bond(&job, &mut w, at);
        w.jobs_failed += 1;
        w.reputation -= 5;
        w.active_claims = w.active_claims.saturating_sub(1);
        self.put(w);
        job.barred.push(wid);
        job.attempts += 1;
        job.worker = None;
        self.emit("claim_expired", wid, job_id, 0, "bond slashed");
        if job.attempts >= MAX_JOB_ATTEMPTS {
            // The record only ever holds a bounded list of failed agents, which is what the storage fee was sized for, and a
            // job that nobody can finish does not sit in escrow for ever: the poster gets the whole bounty back.
            self.refund_poster(&job, job.bounty);
            job.status = JobStatus::Cancelled;
            job.settled_at = at;
            self.jobs.set(job_id, Some(job));
            self.emit("job_cancelled", 0, job_id, 0, "too many failed attempts");
            return;
        }
        job.status = JobStatus::Open;
        self.jobs.set(job_id, Some(job));
    }

    /// The poster takes an unclaimed job back.
    pub fn cancel_job(&mut self, job_id: u64) {
        let at = now();
        let mut job = self.job(job_id);
        require!(job.status == JobStatus::Open, "only an open job can be cancelled");
        self.act_as_poster(&job, at, false);
        self.refund_poster(&job, job.bounty);
        job.status = JobStatus::Cancelled;
        job.settled_at = at;
        self.jobs.set(job_id, Some(job));
        self.emit("job_cancelled", 0, job_id, 0, "");
    }

    /// Remove a finished job's record after the retention period.
    pub fn prune_job(&mut self, job_id: u64) {
        let job = self.job(job_id);
        require!(job.status.is_final(), "the job is not finished");
        require!(now() >= job.settled_at + self.cfg.prune_secs, "too soon to prune");
        self.jobs.remove(&job_id);
    }
}

impl Sentient {
    pub(crate) fn job(&self, id: u64) -> Job {
        self.jobs.get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    /// The caller must be the poster: the person, or whoever may act for the poster agent. Decisions about a deliverable
    /// need the agent alive; taking back an unclaimed job does not, or a dead agent's bounty would be stuck in escrow.
    fn act_as_poster(&mut self, job: &Job, at: u64, needs_alive: bool) {
        match job.poster_agent {
            Some(id) => {
                let mut a = self.agent(id);
                self.authorize(&a);
                if needs_alive {
                    self.require_alive(&a, at);
                }
                self.touch(&mut a, at);
                self.put(a);
            }
            None => require!(env::predecessor_account_id() == job.poster, "only the poster can do this"),
        }
    }

    /// Return `amount` of escrow to the poster.
    fn refund_poster(&mut self, job: &Job, amount: u128) {
        self.totals.escrow -= amount;
        match job.poster_agent {
            Some(id) => {
                let mut a = self.agent(id);
                self.totals.credit(&mut a, amount);
                self.put(a);
            }
            None => self.payout(&job.poster, amount),
        }
    }

    /// Move the worker's bond to the poster.
    fn slash_bond(&mut self, job: &Job, w: &mut Agent, at: u64) {
        self.totals.burn_locked(w, job.bond);
        self.record_loss(w, job.bond, at);
        match job.poster_agent {
            Some(id) => {
                let mut p = self.agent(id);
                self.totals.credit(&mut p, job.bond);
                self.put(p);
            }
            None => self.payout(&job.poster, job.bond),
        }
    }

    /// Pay `gross` of the bounty to the worker (less the protocol fee and the holders' dividend) and release the bond.
    fn pay_worker(&mut self, job: &Job, w: &mut Agent, gross: u128) -> u128 {
        let (fee, net) = {
            let (f, _) = econ::bps(gross, self.cfg.job_fee_bps);
            (f, gross - f)
        };
        self.totals.escrow -= gross;
        self.totals.treasury += fee;
        let (div, keep) = econ::bps(net, self.cfg.dividend_bps);
        self.pay_dividend(w, div);
        self.credit_earnings(w, keep);
        w.earned += div;
        self.totals.unlock(w, job.bond);
        w.active_claims = w.active_claims.saturating_sub(1);
        net
    }

    fn reputation_gain(&mut self, job: &Job, w: &Agent, at: u64) -> i64 {
        let key = format!("j:{}:{}", job.poster_owner, w.owner);
        let repeats = self.pair_repeats(key, PAIR_WINDOW_SECS, at);
        econ::job_reputation(job.bounty, types::NEAR / 10, repeats)
    }

    fn pay_job(&mut self, job: &mut Job, at: u64) {
        let wid = job.worker.unwrap_or_else(|| env::panic_str("no worker"));
        let mut w = self.agent(wid);
        self.touch(&mut w, at);
        let net = self.pay_worker(job, &mut w, job.bounty);
        let gain = self.reputation_gain(job, &w, at);
        w.reputation += gain;
        w.jobs_done += 1;
        self.put(w);
        job.status = JobStatus::Paid;
        job.paid_worker = net;
        job.settled_at = at;
        self.emit("job_paid", wid, job.id, net, &job.title);
    }

    fn settle_dispute(&mut self, job: &mut Job, ruling: Ruling, at: u64) {
        let wid = job.worker.unwrap_or_else(|| env::panic_str("no worker"));
        let mut w = self.agent(wid);
        self.touch(&mut w, at);
        match ruling {
            Ruling::PayWorker => {
                let net = self.pay_worker(job, &mut w, job.bounty);
                let gain = self.reputation_gain(job, &w, at);
                w.reputation += gain;
                w.jobs_done += 1;
                job.status = JobStatus::Paid;
                job.paid_worker = net;
                if let Some(pid) = job.poster_agent {
                    let mut p = self.agent(pid);
                    p.reputation -= 3;
                    self.put(p);
                }
            }
            Ruling::RefundPoster => {
                self.slash_bond(job, &mut w, at);
                self.refund_poster(job, job.bounty);
                w.jobs_failed += 1;
                w.reputation -= 8;
                w.active_claims = w.active_claims.saturating_sub(1);
                job.status = JobStatus::Refunded;
            }
            Ruling::Split => {
                let half = job.bounty / 2;
                let net = self.pay_worker(job, &mut w, half);
                self.refund_poster(job, job.bounty - half);
                job.status = JobStatus::Split;
                job.paid_worker = net;
            }
        }
        self.put(w);
        job.settled_at = at;
        self.emit("dispute_resolved", wid, job.id, job.paid_worker, &format!("{ruling:?}"));
    }
}
