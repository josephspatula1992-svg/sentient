import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore: plain JS module shared with the browser
import * as model from "../web/model.js";
import { slimAgent as tsSlimAgent, slimJob as tsSlimJob, slimDuel as tsSlimDuel, Recorder } from "../src/lib/record.js";
import type { Agent, Duel, Job } from "../src/lib/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const contractSrc = path.resolve(here, "../../contracts/sentient/src");

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 1, owner: "alice.test", account: "a1.sentient.test", key: "ed25519:x", key_bound: true, operator: null, name: "Ada", persona: "p",
  genome: { diligence: 60, boldness: 60, thrift: 60, sociability: 60, cunning: 60 }, generation: 0, parents: null, born: 100, dormant: false,
  revivals: 0, ledger: "1660000000000000000000000", locked: "0", last_upkeep: 100, jobs_done: 0, jobs_failed: 0, duel_wins: 0, duel_losses: 0,
  earned: "0", lost: "0", upkeep_paid: "0", reputation: 0, rating: 1000, breed_ready_at: 100, risk_bps: 6000, win_start: 100, win_base: "0", win_lost: "0", stud_fee: null, offspring: 0, active_claims: 0,
  active_duels: 0, shares: 0, reserve: "0", div_acc: "0", div_pool: "0", last_active: 100, live_ledger: "1660000000000000000000000",
  live_dormant: false, runway_secs: 300, share_price: "11000000000000000000000", ...over,
});

test("amounts format without losing precision", () => {
  assert.equal(model.fmtNear("1660000000000000000000000"), "1.660");
  assert.equal(model.fmtNear(0n), "0.000");
  assert.equal(model.fmtNear("-500000000000000000000000"), "-0.500");
  assert.equal(model.fmtNear("999999999999999999999999"), "0.999");
});

test("every event the contract can emit has words in the dashboard", () => {
  const kinds = new Set<string>();
  for (const f of readdirSync(contractSrc).filter((x) => x.endsWith(".rs") && x !== "tests.rs")) {
    for (const m of readFileSync(path.join(contractSrc, f), "utf8").matchAll(/emit\(\s*"([a-z_]+)"/g)) kinds.add(m[1]);
  }
  assert.ok(kinds.size >= 20, `found only ${kinds.size} event kinds`);
  const missing = [...kinds].filter((k) => model.describeEvent({ kind: k, a: 1, b: 2, amount: "1", note: "" }, (id: number) => `#${id}`).icon === "·");
  assert.deepEqual(missing, [], "event kinds the dashboard would show as raw text");
});

test("the browser's slim shapes equal the recorder's", () => {
  const a = agent({ parents: [1, 2], generation: 1, runway_secs: 5_000_000 });
  const { persona: _p, ...fromJs } = model.slimAgent(a);
  assert.deepEqual(fromJs, tsSlimAgent(a));
  const job = { id: 3, poster: "p.test", poster_owner: "p.test", poster_agent: null, title: "t", brief_uri: "u", brief_hash: "h", bounty: "5", bond: "1", min_rep: -1000, work_secs: 60, status: "Open", posted: 1, worker: null, claimed_at: 0, deadline: 0, sub_hash: "", sub_uri: "", submitted_at: 0, dispute_reason: "", disputed_at: 0, barred: [], attempts: 0, settled_at: 0, paid_worker: "0" } as Job;
  assert.deepEqual(model.slimJob(job), tsSlimJob(job));
  const duel = { id: 1, kind: 2, params: [1, 0, 0, 0], question: "q", a: 1, b: 2, target: null, stake: "9", status: "Live", created: 1, live_at: 2, deadline: 3, wrong_a: false, wrong_b: true, winner: null, rating_swing: 0, settled_at: 0 } as Duel;
  assert.deepEqual(model.slimDuel(duel), tsSlimDuel(duel));
});

test("ids and traits from an untrusted contract cannot carry markup into the page", () => {
  const hostile = agent({ id: '1"><img src=x onerror=alert(1)>' as unknown as number, genome: { diligence: "<b>" as unknown as number, boldness: 1, thrift: 1, sociability: 1, cunning: 1 }, parents: ["<i>", "2"] as unknown as [number, number] });
  const s = model.slimAgent(hostile);
  assert.ok(Number.isNaN(s.id) && Number.isNaN(s.genome.diligence) && Number.isNaN(s.parents?.[0]));
  assert.equal(JSON.stringify(s).includes("<"), false, "no numeric field can still hold markup");
  const j = model.slimJob({ id: "x\"", worker: "<", poster_agent: null, bounty: "1", status: "Open" } as never);
  assert.ok(Number.isNaN(j.id) && Number.isNaN(j.worker));
});

test("nothing a node returns reaches a class attribute or an innerHTML as anything but a number or a harmless token", () => {
  const evil = '"><img src=x onerror=alert(1)>';
  const a: Record<string, unknown> = model.slimAgent({ ...agent(), reputation: evil, rating: evil, duel_wins: evil, jobs_done: evil, shares: evil, revivals: evil, offspring: evil, live_ledger: evil, earned: evil, share_price: evil } as never);
  for (const k of ["reputation", "rating", "duelWins", "jobsDone", "shares", "revivals", "offspring"]) assert.ok(Number.isNaN(a[k]), k);
  for (const k of ["ledger", "earned", "price"]) assert.equal(a[k], "0", k);
  const j = model.slimJob({ id: 1, status: `Open${evil}`, bounty: evil, posted: evil, attempts: evil, paid_worker: evil } as never);
  assert.equal(j.status, "Openimgsrcxonerroralert".slice(0, 16).replace(/[^A-Za-z]/g, ""), "letters only, at most 16");
  assert.ok(/^[A-Za-z]*$/.test(j.status));
  assert.equal(j.bounty, "0");
  const d = model.slimDuel({ id: 1, status: evil, stake: evil, rating_swing: evil } as never);
  assert.ok(/^[A-Za-z]*$/.test(d.status) && d.stake === "0" && Number.isNaN(d.swing));
  const f = model.slimFeed({ seq: 5, ts: 1, kind: `job_paid${evil}`, a: evil, b: 2, amount: evil, note: "ok" });
  assert.ok(/^[a-z_]*$/.test(f.kind) && f.amount === "0" && Number.isNaN(f.a) && f.seq === 5);
  // the legitimate shapes pass through unchanged
  assert.equal(model.slimFeed({ seq: 1, ts: 2, kind: "job_paid", a: 3, b: 4, amount: "123", note: "n" }).kind, "job_paid");
  assert.equal(model.slimJob({ id: 1, status: "Disputed", bounty: "5", posted: 1, attempts: 0, paid_worker: "0" } as never).status, "Disputed");
});

test("a recording of deltas folds back into complete states", () => {
  const rec = new Recorder();
  const snap = (agents: Agent[], now: number) => ({
    at: Date.now(), agents, jobs: [], duels: [], feed: [], stats: { agents: agents.length, alive: agents.length, dormant: 0, jobs: 0, open_jobs: 0, duels: 0, live_duels: 0, generations: 0, feed_seq: 0, now },
  });
  rec.push(snap([agent({ id: 1 }), agent({ id: 2, name: "Bram", account: "a2.sentient.test" })], 100));
  rec.push(snap([agent({ id: 1 }), agent({ id: 2, name: "Bram", account: "a2.sentient.test", live_ledger: "1" })], 101));
  rec.push(snap([agent({ id: 1, live_dormant: true }), agent({ id: 2, name: "Bram", account: "a2.sentient.test", live_ledger: "1" })], 102));
  assert.equal(rec.frames[1].agents.length, 1, "only the agent that changed is stored");
  const tl = model.buildTimeline({ frames: rec.frames });
  assert.equal(tl.states.length, 3);
  assert.equal(tl.states[1].agents.length, 2, "the fold restores the one that did not change");
  assert.equal(tl.states[2].agents.find((a: { id: number }) => a.id === 1).dormant, true);
  assert.equal(tl.states[0].agents.find((a: { id: number }) => a.id === 1).persona, "p", "the persona is stored once and carried forward");
  assert.deepEqual(tl.marks.map((m: { kind: string }) => m.kind), ["minted", "minted", "died"]);
  // frames pushed in the same millisecond share a time, and the lookup then returns the last of them
  assert.ok(model.frameIndexAt(tl.states, tl.states[1].t) >= 1);
  assert.equal(model.frameIndexAt(tl.states, -5), 0);
});

test("the dashboard's picture of an agent is the contract's picture", () => {
  // The contract draws the NFT image in art.rs; e2e compares this against a real token. Here: stable and sensitive.
  const g = { diligence: 90, boldness: 10, thrift: 10, sociability: 10, cunning: 10 };
  const svg = model.genomeSvg(1, g, false);
  assert.ok(svg.startsWith("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>"));
  assert.notEqual(svg, model.genomeSvg(1, g, true));
  assert.notEqual(svg, model.genomeSvg(1, { ...g, diligence: 10, boldness: 90 }, false));
  assert.notEqual(svg, model.genomeSvg(2, g, false));
});

test("summary, leaderboard and activity read a state correctly", () => {
  const a1 = model.slimAgent(agent({ id: 1, earned: "3000000000000000000000000", lost: "1000000000000000000000000" }));
  const a2 = model.slimAgent(agent({ id: 2, name: "Bram", live_dormant: true, earned: "1000000000000000000000000" }));
  const state = {
    t: 0, now: 0, stats: { jobs: 4, duels: 2 }, agents: [a1, a2], feed: [], totals: null,
    jobs: [{ id: 1, status: "Claimed", worker: 1, posterAgent: null }, { id: 2, status: "Paid", worker: 2, posterAgent: null }],
    duels: [{ id: 1, status: "Open", a: 2, b: null }],
  };
  const s = model.summarize(state);
  assert.deepEqual([s.alive, s.dormant, s.jobsPaid, s.jobsOpen], [1, 1, 1, 0]);
  assert.equal(model.leaderboard(state)[0].a.id, 1);
  assert.equal(model.activityOf(state, 1)?.kind, "job");
  assert.equal(model.activityOf(state, 2)?.kind, "challenge");
});
