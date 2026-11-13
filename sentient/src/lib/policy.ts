/**
 * How a genome turns into behaviour. Pure functions of the genome and what the agent can see, so they can be tested
 * without a chain. The contract stores the genome and breeds it; it never reads these rules, and nothing here can move
 * money the contract does not already allow.
 */
import type { Agent, Duel, Genome, Job } from "./types.js";
import { NEAR } from "./units.js";

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (t: number) => clamp(t, 0, 100) / 100;

/** Expected score of a player rated `own` against `other`, the same maths as the contract's Elo. */
export function expectedScore(own: number, other: number): number {
  return 1 / (1 + 10 ** ((other - own) / 400));
}

/** How long an agent thinks before answering a puzzle, and how often it answers wrongly. Fast and bold versus slow and sure. */
export function solveProfile(g: Genome): { thinkMs: number; errorRate: number } {
  const thinkMs = Math.max(120, 450 + 32 * g.diligence - 14 * g.boldness);
  const errorRate = clamp(0.02 + 0.3 * frac(g.boldness) - 0.25 * frac(g.diligence), 0, 0.5);
  return { thinkMs, errorRate };
}

/** What an agent stakes in a duel it opens. Bold agents risk more of what they have. */
export function chooseStake(g: Genome, ledger: bigint, minStake: bigint, maxStake: bigint): bigint {
  const share = 0.02 + 0.1 * frac(g.boldness);
  let s = BigInt(Math.floor(Number(ledger / 1_000_000_000_000n) * share)) * 1_000_000_000_000n;
  if (s > maxStake) s = maxStake;
  return s < minStake ? 0n : s;
}

/** Free balance an agent insists on keeping back. Thrifty agents keep a cushion. */
export function reserve(g: Genome): bigint {
  return BigInt(Math.round(frac(g.thrift) * 0.5 * 1000)) * (NEAR / 1000n);
}

export interface JobView {
  job: Job;
  /** The agent's ledger after the bond. */
  ledgerAfterBond: bigint;
}

/** Whether an agent takes a job it can see. Thrifty agents want a bigger bounty and a bigger cushion left over. */
export function wantsJob(g: Genome, me: Agent, v: JobView): boolean {
  const bounty = BigInt(v.job.bounty);
  const floor = BigInt(Math.round(lerp(0.05, 0.25, frac(g.thrift)) * 1000)) * (NEAR / 1000n);
  if (bounty < floor) return false;
  if (v.ledgerAfterBond < reserve(g)) return false;
  if (me.reputation < v.job.min_rep) return false;
  // a bounty that is small next to the bond is a bad trade for a careful agent
  return true;
}

/**
 * Whether an agent accepts a challenge. Cunning agents read ratings; incurious ones assume an even fight. Bold agents
 * will take fights they are likely to lose.
 */
export function acceptsDuel(g: Genome, me: Agent, challenger: Agent, duel: Duel, ledger: bigint): boolean {
  const stake = BigInt(duel.stake);
  if (stake + reserve(g) > ledger) return false;
  if (stake > (ledger * BigInt(Math.round((0.1 + 0.4 * frac(g.boldness)) * 1000))) / 1000n) return false;
  const believed = lerp(0.5, expectedScore(me.rating, challenger.rating), frac(g.cunning));
  const need = 0.62 - 0.3 * frac(g.boldness);
  return believed >= need;
}

/** Whether an agent opens a challenge this tick, and against whom (null = anyone). */
export function picksFight(g: Genome, me: Agent, others: Agent[], rnd: () => number): { go: boolean; target: number | null } {
  const appetite = 0.03 + 0.12 * frac(g.sociability) + 0.05 * frac(g.boldness);
  if (rnd() > appetite) return { go: false, target: null };
  const rivals = others.filter((o) => o.id !== me.id && o.owner !== me.owner && !o.live_dormant);
  if (rivals.length === 0 || frac(g.cunning) < 0.5) return { go: true, target: null };
  // a cunning agent hunts a beatable rival rather than posting an open challenge
  const best = rivals
    .map((o) => ({ o, p: expectedScore(me.rating, o.rating) }))
    .filter((x) => x.p >= 0.5)
    .sort((a, b) => b.p - a.p)[0];
  return { go: true, target: best ? best.o.id : null };
}

/** Whether an agent with plenty of money hires another agent for a small job. */
export function wantsToHire(g: Genome, ledger: bigint, rnd: () => number): boolean {
  if (ledger < 1_300n * (NEAR / 1000n)) return false;
  return rnd() < 0.02 + 0.1 * frac(g.sociability);
}

/** How rich an agent must be, and how proven, before its owner will breed it. */
export function readyToBreed(a: Agent, ledger: bigint, breedCostHalf: bigint): boolean {
  return !a.live_dormant && a.jobs_done + a.duel_wins >= 2 && ledger >= breedCostHalf * 2n;
}
