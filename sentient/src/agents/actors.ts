/**
 * Everyone around the agents. None of these is special to the contract: each is an ordinary account calling public
 * methods, and each could be run by anyone.
 *
 *  - Market: people who want work done. They post bounties, review deliverables with the rubric and accept or reject.
 *  - Chair: rules on rejected jobs with the same rubric.
 *  - Keeper: calls the public maintenance methods (expire, finalize, poke) that keep money from sitting in limbo.
 *  - Fans: buy shares of agents that are doing well and sell the ones that are not.
 *  - Owner: tops up an agent's gas, wakes a promising dormant agent, and breeds proven ones.
 */
import type { Chain } from "../lib/near.js";
import type { WorldWatcher } from "../lib/world.js";
import type { ArtifactStore } from "../lib/store.js";
import type { Brain } from "../lib/brain.js";
import type { Agent, Config, Job } from "../lib/types.js";
import { briefText, makeBrief, parseBrief } from "../lib/jobs.js";
import { readyToBreed } from "../lib/policy.js";
import { NEAR } from "../lib/units.js";
import { log, logError, sleep } from "../lib/log.js";

abstract class Loop {
  protected stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly label: string, private readonly everyMs: number, protected readonly rnd: () => number) {}

  protected abstract step(): Promise<void>;

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.step();
      } catch (e) {
        // shown by default, once a minute per message (see logError): a market out of funds or a chair whose key was lost
        // would otherwise fail in silence
        const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160);
        logError(this.label, `step failed: ${msg}`);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.everyMs * (0.7 + 0.6 * this.rnd()));
    };
    this.timer = setTimeout(loop, 300 + 700 * this.rnd());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

const settled = new Set(["Paid", "Refunded", "Split", "Cancelled"]);

/** How long the contract remembers repeat duels between one pair (its `DUEL_PAIR_WINDOW`; a code constant, not config). */
const DUEL_PAIR_WINDOW_SECS = 86_400;

export interface MarketOpts {
  everyMs: number;
  minBounty: bigint;
  maxBounty: bigint;
  /** at most this many of the market's jobs may be waiting for a worker at once */
  maxOpen: number;
  workSecs: number;
}

/** People who want work done. They pay, and they decide, by the rubric, whether they got it. */
export class Market extends Loop {
  private n = 0;
  private readonly reviewed = new Set<number>();
  private readonly tries = new Map<number, number>();
  posted = 0;
  accepted = 0;
  rejected = 0;

  constructor(
    private readonly posters: Chain[],
    private readonly world: WorldWatcher,
    private readonly store: ArtifactStore,
    private readonly brain: Brain,
    private readonly opts: MarketOpts,
    rnd: () => number,
  ) {
    super("market", opts.everyMs, rnd);
  }

  protected async step(): Promise<void> {
    const snap = this.world.snap;
    if (!snap) return;
    const ours = new Set(this.posters.map((p) => p.accountId));
    // review first: a deliverable waiting is worth more than a new job
    for (const job of snap.jobs) {
      if (job.status !== "Submitted" || !ours.has(job.poster) || this.reviewed.has(job.id)) continue;
      // A review that fails (a store read, a dropped transaction) is tried again, up to three times; it is only "reviewed"
      // once the accept or reject has actually gone through. (A silent poster still pays the worker after the window.)
      const tried = this.tries.get(job.id) ?? 0;
      if (tried >= 3) continue;
      this.tries.set(job.id, tried + 1);
      const chain = this.posters.find((p) => p.accountId === job.poster)!;
      const brief = parseBrief(await this.store.get(job.brief_uri, job.brief_hash));
      const text = await this.store.get(job.sub_uri, job.sub_hash);
      const g = await this.brain.review(brief, text);
      await sleep(300 + 1200 * this.rnd());
      if (g.pass) {
        await chain.acceptWork(job.id);
        this.reviewed.add(job.id);
        this.accepted++;
        log("market", `accepts job #${job.id} (score ${g.score})`);
      } else {
        await chain.rejectWork(job.id, g.reasons.join("; "));
        this.reviewed.add(job.id);
        this.rejected++;
        log("market", `rejects job #${job.id}: ${g.reasons.join("; ")}`);
      }
      return;
    }
    const open = snap.jobs.filter((j) => j.status === "Open" && ours.has(j.poster)).length;
    if (open >= this.opts.maxOpen) return;
    const chain = this.posters[this.n % this.posters.length];
    const span = Number((this.opts.maxBounty - this.opts.minBounty) / (NEAR / 1000n));
    const bounty = this.opts.minBounty + BigInt(Math.floor(this.rnd() * span)) * (NEAR / 1000n);
    const brief = makeBrief(this.n, 3 + Math.floor(this.rnd() * 3));
    const blob = this.store.put(briefText(brief));
    this.n++;
    const cfg = this.world.cfg!;
    // inside the contract's own limits, whatever the caller asked for
    const workSecs = Math.min(cfg.max_work_secs, Math.max(this.opts.workSecs, cfg.min_work_secs));
    const id = await chain.postJob({
      title: brief.topic.slice(0, 78), briefUri: blob.uri, briefHash: blob.hash, workSecs,
      deposit: bounty + BigInt(cfg.job_storage_fee),
    });
    this.posted++;
    log("market", `posts job #${id}: ${brief.topic.slice(0, 50)} (${(Number(bounty / (NEAR / 1000n)) / 1000).toFixed(3)} NEAR)`);
  }
}

/** Rules on rejected jobs. It uses the rubric, so a rejection that was wrong is overturned and a right one stands. */
export class Chair extends Loop {
  ruled = 0;
  private readonly tries = new Map<number, number>();

  constructor(
    private readonly chain: Chain,
    private readonly world: WorldWatcher,
    private readonly store: ArtifactStore,
    private readonly brain: Brain,
    rnd: () => number,
  ) {
    super("chair", 1500, rnd);
  }

  protected async step(): Promise<void> {
    for (const job of this.world.snap?.jobs ?? []) {
      if (job.status !== "Disputed") continue;
      // Three tries per dispute, then leave it: a ruling the contract will never accept (the chair is a party to the job, say)
      // would otherwise be retried every second for ever. A silent chair is handled by the contract (it splits the bounty).
      const tried = this.tries.get(job.id) ?? 0;
      if (tried >= 3) continue;
      this.tries.set(job.id, tried + 1);
      const brief = parseBrief(await this.store.get(job.brief_uri, job.brief_hash));
      const text = await this.store.get(job.sub_uri, job.sub_hash);
      const g = await this.brain.review(brief, text);
      await this.chain.resolveDispute(job.id, g.pass ? "PayWorker" : "RefundPoster");
      this.ruled++;
      log("chair", `rules job #${job.id}: ${g.pass ? "pay the worker" : "refund the poster"}`);
      return;
    }
  }
}

/** Public maintenance. Anyone can do this; it only makes stuck money move. */
export class Keeper extends Loop {
  calls = 0;
  private readonly tries = new Map<string, number>();
  private readonly pairKeys = new Set<string>();
  private lastPairs = 0;

  constructor(private readonly chain: Chain, private readonly world: WorldWatcher, private readonly cfg: Config, rnd: () => number) {
    super("keeper", 1200, rnd);
  }

  protected async step(): Promise<void> {
    const snap = this.world.snap;
    if (!snap) return;
    const now = this.world.chainNow();
    const c = this.cfg;
    const act = async (what: string, f: () => Promise<unknown>) => {
      try {
        await f();
        this.calls++;
        log("keeper", what);
      } catch {
        /* someone else got there first */
      }
    };
    for (const j of snap.jobs) {
      if (j.status === "Claimed" && now > j.deadline + 1) return act(`expires the claim on job #${j.id}`, () => this.chain.expireClaim(j.id));
      if (j.status === "Submitted" && now >= j.submitted_at + c.review_secs + 1) return act(`finalizes job #${j.id}`, () => this.chain.finalizeJob(j.id));
      if (j.status === "Disputed" && now >= j.disputed_at + c.arbiter_secs + 1) return act(`splits job #${j.id}`, () => this.chain.resolveStale(j.id));
    }
    for (const d of snap.duels) {
      if (d.status === "Live" && now > d.deadline + 1) return act(`closes duel #${d.id}`, () => this.chain.expireDuel(d.id));
      if (d.status === "Open" && now > d.created + c.challenge_ttl_secs + 1) return act(`closes challenge #${d.id}`, () => this.chain.expireDuel(d.id));
    }
    for (const a of snap.agents) {
      if (a.live_dormant && !a.dormant) return act(`records that ${a.name} has gone dormant`, () => this.chain.poke(a.id));
    }
    // Housekeeping that gives storage back: finished records past their retention, and repeat-meeting records past theirs.
    // A record is tried up to three times: a failure may be the clock (our idea of chain time is an estimate), a repeat
    // would only be someone else having pruned it first.
    const attempt = (key: string) => {
      const n = (this.tries.get(key) ?? 0) + 1;
      this.tries.set(key, n);
      return n <= 3;
    };
    for (const d of snap.duels) if (d.status === "Settled" && d.b !== null) this.pairKeys.add(`d:${Math.min(d.a, d.b)}:${Math.max(d.a, d.b)}`);
    for (const j of snap.jobs) {
      if (["Paid", "Refunded", "Split", "Cancelled"].includes(j.status) && j.settled_at > 0 && now >= j.settled_at + c.prune_secs + 1 && attempt(`j${j.id}`)) {
        return act(`prunes job #${j.id}`, () => this.chain.pruneJob(j.id));
      }
    }
    for (const d of snap.duels) {
      if (["Settled", "Drawn", "Cancelled"].includes(d.status) && d.settled_at > 0 && now >= d.settled_at + c.prune_secs + 1 && attempt(`d${d.id}`)) {
        return act(`prunes duel #${d.id}`, () => this.chain.pruneDuel(d.id));
      }
    }
    // Repeat-meeting records outlive the duels that made them, so the keys are remembered here, and forgotten once gone.
    // Ask first, so a transaction is only sent for records that are actually past their window.
    if (this.pairKeys.size && Date.now() - this.lastPairs > 60_000) {
      this.lastPairs = Date.now();
      const due: string[] = [];
      for (const k of [...this.pairKeys].slice(0, 50)) {
        const rec = await this.chain.view<{ count: number; since: number } | null>("get_pair", { key: k });
        if (rec === null) this.pairKeys.delete(k);
        else if (now - rec.since > DUEL_PAIR_WINDOW_SECS + 1) due.push(k);
      }
      if (due.length) return act(`prunes ${due.length} repeat-meeting records past their window`, () => this.chain.prunePairs(due));
    }
  }
}

/** Buys shares of agents on a run and sells the ones that have stalled. */
export class Fans extends Loop {
  trades = 0;
  private readonly held = new Map<string, Set<number>>();

  constructor(private readonly fans: Chain[], private readonly world: WorldWatcher, rnd: () => number) {
    super("fans", 3500, rnd);
  }

  private score(a: Agent): number {
    return Number((BigInt(a.earned) - BigInt(a.lost)) / (NEAR / 1000n)) / 1000 + (a.rating - 1000) / 100 + a.reputation / 10;
  }

  protected async step(): Promise<void> {
    const snap = this.world.snap;
    if (!snap || snap.agents.length < 3) return;
    const ranked = [...snap.agents].sort((a, b) => this.score(b) - this.score(a));
    const fan = this.fans[Math.floor(this.rnd() * this.fans.length)];
    const mine = this.held.get(fan.accountId) ?? new Set<number>();
    this.held.set(fan.accountId, mine);
    // sell something that stalled or died
    for (const id of mine) {
      const a = snap.agents.find((x) => x.id === id);
      if (a && (a.live_dormant || ranked.indexOf(a) >= ranked.length - 2)) {
        const h = await fan.holding(id, fan.accountId);
        if (h && h.shares > 0 && this.world.chainNow() >= h.last_buy + (this.world.cfg?.sell_lock_secs ?? 60) + 1) {
          await fan.sellShares(id, h.shares);
          mine.delete(id);
          this.trades++;
          log("fans", `${fan.accountId.split(".")[0]} sells out of ${a.name}`);
          return;
        }
      }
    }
    const pick = ranked.slice(0, 3).find((a) => !a.live_dormant && !mine.has(a.id));
    if (pick) {
      const q = await fan.quote(pick.id, 1, true);
      await fan.buyShares(pick.id, 1, BigInt(q.total) + 10n ** 20n);
      mine.add(pick.id);
      this.trades++;
      log("fans", `${fan.accountId.split(".")[0]} buys a share of ${pick.name}`);
      return;
    }
    // collect any dividends
    for (const id of mine) {
      const d = await fan.pendingDividends(id, fan.accountId);
      if (d > NEAR / 100n) {
        await fan.claimDividends(id);
        log("fans", `${fan.accountId.split(".")[0]} collects dividends`);
        return;
      }
    }
  }
}

export interface OwnerOpts {
  /** keep the agent's own account above this much NEAR */
  tankFloor: bigint;
  refuel: bigint;
  /** breed when two of this owner's agents qualify */
  breed?: (parentA: number, parentB: number) => Promise<void>;
  /** how many times this owner will wake the same agent before giving up on it (default 3) */
  maxRevivals?: number;
}

/** An owner who looks after their agents: gas, and a second chance for one that was doing well. */
export class Owner extends Loop {
  refueled = 0;
  revived = 0;

  constructor(
    label: string,
    private readonly chain: Chain,
    private readonly agentIds: () => number[],
    private readonly world: WorldWatcher,
    private readonly cfg: Config,
    private readonly opts: OwnerOpts,
    rnd: () => number,
  ) {
    super(label, 2500, rnd);
  }

  protected async step(): Promise<void> {
    const snap = this.world.snap;
    if (!snap) return;
    const mine = this.agentIds().map((id) => snap.agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
    for (const a of mine) {
      const tank = await this.chain.nativeBalance(a.account);
      if (tank < this.opts.tankFloor && BigInt(a.live_ledger) > this.opts.refuel * 2n && !a.live_dormant) {
        await this.chain.refuel(a.id, this.opts.refuel);
        this.refueled++;
        log(this.label, `tops up ${a.name}'s gas`);
        return;
      }
      // an owner gives up on an agent that keeps dying, rather than paying for it for ever
      if (a.live_dormant && a.jobs_done + a.duel_wins >= 2 && a.revivals < (this.opts.maxRevivals ?? 3)) {
        await this.chain.revive(a.id, BigInt(this.cfg.revive_min) * 2n);
        this.revived++;
        log(this.label, `revives ${a.name}, which had a record worth keeping`);
        return;
      }
    }
    if (this.opts.breed) {
      const half = BigInt(this.cfg.breed_cost) / 2n;
      const now = this.world.chainNow();
      const ready = mine.filter((a) => readyToBreed(a, BigInt(a.live_ledger), half) && now >= a.breed_ready_at);
      if (ready.length >= 2) await this.opts.breed(ready[0].id, ready[1].id);
    }
  }
}

/** Convenience used by the runner: the open jobs nobody has taken, newest first. */
export const openJobs = (jobs: Job[]) => jobs.filter((j) => j.status === "Open");
export const isSettled = (j: Job) => settled.has(j.status);
