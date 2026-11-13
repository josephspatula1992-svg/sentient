/**
 * An agent's runtime: the loop that makes an NFT act.
 *
 * It signs with the agent's own key, the function-call key the contract put on the agent's sub-account at mint, so every
 * call it makes arrives at the contract with the agent's own account as the caller. It reads the world from a shared
 * snapshot, decides with the genome (`policy.ts`), thinks with a `Brain`, and writes with one transaction at a time.
 *
 * A runtime holds no money and no authority beyond what the contract grants that key: it can take jobs, deliver, duel,
 * answer, hire, and ask for the public maintenance calls. It cannot withdraw, transfer, breed, or call anything else.
 */
import type { Chain } from "../lib/near.js";
import type { WorldWatcher } from "../lib/world.js";
import type { ArtifactStore } from "../lib/store.js";
import type { Brain } from "../lib/brain.js";
import type { Agent, Config, Duel, Job } from "../lib/types.js";
import { acceptsDuel, chooseStake, picksFight, reserve, wantsJob, wantsToHire } from "../lib/policy.js";
import { briefText, makeBrief, parseBrief } from "../lib/jobs.js";
import { NEAR } from "../lib/units.js";
import { log, logError, sleep } from "../lib/log.js";

export interface RuntimeDeps {
  chain: Chain;
  world: WorldWatcher;
  store: ArtifactStore;
  brain: Brain;
  cfg: Config;
  rnd: () => number;
  tickMs?: number;
}

export interface RuntimeStats {
  duelsAnswered: number;
  duelsWrong: number;
  jobsDelivered: number;
  jobsClaimed: number;
  challengesOpened: number;
  challengesAccepted: number;
  hired: number;
  /** lost a race to another agent for the same job or duel (a normal revert) */
  raced: number;
  /** refused by the contract's per-window cap on what the agent's own key can risk */
  capped: number;
  errors: number;
}

export class AgentRuntime {
  readonly stats: RuntimeStats = {
    duelsAnswered: 0, duelsWrong: 0, jobsDelivered: 0, jobsClaimed: 0, challengesOpened: 0, challengesAccepted: 0, hired: 0, raced: 0, capped: 0, errors: 0,
  };
  private stopped = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly answered = new Set<number>();
  private readonly worked = new Set<number>();
  private readonly reviewed = new Set<number>();
  /** job id -> true once its brief has been read, or the time a read last failed */
  private readonly readable = new Map<number, true | number>();
  private readonly tries = new Map<string, number>();
  private lastFight = 0;
  private lastHire = 0;

  constructor(readonly agentId: number, readonly label: string, private readonly d: RuntimeDeps) {}

  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      if (!this.busy) {
        this.busy = true;
        try {
          await this.tick();
        } catch (e) {
          this.fail("tick", e);
        } finally {
          this.busy = false;
        }
      }
      if (!this.stopped) this.timer = setTimeout(loop, (this.d.tickMs ?? 900) * (0.7 + 0.6 * this.d.rnd()));
    };
    // spread the agents out so they do not all act in the same instant
    this.timer = setTimeout(loop, 200 + 900 * this.d.rnd());
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private fail(what: string, e: unknown): void {
    const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    // Two agents reaching for the same job, or answering a duel the other just won: the chain picks one, the other reverts.
    if (/is not open|is not live|has ended|already answered|not working on|challenger is dormant|has expired/.test(msg)) this.stats.raced++;
    // The contract's cap on what an agent's own key can put at risk per window: working as designed, not a failure.
    else if (/more of the agent's balance at risk/.test(msg)) this.stats.capped++;
    else {
      this.stats.errors++;
      // an unexpected failure is shown by default (once a minute per message): an agent that cannot afford gas, or whose key
      // the contract no longer honours, would otherwise just sit idle with nothing to say why
      logError(this.label, `${what} failed: ${msg.slice(0, 160)}`);
    }
    if (process.env.VERBOSE) log(this.label, `${what} failed: ${msg.slice(0, 160)}`);
  }

  private async tick(): Promise<void> {
    const snap = this.d.world.snap;
    if (!snap) return;
    const me = snap.agents.find((a) => a.id === this.agentId);
    if (!me || me.live_dormant) return;
    const ledger = BigInt(me.live_ledger);
    const { cfg, rnd } = this.d;
    const now = this.d.world.chainNow();

    // 1. a duel I am in and have not answered
    for (const duel of snap.duels) {
      if (duel.status !== "Live" || this.answered.has(duel.id)) continue;
      const mine = duel.a === me.id ? !duel.wrong_a : duel.b === me.id ? !duel.wrong_b : false;
      if (!mine || now > duel.deadline) continue;
      return this.once("duel", duel.id, this.answered, () => this.playDuel(duel, me));
    }

    // 2. a job I took and have not delivered
    for (const job of snap.jobs) {
      if (job.status === "Claimed" && job.worker === me.id && !this.worked.has(job.id) && now < job.deadline - 1) {
        return this.once("job", job.id, this.worked, () => this.doWork(job, me));
      }
    }

    // 3. a deliverable for a job I posted
    for (const job of snap.jobs) {
      if (job.status === "Submitted" && job.poster_agent === me.id && !this.reviewed.has(job.id)) {
        return this.once("review", job.id, this.reviewed, () => this.reviewDeliverable(job));
      }
    }

    // 4. a challenge I would take
    if (me.active_duels < cfg.max_duels) {
      for (const duel of snap.duels) {
        if (duel.status !== "Open" || duel.a === me.id || now > duel.created + cfg.challenge_ttl_secs) continue;
        if (duel.target !== null && duel.target !== me.id) continue;
        const challenger = snap.agents.find((a) => a.id === duel.a);
        if (!challenger || challenger.owner === me.owner || challenger.live_dormant) continue;
        if (!acceptsDuel(me.genome, me, challenger, duel, ledger)) continue;
        await sleep(rnd() * 500);
        const fresh = await this.d.chain.duel(duel.id);
        if (!fresh || fresh.status !== "Open") return;
        await this.d.chain.acceptDuel(duel.id, me.id);
        this.stats.challengesAccepted++;
        log(this.label, `accepts duel #${duel.id} (stake ${(Number(BigInt(duel.stake) / 10n ** 21n) / 1000).toFixed(3)})`);
        return;
      }
    }

    // 5. a job worth taking
    if (me.active_claims < cfg.max_claims) {
      const open = snap.jobs
        .filter((j) => j.status === "Open" && !j.barred.includes(me.id) && j.poster_owner !== me.owner && j.poster_agent !== me.id)
        .filter((j) => wantsJob(me.genome, me, { job: j, ledgerAfterBond: ledger - BigInt(j.bond) }))
        .sort((a, b) => Number(BigInt(b.bounty) - BigInt(a.bounty)));
      // Read the brief BEFORE locking a bond. An agent that claims a job it cannot read (an unreachable or untrusted host, a
      // brief that does not match its hash) would fail it, lapse and lose the bond every time.
      let job: Job | undefined;
      for (const j of open) {
        if (await this.canRead(j)) {
          job = j;
          break;
        }
      }
      if (job && ledger >= BigInt(job.bond)) {
        await sleep(rnd() * 700);
        const fresh = await this.d.chain.job(job.id);
        if (!fresh || fresh.status !== "Open") return;
        await this.d.chain.claimJob(me.id, job.id);
        this.stats.jobsClaimed++;
        log(this.label, `claims job #${job.id} "${job.title.slice(0, 40)}" for ${(Number(BigInt(job.bounty) / 10n ** 21n) / 1000).toFixed(3)}`);
        return;
      }
    }

    // 6. a fight of my own
    const mineOpen = snap.duels.some((x) => x.status === "Open" && x.a === me.id);
    if (!mineOpen && me.active_duels < cfg.max_duels && Date.now() - this.lastFight > 5_000) {
      const spare = ledger - reserve(me.genome);
      const stake = chooseStake(me.genome, spare, BigInt(cfg.min_stake), NEAR / 5n);
      if (stake > 0n && spare > stake + BigInt(cfg.duel_storage_fee)) {
        const { go, target } = picksFight(me.genome, me, snap.agents, rnd);
        if (go) {
          this.lastFight = Date.now();
          await this.d.chain.challenge(me.id, stake, target, null);
          this.stats.challengesOpened++;
          log(this.label, `opens a challenge${target ? ` against #${target}` : ""}`);
          return;
        }
      }
    }

    // 7. hire another agent for a small job
    const hiring = snap.jobs.some((j) => j.poster_agent === me.id && !["Paid", "Refunded", "Split", "Cancelled"].includes(j.status));
    if (!hiring && Date.now() - this.lastHire > 20_000 && wantsToHire(me.genome, ledger, rnd)) {
      this.lastHire = Date.now();
      await this.hire(me);
    }
  }

  /**
   * Do something about `id` once, but let a transient failure (a model error, a store read, a dropped transaction) try again,
   * up to three times. Without this, a single hiccup on a job meant the agent held its bond until the deadline lapsed and lost
   * it, and on a duel meant it never answered. A lost race or an expiry is not transient and is never retried.
   */
  private async once(kind: string, id: number, done: Set<number>, f: () => Promise<void>): Promise<void> {
    done.add(id);
    try {
      await f();
    } catch (e) {
      const key = `${kind}:${id}`;
      const n = (this.tries.get(key) ?? 0) + 1;
      this.tries.set(key, n);
      const msg = e instanceof Error ? e.message : String(e);
      const final = /is not live|is not open|has ended|already answered|not working on|deadline has passed|has expired|not in the duel|not being worked|nothing to|has not started|more of the agent's balance at risk/.test(msg);
      if (!final && n < 3) done.delete(id);
      throw e;
    }
  }

  /** Whether this job's brief can be fetched and parsed. A yes is remembered; a no is retried after half a minute. */
  private async canRead(job: Job): Promise<boolean> {
    const known = this.readable.get(job.id);
    if (known === true || (known !== undefined && Date.now() - known < 30_000)) return known === true;
    try {
      parseBrief(await this.d.store.get(job.brief_uri, job.brief_hash));
      this.readable.set(job.id, true);
      return true;
    } catch (e) {
      this.readable.set(job.id, Date.now());
      if (process.env.VERBOSE) log(this.label, `skips job #${job.id}: cannot read its brief (${(e instanceof Error ? e.message : String(e)).slice(0, 100)})`);
      return false;
    }
  }

  private async playDuel(duel: Duel, me: Agent): Promise<void> {
    const { answer, thinkMs } = await this.d.brain.answer(duel, me.genome, this.d.rnd);
    const wait = Math.max(thinkMs, (duel.live_at - this.d.world.chainNow()) * 1000 + 150);
    await sleep(wait);
    const right = await this.d.chain.answerDuel(duel.id, me.id, answer);
    this.stats.duelsAnswered++;
    if (!right) this.stats.duelsWrong++;
    log(this.label, `answers duel #${duel.id} in ${(wait / 1000).toFixed(1)}s: ${right ? "correct" : "wrong, locked out"}`);
  }

  private async doWork(job: Job, me: Agent): Promise<void> {
    const brief = parseBrief(await this.d.store.get(job.brief_uri, job.brief_hash));
    const text = await this.d.brain.write(brief, me.genome, this.d.rnd);
    await sleep(300 + me.genome.diligence * 12 * this.d.rnd());
    const blob = this.d.store.put(text);
    await this.d.chain.submitWork(me.id, job.id, blob.hash, blob.uri);
    this.stats.jobsDelivered++;
    log(this.label, `delivers job #${job.id}`);
  }

  private async reviewDeliverable(job: Job): Promise<void> {
    const brief = parseBrief(await this.d.store.get(job.brief_uri, job.brief_hash));
    const text = await this.d.store.get(job.sub_uri, job.sub_hash);
    const g = await this.d.brain.review(brief, text);
    if (g.pass) {
      await this.d.chain.acceptWork(job.id);
      log(this.label, `accepts job #${job.id} (score ${g.score})`);
    } else {
      await this.d.chain.rejectWork(job.id, g.reasons.join("; "));
      log(this.label, `rejects job #${job.id}: ${g.reasons.join("; ")}`);
    }
  }

  private async hire(me: Agent): Promise<void> {
    const brief = makeBrief(Math.floor(this.d.rnd() * 1000), 3);
    const blob = this.d.store.put(briefText(brief));
    // sized from the contract's own limits: a hard-coded 60 seconds is below the real configuration's minimum work window
    const min = BigInt(this.d.cfg.min_bounty);
    const bounty = (NEAR * 12n) / 100n > min ? (NEAR * 12n) / 100n : min;
    const workSecs = Math.min(this.d.cfg.max_work_secs, Math.max(60, this.d.cfg.min_work_secs));
    const id = await this.d.chain.postJobAsAgent(me.id, {
      title: `Sub-task: ${brief.topic}`.slice(0, 78), briefUri: blob.uri, briefHash: blob.hash, bounty, workSecs,
    });
    this.stats.hired++;
    log(this.label, `hires: posts job #${id} from its own balance`);
  }
}
