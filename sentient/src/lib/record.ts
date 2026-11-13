import type { Snapshot } from "./world.js";
import type { Agent, Audit, Config, Duel, FeedEntry, Job, Stats } from "./types.js";
import type { ArtifactStore } from "./store.js";

/** What the dashboard needs of an agent. `ledger` and `dormant` are the live figures (after upkeep owed right now). */
export interface SlimAgent {
  id: number;
  name: string;
  persona?: string;
  owner: string;
  account: string;
  genome: Agent["genome"];
  generation: number;
  parents: [number, number] | null;
  born: number;
  dormant: boolean;
  ledger: string;
  locked: string;
  reputation: number;
  rating: number;
  jobsDone: number;
  jobsFailed: number;
  duelWins: number;
  duelLosses: number;
  earned: string;
  lost: string;
  upkeep: string;
  shares: number;
  price: string;
  revivals: number;
  runway: number;
  offspring: number;
  activeClaims: number;
  activeDuels: number;
  tank?: string;
}

export const slimAgent = (a: Agent, tank?: bigint): SlimAgent => ({
  id: a.id, name: a.name, owner: a.owner, account: a.account, genome: a.genome, generation: a.generation, parents: a.parents,
  born: a.born, dormant: a.live_dormant, ledger: a.live_ledger, locked: a.locked, reputation: a.reputation, rating: a.rating,
  jobsDone: a.jobs_done, jobsFailed: a.jobs_failed, duelWins: a.duel_wins, duelLosses: a.duel_losses, earned: a.earned,
  lost: a.lost, upkeep: a.upkeep_paid, shares: a.shares, price: a.share_price, revivals: a.revivals,
  runway: Math.min(a.runway_secs, 1_000_000), offspring: a.offspring, activeClaims: a.active_claims, activeDuels: a.active_duels,
  ...(tank === undefined ? {} : { tank: tank.toString() }),
});

export interface SlimJob {
  id: number;
  title: string;
  poster: string;
  posterAgent: number | null;
  bounty: string;
  status: Job["status"];
  worker: number | null;
  posted: number;
  deadline: number;
  submittedAt: number;
  subHash: string;
  briefHash: string;
  briefUri: string;
  paid: string;
  attempts: number;
  reason: string;
}

export const slimJob = (j: Job): SlimJob => ({
  id: j.id, title: j.title, poster: j.poster, posterAgent: j.poster_agent, bounty: j.bounty, status: j.status, worker: j.worker,
  posted: j.posted, deadline: j.deadline, submittedAt: j.submitted_at, subHash: j.sub_hash, briefHash: j.brief_hash,
  briefUri: j.brief_uri, paid: j.paid_worker, attempts: j.attempts, reason: j.dispute_reason,
});

export interface SlimDuel {
  id: number;
  kind: number | null;
  question: string;
  a: number;
  b: number | null;
  stake: string;
  status: Duel["status"];
  winner: number | null;
  swing: number;
  liveAt: number;
  deadline: number;
  wrongA: boolean;
  wrongB: boolean;
}

export const slimDuel = (d: Duel): SlimDuel => ({
  id: d.id, kind: d.kind, question: d.question, a: d.a, b: d.b, stake: d.stake, status: d.status, winner: d.winner,
  swing: d.rating_swing, liveAt: d.live_at, deadline: d.deadline, wrongA: d.wrong_a, wrongB: d.wrong_b,
});

/** One moment. Only what changed since the previous frame is stored; the dashboard folds the frames back together. */
export interface Frame {
  /** ms since the recording started */
  t: number;
  /** the chain's clock, in seconds */
  now: number;
  stats: Stats;
  agents: SlimAgent[];
  jobs: SlimJob[];
  duels: SlimDuel[];
  feed: FeedEntry[];
  totals?: Audit["totals"];
}

export interface Recording {
  meta: {
    kind: "recording";
    network: string;
    contractId: string;
    brain: string;
    brainLive: boolean;
    recordedAt: number;
    seconds: number;
    note: string;
  };
  cfg: Config;
  frames: Frame[];
  /** content-addressed text the jobs point at, keyed by hash */
  artifacts: Record<string, string>;
  /** what the participants did, for the summary panel */
  cast: Record<string, string>;
  audit: Audit | null;
  summary: Record<string, unknown>;
}

export class Recorder {
  readonly frames: Frame[] = [];
  private readonly t0 = Date.now();
  private prevAgents = new Map<number, string>();
  private prevJobs = new Map<number, string>();
  private prevDuels = new Map<number, string>();
  private lastSeq = -1;
  private readonly tanks = new Map<number, bigint>();
  private lastTotals = 0;
  private readonly seenPersona = new Set<number>();

  setTank(agentId: number, v: bigint): void {
    this.tanks.set(agentId, v);
  }

  /** Fold a snapshot into the recording. `totals` is attached about every ten seconds. */
  push(s: Snapshot, totals?: Audit["totals"]): void {
    const agents: SlimAgent[] = [];
    for (const a of s.agents) {
      const slim = slimAgent(a, this.tanks.get(a.id));
      const key = JSON.stringify(slim);
      if (this.prevAgents.get(a.id) === key) continue;
      this.prevAgents.set(a.id, key);
      if (!this.seenPersona.has(a.id)) {
        slim.persona = a.persona;
        this.seenPersona.add(a.id);
      }
      agents.push(slim);
    }
    const jobs: SlimJob[] = [];
    for (const j of s.jobs) {
      const slim = slimJob(j);
      const key = JSON.stringify(slim);
      if (this.prevJobs.get(j.id) === key) continue;
      this.prevJobs.set(j.id, key);
      jobs.push(slim);
    }
    const duels: SlimDuel[] = [];
    for (const d of s.duels) {
      const slim = slimDuel(d);
      const key = JSON.stringify(slim);
      if (this.prevDuels.get(d.id) === key) continue;
      this.prevDuels.set(d.id, key);
      duels.push(slim);
    }
    const feed = s.feed.filter((e) => e.seq > this.lastSeq).sort((a, b) => a.seq - b.seq);
    if (feed.length) this.lastSeq = feed[feed.length - 1].seq;
    const attach = totals && Date.now() - this.lastTotals > 10_000;
    if (attach) this.lastTotals = Date.now();
    if (!agents.length && !jobs.length && !duels.length && !feed.length && !attach) return;
    this.frames.push({ t: Date.now() - this.t0, now: s.stats.now, stats: s.stats, agents, jobs, duels, feed, ...(attach ? { totals } : {}) });
  }

  /** Collect every deliverable and brief any job points at. They are content-addressed, so this is exact. */
  async artifacts(store: ArtifactStore): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const grab = async (uri: string, hash: string) => {
      if (!hash || out[hash]) return;
      try { out[hash] = await store.get(uri, hash); } catch { /* absent is fine */ }
    };
    for (const f of this.frames) {
      for (const j of f.jobs) {
        await grab(j.briefUri, j.briefHash);
        if (j.subHash) {
          const hex = j.subHash.slice("sha256:".length);
          if (store.hasHex(hex)) out[j.subHash] = store.readHex(hex);
        }
      }
    }
    return out;
  }
}
