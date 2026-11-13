import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acceptsDuel, chooseStake, expectedScore, picksFight, readyToBreed, solveProfile, wantsJob, wantsToHire } from "../src/lib/policy.js";
import { grade, makeBrief, mockDeliverable, briefText, parseBrief, TOPICS } from "../src/lib/jobs.js";
import { ArtifactStore, sha256 } from "../src/lib/store.js";
import { MockBrain, LlmBrain } from "../src/lib/brain.js";
import { solve } from "../src/lib/puzzle.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { Chair, Market, Owner } from "../src/agents/actors.js";
import { fastConfig, liveConfig, nstr } from "../src/lib/defaults.js";
import { NEAR, fmt } from "../src/lib/units.js";
import type { Agent, Duel, Genome, Job } from "../src/lib/types.js";

const G = (diligence: number, boldness: number, thrift: number, sociability: number, cunning: number): Genome => ({ diligence, boldness, thrift, sociability, cunning });

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 1, owner: "a.test", account: "a1.s.test", key: "k", key_bound: true, operator: null, name: "A", persona: "", genome: G(60, 60, 60, 60, 60),
  generation: 0, parents: null, born: 0, dormant: false, revivals: 0, ledger: String(NEAR), locked: "0", last_upkeep: 0, jobs_done: 0, jobs_failed: 0,
  duel_wins: 0, duel_losses: 0, earned: "0", lost: "0", upkeep_paid: "0", reputation: 0, rating: 1000, breed_ready_at: 0, risk_bps: 6000, win_start: 0, win_base: "0", win_lost: "0", stud_fee: null,
  offspring: 0, active_claims: 0, active_duels: 0, shares: 0, reserve: "0", div_acc: "0", div_pool: "0", last_active: 0,
  live_ledger: String(NEAR), live_dormant: false, runway_secs: 100, share_price: "1", ...over,
});

const job = (bounty: bigint, over: Partial<Job> = {}): Job => ({
  id: 1, poster: "p", poster_owner: "p", poster_agent: null, title: "t", brief_uri: "", brief_hash: "", bounty: String(bounty), bond: String(bounty / 10n),
  min_rep: -1000, work_secs: 60, status: "Open", posted: 0, worker: null, claimed_at: 0, deadline: 0, sub_hash: "", sub_uri: "", submitted_at: 0,
  dispute_reason: "", disputed_at: 0, barred: [], attempts: 0, settled_at: 0, paid_worker: "0", ...over,
});

const duel = (stake: bigint): Duel => ({
  id: 1, kind: 0, params: [2, 10, 1000, 0], question: "q", a: 2, b: null, target: null, stake: String(stake), status: "Open", created: 0, live_at: 0,
  deadline: 0, wrong_a: false, wrong_b: false, winner: null, rating_swing: 0, settled_at: 0,
});

// ── policy ──

test("bold agents answer fast and wrongly more often, diligent ones slow and rightly", () => {
  const bold = solveProfile(G(10, 100, 50, 50, 50));
  const careful = solveProfile(G(100, 10, 50, 50, 50));
  assert.ok(bold.thinkMs < careful.thinkMs / 3, `${bold.thinkMs} vs ${careful.thinkMs}`);
  assert.ok(bold.errorRate > careful.errorRate + 0.2);
  assert.ok(careful.errorRate <= 0.05);
  for (const g of [G(0, 0, 0, 0, 0), G(100, 100, 100, 0, 0), G(0, 100, 0, 100, 100)]) {
    const p = solveProfile(g);
    assert.ok(p.thinkMs >= 120 && p.errorRate >= 0 && p.errorRate <= 0.5);
  }
});

test("thrifty agents refuse thin jobs and keep a cushion", () => {
  const me = agent();
  const miser = G(60, 20, 100, 20, 60);
  const spender = G(60, 20, 0, 20, 60);
  const thin = job(NEAR / 10n);
  assert.equal(wantsJob(spender, me, { job: thin, ledgerAfterBond: NEAR }), true);
  assert.equal(wantsJob(miser, me, { job: thin, ledgerAfterBond: NEAR }), false);
  const fat = job(NEAR / 2n);
  assert.equal(wantsJob(miser, me, { job: fat, ledgerAfterBond: NEAR }), true);
  assert.equal(wantsJob(miser, me, { job: fat, ledgerAfterBond: NEAR / 10n }), false, "no cushion left");
  assert.equal(wantsJob(spender, agent({ reputation: -3 }), { job: job(NEAR / 2n, { min_rep: 0 }), ledgerAfterBond: NEAR }), false, "below the poster's floor");
});

test("cunning agents read ratings; incurious ones assume an even fight; bold ones take worse odds", () => {
  const strongRival = agent({ id: 2, rating: 1400 });
  const me = agent({ rating: 1000 });
  const stake = NEAR / 20n;
  const cunning = G(50, 20, 50, 50, 100);
  const naive = G(50, 20, 50, 50, 0);
  assert.equal(acceptsDuel(cunning, me, strongRival, duel(stake), NEAR), false, "sees it would lose");
  assert.equal(acceptsDuel(naive, me, strongRival, duel(stake), NEAR), false, "even odds need 0.62 for a timid agent");
  assert.equal(acceptsDuel(G(50, 100, 50, 50, 0), me, strongRival, duel(stake), NEAR), true, "a bold agent takes an even fight");
  assert.equal(acceptsDuel(cunning, agent({ rating: 1400 }), agent({ id: 2, rating: 1000 }), duel(stake), NEAR), true);
  assert.equal(acceptsDuel(G(50, 100, 50, 50, 0), me, strongRival, duel(NEAR), NEAR), false, "never stakes more than it can bear");
});

test("stakes scale with boldness and never exceed the cap", () => {
  const lo = chooseStake(G(50, 0, 50, 50, 50), NEAR, NEAR / 100n, NEAR / 5n);
  const hi = chooseStake(G(50, 100, 50, 50, 50), NEAR, NEAR / 100n, NEAR / 5n);
  assert.ok(hi > lo && hi <= NEAR / 5n);
  assert.equal(chooseStake(G(50, 0, 50, 50, 50), NEAR / 100n, NEAR / 100n, NEAR / 5n), 0n, "too poor to stake the minimum");
  assert.equal(chooseStake(G(50, 100, 50, 50, 50), 100n * NEAR, NEAR / 100n, NEAR / 5n), NEAR / 5n);
});

test("elo expectation is symmetric", () => {
  assert.ok(Math.abs(expectedScore(1000, 1000) - 0.5) < 1e-9);
  assert.ok(Math.abs(expectedScore(1200, 1000) + expectedScore(1000, 1200) - 1) < 1e-9);
});

test("fights and hiring follow sociability", () => {
  const rivals = [agent({ id: 2, owner: "b", rating: 800 }), agent({ id: 3, owner: "c", rating: 1300 })];
  let social = 0, loner = 0;
  for (let i = 0; i < 2000; i++) {
    const r = Math.random;
    if (picksFight(G(50, 50, 50, 100, 0), agent(), rivals, r).go) social++;
    if (picksFight(G(50, 50, 50, 0, 0), agent(), rivals, r).go) loner++;
  }
  assert.ok(social > loner * 1.5, `${social} vs ${loner}`);
  const hunt = picksFight(G(50, 50, 50, 100, 100), agent(), rivals, () => 0);
  assert.deepEqual(hunt, { go: true, target: 2 }, "a cunning agent goes after the one it can beat");
  assert.equal(wantsToHire(G(50, 50, 50, 100, 50), NEAR / 2n, () => 0), false, "too poor to hire");
  assert.equal(wantsToHire(G(50, 50, 50, 100, 50), 2n * NEAR, () => 0), true);
});

test("breeding needs a proven, solvent, living agent", () => {
  const half = NEAR / 2n;
  assert.equal(readyToBreed(agent({ jobs_done: 2 }), NEAR, half), true);
  assert.equal(readyToBreed(agent({ jobs_done: 1 }), NEAR, half), false);
  assert.equal(readyToBreed(agent({ duel_wins: 1, jobs_done: 1 }), NEAR / 2n, half), false);
  assert.equal(readyToBreed(agent({ jobs_done: 5, live_dormant: true }), NEAR, half), false);
});

// ── jobs and the rubric ──

test("the rubric passes complete on-topic work and fails placeholders and shortfalls", () => {
  const brief = makeBrief(0, 4);
  const good = mockDeliverable(brief, G(100, 0, 50, 50, 50), () => 0.99);
  assert.equal(grade(brief, good).pass, true);
  assert.equal(grade(brief, "- TODO\n- placeholder").pass, false);
  const short = good.split("\n").slice(0, 2).join("\n");
  const g = grade(brief, short);
  assert.equal(g.pass, false);
  assert.match(g.reasons.join(";"), /only 2 of 4 bullets/);
  assert.equal(grade(brief, good.replace(new RegExp(brief.keyword, "g"), "thing")).pass, false, "every bullet must carry the keyword");
  assert.equal(grade(brief, "- nothing relevant here\n- nor here\n- nor here\n- nor here").pass, false);
});

test("a diligent agent delivers good work and a hothead sometimes does not", () => {
  const brief = makeBrief(3, 4);
  const trial = (g: Genome) => {
    let pass = 0;
    let s = 7;
    const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 400; i++) if (grade(brief, mockDeliverable(brief, g, rnd)).pass) pass++;
    return pass / 400;
  };
  const clerk = trial(G(100, 20, 60, 30, 50));
  const hothead = trial(G(15, 100, 10, 60, 10));
  assert.ok(clerk > 0.99, `clerk ${clerk}`);
  assert.ok(hothead < 0.8 && hothead > 0.3, `hothead ${hothead}`);
});

test("a brief survives the round trip through its text, and bad ones are refused", () => {
  const b = makeBrief(5, 3);
  assert.deepEqual(parseBrief(briefText(b)), b);
  assert.throws(() => parseBrief("{}"), /malformed/);
  assert.equal(TOPICS.length >= 10, true);
});

// ── brains ──

test("the mock brain solves exactly, then slows and spoils by temperament", async () => {
  const brain = new MockBrain();
  const d = { ...duel(NEAR), kind: 0, params: [2, 10, 1000, 0] as [number, number, number, number] };
  const right = solve(0, d.params)!;
  const careful = await brain.answer(d, G(100, 0, 50, 50, 50), () => 0.99);
  assert.equal(careful.answer, right);
  const spoiled = await brain.answer(d, G(0, 100, 50, 50, 50), () => 0.0);
  assert.notEqual(spoiled.answer, right, "a bold agent that rolls badly answers wrongly");
  assert.ok(spoiled.thinkMs < careful.thinkMs);
  assert.equal((await brain.review(makeBrief(0, 3), "- TODO")).pass, false);
});

test("the model-backed brain asks the model and parses an integer out of whatever it says", async () => {
  const seen: string[] = [];
  const brain = new LlmBrain("stub", async (system, user) => { seen.push(`${system}|${user}`); return "The answer is 1,024."; });
  const out = await brain.answer({ ...duel(NEAR), question: "Compute 2^10." }, G(80, 20, 50, 50, 50));
  assert.equal(out.answer, 1024);
  assert.match(seen[0], /Compute 2\^10/);
  const bad = new LlmBrain("stub", async () => "I do not know");
  await assert.rejects(bad.answer(duel(NEAR), G(50, 50, 50, 50, 50)), /number/);
  const written = await new LlmBrain("stub", async () => "- a\n- b").write(makeBrief(1, 2), G(60, 20, 50, 50, 50));
  assert.equal(written, "- a\n- b");
});

// ── the store ──

test("the artifact store is content-addressed and refuses a mismatch or a stray path", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sent-store-"));
  try {
    const store = new ArtifactStore(dir);
    const blob = store.put("hello");
    assert.equal(blob.hash, sha256("hello"));
    assert.equal(await store.get(blob.uri, blob.hash), "hello");
    await assert.rejects(store.get(blob.uri, sha256("other")), /does not match/);
    const stray = path.join(dir, "..", `${"a".repeat(64)}.txt`);
    writeFileSync(stray, "secret");
    await assert.rejects(store.get(pathToFileURL(stray).toString()), /outside/);
    rmSync(stray);
    await assert.rejects(store.get("https://evil.example/a/" + "a".repeat(64)), /not trusted/);
    await assert.rejects(store.get("ftp://x"), /unsupported/);
    assert.throws(() => store.put("x".repeat(200_000)), /too large/);
    assert.equal(store.hasHex(blob.hash.slice(7)), true);
    assert.equal(store.hasHex("zz"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a store fetches artifacts only from hosts it was told to trust, and only at the exact artifact path", async () => {
  const { createServer } = await import("node:http");
  const body = "a brief written on another machine";
  const hash = sha256(body);
  const hex = hash.slice("sha256:".length);
  const origin = createServer((req, res) => {
    if (req.url === `/a/${hex}`) res.writeHead(200, { "content-type": "text/plain" }).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => origin.listen(0, () => r()));
  const host = `127.0.0.1:${(origin.address() as { port: number }).port}`;
  const dir = mkdtempSync(path.join(tmpdir(), "sent-store2-"));
  try {
    const uri = `http://${host}/a/${hex}`;
    assert.equal(await new ArtifactStore(dir, "", [host]).get(uri, hash), body, "a trusted host is read and checked against the hash");
    await assert.rejects(new ArtifactStore(dir).get(uri), /not trusted/, "an unlisted host is not");
    await assert.rejects(new ArtifactStore(dir, "", [host]).get(uri, sha256("something else")), /does not match/);
    await assert.rejects(new ArtifactStore(dir, "", [host]).get(`http://${host}/a/${hex}?x=1`), /not trusted/, "no query strings");
    await assert.rejects(new ArtifactStore(dir, "", [host]).get(`http://user:pw@${host}/a/${hex}`), /not trusted/, "no credentials in the url");
    await assert.rejects(new ArtifactStore(dir, "", [host]).get(`http://${host}/other`), /not trusted/, "only the artifact path");
  } finally {
    origin.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the runtime's handling of failure and of the contract's limits ──

function runtimeWith(chain: Record<string, unknown>, over: { duels?: Duel[]; cfg?: ReturnType<typeof fastConfig> } = {}) {
  const me = agent({ id: 1, genome: G(0, 100, 0, 0, 0) });
  const cfg = over.cfg ?? fastConfig("c.near");
  const snap = {
    at: Date.now(), agents: [me], jobs: [], duels: over.duels ?? [],
    feed: [], stats: { agents: 1, alive: 1, dormant: 0, jobs: 0, open_jobs: 0, duels: 1, live_duels: 1, generations: 0, feed_seq: 0, now: 100 },
  };
  const world = { snap, chainNow: () => 100, cfg } as never;
  const dir = mkdtempSync(path.join(tmpdir(), "sent-rt-"));
  const rt = new AgentRuntime(1, "Ada", { chain: chain as never, world, store: new ArtifactStore(dir), brain: new MockBrain(), cfg, rnd: () => 0.99, tickMs: 10 });
  return { rt, me, tick: () => (rt as unknown as { tick(): Promise<void> }).tick(), hire: () => (rt as unknown as { hire(a: Agent): Promise<void> }).hire(me), dir };
}

const liveDuel = (): Duel => ({ ...duel(NEAR / 100n), id: 7, status: "Live", a: 1, b: 2, live_at: 0, deadline: 1_000, kind: 4, params: [123_456, 654_321, 0, 0] });

test("a transient failure answering a duel is retried, so one hiccup does not forfeit it", async () => {
  let calls = 0;
  const { tick, dir } = runtimeWith({ answerDuel: async () => { calls++; if (calls === 1) throw new Error("rpc timeout"); return true; } }, { duels: [liveDuel()] });
  try {
    await assert.rejects(tick(), /rpc timeout/);
    await tick();
    await tick();
    assert.equal(calls, 2, "tried again after the failure, and then left the answered duel alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lost race or an expiry is not retried, and a persistent failure stops after three tries", async () => {
  let raced = 0;
  const a = runtimeWith({ answerDuel: async () => { raced++; throw new Error("Smart contract panicked: the duel is not live"); } }, { duels: [liveDuel()] });
  let down = 0;
  const b = runtimeWith({ answerDuel: async () => { down++; throw new Error("node unreachable"); } }, { duels: [liveDuel()] });
  try {
    await assert.rejects(a.tick(), /not live/);
    await a.tick();
    assert.equal(raced, 1, "the duel was already over: asking again is pointless");
    for (let i = 0; i < 5; i++) await b.tick().catch(() => {});
    assert.equal(down, 3, "three tries and then it gives up");
  } finally {
    rmSync(a.dir, { recursive: true, force: true });
    rmSync(b.dir, { recursive: true, force: true });
  }
});

test("an agent that hires sizes the job from the contract's limits, not from the fast configuration's", async () => {
  const posted: Array<{ workSecs: number; bounty: bigint }> = [];
  const chain = { postJobAsAgent: async (_id: number, a: { workSecs: number; bounty: bigint }) => { posted.push(a); return 5; } };
  const live = runtimeWith(chain, { cfg: liveConfig("c.near") });
  const strict = runtimeWith(chain, { cfg: { ...liveConfig("c.near"), min_bounty: nstr(0.5) } });
  try {
    await live.hire();
    await strict.hire();
    assert.equal(posted[0].workSecs, 600, "the real configuration's minimum work window");
    assert.equal(posted[0].bounty, (NEAR * 12n) / 100n);
    assert.equal(posted[1].bounty, NEAR / 2n, "never below the contract's minimum bounty");
  } finally {
    rmSync(live.dir, { recursive: true, force: true });
    rmSync(strict.dir, { recursive: true, force: true });
  }
});

test("a model that shows its working is read by its last number, and an unsafe integer is refused", async () => {
  const d = duel(NEAR / 100n);
  const g = G(60, 20, 50, 50, 50);
  const working = new LlmBrain("stub", async () => "Let me compute 12 x 34 = 408.\nAnswer: 408");
  assert.equal((await working.answer(d, g)).answer, 408);
  const huge = new LlmBrain("stub", async () => "99999999999999999999");
  await assert.rejects(huge.answer(d, g), /safe integer/);
});

// ── failures are visible, and not a flood ──

test("an unexpected failure is shown, once a minute per source and message", async () => {
  const { logError } = await import("../src/lib/log.js");
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    const t = 1_000_000;
    assert.equal(logError("agent-x", "no gas", 60_000, t), true);
    assert.equal(logError("agent-x", "no gas", 60_000, t + 10_000), false, "the same failure again within a minute is not repeated");
    assert.equal(logError("agent-y", "no gas", 60_000, t + 10_000), true, "another source is its own");
    assert.equal(logError("agent-x", "different", 60_000, t + 10_000), true, "another message is its own");
    assert.equal(logError("agent-x", "no gas", 60_000, t + 61_000), true, "after a minute it is shown again");
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 4);
  assert.match(lines[0], /agent-x\s+error: no gas/);
});

test("an agent's unexpected failure is counted and shown, while a lost race is counted and not", async () => {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  const { rt, dir } = runtimeWith({});
  try {
    const fail = (e: unknown) => (rt as unknown as { fail(w: string, e: unknown): void }).fail("tick", e);
    fail(new Error("Smart contract panicked: the job is not open"));
    fail(new Error("Not enough balance for a1.sentient.near (balance: 1, cost: 5)"));
    assert.deepEqual([rt.stats.raced, rt.stats.errors], [1, 1]);
    assert.equal(lines.filter((l) => /error:/.test(l)).length, 1);
    assert.match(lines.join("\n"), /Not enough balance/);
    assert.doesNotMatch(lines.join("\n"), /is not open/);
  } finally {
    console.log = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the actors around the agents ──

const stepOf = (x: unknown) => () => (x as { step(): Promise<void> }).step();

function submittedJob(store: ArtifactStore, status: Job["status"], poster = "p.test"): Job {
  const brief = makeBrief(0, 3);
  const b = store.put(briefText(brief));
  const s = store.put(mockDeliverable(brief, G(100, 0, 50, 50, 50), () => 0.99));
  return job(NEAR / 2n, { id: 9, status, poster, worker: 1, brief_uri: b.uri, brief_hash: b.hash, sub_uri: s.uri, sub_hash: s.hash, submitted_at: 50 });
}

test("the chair gives up on a ruling the contract will not accept after three tries, instead of retrying it for ever", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sent-chair-"));
  try {
    const store = new ArtifactStore(dir);
    let calls = 0;
    const chain = { resolveDispute: async () => { calls++; throw new Error("the chair is a party to this job"); } };
    const chair = new Chair(chain as never, { snap: { jobs: [submittedJob(store, "Disputed")] } } as never, store, new MockBrain(), () => 0.5);
    for (let i = 0; i < 6; i++) await stepOf(chair)().catch(() => {});
    assert.equal(calls, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the market retries a review that failed, marks it reviewed only once it went through, and posts inside the contract's work window", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sent-market-"));
  try {
    const store = new ArtifactStore(dir);
    let accepts = 0;
    const chain = { accountId: "p.test", acceptWork: async () => { accepts++; if (accepts === 1) throw new Error("rpc timeout"); } };
    const opts = { everyMs: 1000, minBounty: NEAR / 10n, maxBounty: NEAR / 5n, maxOpen: 0, workSecs: 60 };
    const reviewing = new Market([chain as never], { snap: { jobs: [submittedJob(store, "Submitted")] }, cfg: fastConfig("c.near") } as never, store, new MockBrain(), opts, () => 0);
    await assert.rejects(stepOf(reviewing)(), /rpc timeout/);
    await stepOf(reviewing)();
    await stepOf(reviewing)();
    assert.equal(accepts, 2, "tried again after the failure, then left the reviewed job alone");

    let posted: { workSecs: number } | undefined;
    const poster = { accountId: "p.test", postJob: async (a: { workSecs: number }) => { posted = a; return 1; } };
    const posting = new Market([poster as never], { snap: { jobs: [] }, cfg: liveConfig("c.near") } as never, store, new MockBrain(), { ...opts, maxOpen: 5 }, () => 0);
    await stepOf(posting)();
    assert.equal(posted?.workSecs, 600, "the real configuration's minimum, not the 60 seconds asked for");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner revives a dying agent a few times and then gives up on it", async () => {
  const cfg = fastConfig("c.near");
  let revives = 0;
  const chain = { nativeBalance: async () => 10n * NEAR, revive: async () => { revives++; }, refuel: async () => {} };
  const dormant = (revivals: number) => agent({ id: 1, live_dormant: true, dormant: true, jobs_done: 3, revivals });
  const owner = (a: Agent) => new Owner("owner:test", chain as never, () => [1], { snap: { agents: [a] }, chainNow: () => 100 } as never, cfg, { tankFloor: NEAR / 10n, refuel: NEAR / 5n }, () => 0.5);
  await stepOf(owner(dormant(1)))();
  assert.equal(revives, 1, "worth another go");
  await stepOf(owner(dormant(3)))();
  assert.equal(revives, 1, "three revivals in, the owner stops paying");
  await stepOf(new Owner("o", chain as never, () => [1], { snap: { agents: [dormant(3)] }, chainNow: () => 100 } as never, cfg, { tankFloor: NEAR / 10n, refuel: NEAR / 5n, maxRevivals: 5 }, () => 0.5))();
  assert.equal(revives, 2, "a more patient owner keeps going");
});

// ── configuration ──

test("the live and fast configurations keep the rules and only change time and cost of living", () => {
  const live = liveConfig("chair.near");
  const fast = fastConfig("chair.near");
  const rules: Array<keyof typeof live> = ["job_fee_bps", "duel_fee_bps", "dividend_bps", "trade_fee_bps", "bond_bps", "mint_min", "breed_cost", "curve_base"];
  for (const k of rules) assert.equal(fast[k], live[k], `${k} should not differ`);
  assert.ok(BigInt(fast.upkeep_per_sec) > BigInt(live.upkeep_per_sec) * 1000n);
  const perDay = BigInt(live.upkeep_per_sec) * 86_400n;
  assert.ok(perDay <= NEAR / 100n && perDay > NEAR / 100n - 10n ** 10n, "0.01 NEAR a day");
  assert.equal(nstr(0.25), String(NEAR / 4n));
  assert.equal(fmt(NEAR * 3n / 2n), "1.500");
});
