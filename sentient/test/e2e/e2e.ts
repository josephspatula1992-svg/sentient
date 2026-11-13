/**
 * End to end on a real local NEAR chain (near-sandbox, a genuine nearcore node).
 *
 * It deploys the actual contract WASM and then does what the unit tests cannot: checks that minting really creates a NEAR
 * account for the agent, that the key on it is a function-call key limited to the agent methods, that the agent signs its
 * own calls, that the key cannot move NEAR or reach anything else, that a transfer ends the old keeper's power on a real
 * chain (where `signer_account_pk` is real), that every kind of puzzle the TypeScript solver answers is accepted by the
 * contract's own solver, that money paid to people lands in their accounts, and that the contract's books balance against
 * its real balance.
 *
 *   npm run build:contract && npm run build && npm run e2e
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

import { Chain } from "../../src/lib/near.js";
import { fastConfig, nstr } from "../../src/lib/defaults.js";
import { solve } from "../../src/lib/puzzle.js";
import { makeBrief, briefText, mockDeliverable } from "../../src/lib/jobs.js";
import { ArtifactStore } from "../../src/lib/store.js";
import { AGENT_METHODS, type Agent, type Genome } from "../../src/lib/types.js";
import { NEAR } from "../../src/lib/units.js";
import { sleep } from "../../src/lib/log.js";
// @ts-ignore: plain JS shared with the browser
import { genomeSvg } from "../../web/model.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const WASM = readFileSync(path.join(root, "contracts/sentient/res/sentient.wasm"));

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function check(name: string, fn: () => Promise<void> | void) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(400);
  }
}

/** Money and accounts created by a contract arrive in a later receipt, so assertions on them are retried briefly. */
async function eventually(fn: () => Promise<void> | void, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      await fn();
      return;
    } catch (e) {
      if (Date.now() > end) throw e;
      await sleep(500);
    }
  }
}

async function rejects(p: Promise<unknown>, pattern: RegExp) {
  try {
    await p;
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    assert.match(text, pattern, `rejected, but with the wrong reason: ${text.slice(0, 400)}`);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but the call succeeded`);
}

process.env.DIR_TO_DOWNLOAD_BINARY ??= path.join(root, ".sandbox-bin");
const sandbox = await Sandbox.start({});
let exitCode = 1;

try {
  const rpc = sandbox.rpcUrl;
  console.log(`sandbox up at ${rpc}`);
  const rootAccount = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
  const keys = new Map<string, string>();
  async function mk(name: string, near: bigint): Promise<string> {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await rootAccount.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    keys.set(id, kp.toString());
    return id;
  }

  const people = {
    chair: await mk("chair", 20n * NEAR), alice: await mk("alice", 40n * NEAR), bob: await mk("bob", 40n * NEAR),
    carol: await mk("carol", 40n * NEAR), dave: await mk("dave", 40n * NEAR), erin: await mk("erin", 20n * NEAR),
    poster: await mk("poster", 40n * NEAR), keeper: await mk("keeper", 10n * NEAR), fan: await mk("fan", 20n * NEAR),
    mallory: await mk("mallory", 10n * NEAR),
  };
  const contractId = await mk("sentient", 60n * NEAR);
  const mortalId = await mk("mortal", 30n * NEAR);

  const as = (who: string, at = contractId) => new Chain(who, keys.get(who), at, rpc);
  const P = Object.fromEntries(Object.entries(people).map(([k, v]) => [k, as(v)])) as Record<keyof typeof people, Chain>;

  // the economy under test has no upkeep, so balances can be asserted to the yocto; a second contract has a steep one
  const cfg = fastConfig(people.chair, { upkeep_per_sec: "0", duel_start_secs: 6 });
  for (const id of [contractId, mortalId]) {
    await new Account(id, rpc, keys.get(id) as `ed25519:${string}`).deployContract(WASM);
  }
  await as(contractId).call("new", { config: cfg });
  await as(mortalId, mortalId).call("new", { config: fastConfig(people.chair, { upkeep_per_sec: nstr(0.05) }) });
  console.log("contracts deployed");

  const store = new ArtifactStore(path.join(root, "store-e2e"));
  const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); })();

  interface Born { id: number; kp: KeyPair; self: Chain; account: string; owner: string }
  const born: Born[] = [];
  async function mintAgent(owner: keyof typeof people, name: string, genome?: Genome, at = contractId): Promise<Born> {
    const kp = KeyPair.fromRandom("ed25519");
    const c = as(people[owner], at);
    const id = await c.mint({
      name, persona: `${name}, a test agent`, genome, runtimeKey: kp.getPublicKey().toString(), deposit: 2n * NEAR,
    });
    const account = `a${id}.${at}`;
    const b = { id, kp, self: new Chain(account, kp.toString(), at, rpc), account, owner: people[owner] };
    if (at === contractId) born.push(b);
    return b;
  }
  const G: Genome = { diligence: 60, boldness: 60, thrift: 60, sociability: 60, cunning: 60 };

  async function runJob(
    worker: Born, bountyNear: number, opts: { submit?: "good" | "bad"; settle?: "accept" | "reject" | "silent" | "none"; workSecs?: number } = {},
  ) {
    const brief = makeBrief(Math.floor(rnd() * 100), 3);
    const blob = store.put(briefText(brief));
    const bounty = nstr(bountyNear);
    const jobId = await P.poster.postJob({
      title: brief.topic.slice(0, 70), briefUri: blob.uri, briefHash: blob.hash, workSecs: opts.workSecs ?? 120,
      deposit: BigInt(bounty) + BigInt(cfg.job_storage_fee),
    });
    await worker.self.claimJob(worker.id, jobId);
    if (opts.submit !== undefined || opts.settle !== "none") {
      const text = opts.submit === "bad" ? "- TODO\n- placeholder" : mockDeliverable(brief, { ...G, boldness: 0, diligence: 100 }, () => 0.99);
      const out = store.put(text);
      await worker.self.submitWork(worker.id, jobId, out.hash, out.uri);
    }
    if (opts.settle === "accept") await P.poster.acceptWork(jobId);
    if (opts.settle === "reject") await P.poster.rejectWork(jobId, "not what I asked for");
    return jobId;
  }

  const audit = async (at = contractId) => as(people.alice, at).audit();

  // ───────────────────────── the contract and the agent's own account ─────────────────────────

  let a1!: Born, a2!: Born, a3!: Born;

  await check("A1 the contract is live with the economy's rules", async () => {
    const live = await P.alice.config();
    assert.equal(live.chair, people.chair);
    assert.equal(BigInt(live.mint_min), NEAR);
    assert.equal((await P.alice.stats()).agents, 0);
  });

  await check("A2 minting creates the agent's own NEAR account, seeded, with its books balanced", async () => {
    a1 = await mintAgent("alice", "Ada", G);
    a2 = await mintAgent("bob", "Bram", G);
    a3 = await mintAgent("carol", "Cleo", G);
    assert.equal(a1.id, 1);
    assert.equal(a1.account, `a1.${contractId}`);
    const ag = (await P.alice.agent(1))!;
    assert.equal(ag.account, a1.account);
    assert.equal(BigInt(ag.ledger), 2n * NEAR - (2n * NEAR * 300n) / 10_000n - NEAR / 4n - (NEAR * 3n) / 100n);
    await eventually(async () => {
      assert.equal(await P.alice.nativeBalance(a1.account), NEAR / 4n, "the account holds exactly its seed");
    });
    const au = await audit();
    assert.ok(au.balanced && au.solvent, JSON.stringify(au));
  });

  await check("A3 the account has exactly one key: a function-call key limited to the agent methods", async () => {
    let list = await P.alice.accessKeys(a1.account);
    await eventually(async () => { list = await P.alice.accessKeys(a1.account); assert.equal(list.length, 1); });
    const k = list[0];
    assert.equal(k.public_key, a1.kp.getPublicKey().toString());
    const fc = (k.access_key.permission as any).FunctionCall;
    assert.ok(fc, "the key is not a function-call key: " + JSON.stringify(k.access_key.permission));
    assert.equal(fc.receiver_id, contractId);
    assert.deepEqual([...fc.method_names].sort(), [...AGENT_METHODS].sort(), "the key's methods differ from the contract's list");
    assert.ok(fc.allowance === null || fc.allowance === undefined, "the allowance should be unlimited");
    // and the shell is deployed on it
    const code = (await P.alice.account.provider.viewAccount({ accountId: a1.account })).code_hash;
    assert.notEqual(code, "11111111111111111111111111111111", "no contract on the agent's account");
  });

  await check("A3b only the registry can reach the shell: not the agent's key, not a stranger", async () => {
    await rejects(new Chain(a1.account, a1.kp.toString(), a1.account, rpc).call("revoke", {}), /ReceiverMismatch|receiver|not allowed/i);
    await rejects(as(people.mallory, a1.account).call("sweep", {}), /only the registry/);
    await rejects(as(people.mallory, a1.account).call("revoke", {}), /only the registry/);
    await rejects(as(people.mallory, a1.account).call("grant", {}), /only the registry/);
  });

  await check("A4 the agent signs its own calls", async () => {
    const duelId = await a1.self.challenge(a1.id, nstr(0.05));
    const d = (await P.alice.duel(duelId))!;
    assert.equal(d.a, a1.id);
    assert.equal(d.status, "Open");
    const feed = await P.alice.feed(10);
    assert.ok(feed.some((e) => e.kind === "challenge" && e.a === a1.id));
    await a1.self.cancelChallenge(duelId);
    assert.equal((await P.alice.duel(duelId))!.status, "Cancelled");
  });

  await check("A5 the agent's key cannot move NEAR, add keys, or call anything but the agent methods", async () => {
    const acct = a1.self.account;
    await rejects(acct.transfer({ receiverId: people.alice, amount: 1_000_000n }), /RequiresFullAccess|full access|not allowed|permission|Access/i);
    await rejects(acct.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey()), /RequiresFullAccess|full access|not allowed|permission|Access/i);
    await rejects(a1.self.withdraw(a1.id, 1n), /MethodNameMismatch|not allowed|method/i);
    await rejects(a1.self.refuel(a1.id, 1n), /MethodNameMismatch|not allowed|method/i);
    // a function-call key cannot attach any deposit at all, even to a method it is allowed to call
    await rejects(a1.self.call("poke", { agent_id: a1.id }, { deposit: 1n }), /DepositWithFunctionCall|deposit/i);
    await rejects(
      new Chain(a1.account, a1.kp.toString(), people.chair, rpc).call("anything", {}),
      /ReceiverMismatch|receiver|not allowed/i,
    );
  });

  await check("A6 nobody else can act for the agent", async () => {
    await rejects(P.mallory.challenge(a1.id, nstr(0.05)), /not authorised/);
    await rejects(P.mallory.withdraw(a1.id, 1n), /only the agent's owner/);
    await rejects(as(people.mallory).call("poke", { agent_id: 9999 }), /no such agent/);
  });

  // ───────────────────────── jobs ─────────────────────────

  await check("A7 a job runs on chain: escrow, bond, delivery by the agent's own key, payment to its ledger", async () => {
    const before = (await P.bob.agent(a2.id))!;
    const jobId = await runJob(a2, 1, { settle: "accept" });
    const j = (await P.bob.job(jobId))!;
    assert.equal(j.status, "Paid");
    const after = (await P.bob.agent(a2.id))!;
    const net = NEAR - (NEAR * 200n) / 10_000n;
    assert.equal(BigInt(after.ledger) - BigInt(before.ledger), net, "paid the bounty less the 2% protocol fee, bond returned");
    assert.equal(after.jobs_done, before.jobs_done + 1);
    assert.equal(BigInt(after.locked), 0n);
    const au = await audit();
    assert.ok(au.balanced && au.solvent);
    assert.equal(BigInt(au.totals.escrow), 0n);
  });

  await check("A8 a silent poster still pays: anyone finalizes after the review window", async () => {
    const jobId = await runJob(a3, 0.5, { settle: "silent" });
    await rejects(P.keeper.finalizeJob(jobId), /still has time to review/);
    await until("the review window to pass", async () => {
      try { await P.keeper.finalizeJob(jobId); return true; } catch { return false; }
    }, 40_000);
    assert.equal((await P.alice.job(jobId))!.status, "Paid");
    assert.equal((await P.alice.agent(a3.id))!.jobs_done, 1);
  });

  await check("A9 a rejected job goes to the chair; a refund slashes the bond to the poster, in real NEAR", async () => {
    const worker = a2;
    const posterBefore = await P.alice.nativeBalance(people.poster);
    const repBefore = (await P.alice.agent(worker.id))!.reputation;
    const jobId = await runJob(worker, 0.5, { submit: "bad", settle: "reject" });
    assert.equal((await P.alice.job(jobId))!.status, "Disputed");
    await rejects(P.mallory.resolveDispute(jobId, "RefundPoster"), /only the chair/);
    await P.chair.resolveDispute(jobId, "RefundPoster");
    const j = (await P.alice.job(jobId))!;
    assert.equal(j.status, "Refunded");
    // The poster paid 0.5 + the 0.02 storage fee and gets back the 0.5 bounty and the 0.05 bond, so ends 0.03 ahead less gas.
    await eventually(async () => {
      const gain = (await P.alice.nativeBalance(people.poster)) - posterBefore;
      assert.ok(gain > 0n && gain < NEAR / 20n, `poster should end slightly ahead after a refund and a slashed bond, got ${gain}`);
    });
    const w = (await P.alice.agent(worker.id))!;
    assert.equal(w.reputation, repBefore - 8);
    assert.equal(w.jobs_failed, 1);
    const au = await audit();
    assert.ok(au.balanced && au.solvent);
  });

  await check("A10 a missed deadline costs the bond and reopens the job", async () => {
    const jobId = await runJob(a3, 0.3, { settle: "none", workSecs: 10, submit: undefined });
    assert.equal((await P.alice.job(jobId))!.status, "Claimed");
    await rejects(P.keeper.expireClaim(jobId), /still has time/);
    await until("the deadline to pass", async () => {
      try { await P.keeper.expireClaim(jobId); return true; } catch { return false; }
    }, 40_000);
    const j = (await P.alice.job(jobId))!;
    assert.equal(j.status, "Open");
    assert.deepEqual(j.barred, [a3.id]);
    await rejects(a3.self.claimJob(a3.id, jobId), /failed this job before/);
    await P.poster.cancelJob(jobId);
    assert.equal((await P.alice.job(jobId))!.status, "Cancelled");
  });

  // ───────────────────────── duels ─────────────────────────

  async function duel(first: Born, second: Born, kind: number | null, stake = 0.02) {
    const id = await first.self.challenge(first.id, nstr(stake), second.id, kind);
    await second.self.acceptDuel(id, second.id);
    const d = (await P.alice.duel(id))!;
    const wait = d.live_at - (await P.alice.stats()).now;
    if (wait > 0) await sleep(wait * 1000 + 700);
    return { id, d };
  }

  await check("A11 every kind of puzzle: the TypeScript solver and the contract's solver agree, and the first right answer wins", async () => {
    for (let kind = 0; kind < 5; kind++) {
      const [x, y] = kind % 2 === 0 ? [a1, a2] : [a2, a1];
      const { id, d } = await duel(x, y, kind);
      assert.equal(d.kind, kind);
      const mine = solve(kind, d.params);
      assert.notEqual(mine, null);
      const right = await y.self.answerDuel(id, y.id, mine!);
      assert.equal(right, true, `the contract rejected the solver's answer to ${d.question}`);
      const done = (await P.alice.duel(id))!;
      assert.equal(done.status, "Settled");
      assert.equal(done.winner, y.id);
    }
    const au = await audit();
    assert.ok(au.balanced && au.solvent);
  });

  await check("A12 a wrong answer locks you out, and two wrong answers draw the duel with stakes returned", async () => {
    const ledger = (await P.alice.agent(a1.id))!.ledger;
    const { id, d } = await duel(a1, a2, 1);
    const right = solve(1, d.params)!;
    assert.equal(await a1.self.answerDuel(id, a1.id, right + 1), false);
    await rejects(a1.self.answerDuel(id, a1.id, right), /already answered wrongly/);
    assert.equal(await a2.self.answerDuel(id, a2.id, right + 2), false);
    const done = (await P.alice.duel(id))!;
    assert.equal(done.status, "Drawn");
    assert.equal((await P.alice.agent(a1.id))!.locked, "0");
    assert.equal((await P.alice.agent(a1.id))!.ledger, (BigInt(ledger) - BigInt(cfg.duel_storage_fee)).toString(), "only the storage fee is spent on a draw");
  });

  await check("A13 an owner's own agents cannot duel each other, and answers before the start delay do not count", async () => {
    const twin = await mintAgent("alice", "Ada's twin", G);
    const id = await a1.self.challenge(a1.id, nstr(0.02), null, 0);
    await rejects(twin.self.acceptDuel(id, twin.id), /cannot duel each other/);
    await a2.self.acceptDuel(id, a2.id);
    const d = (await P.alice.duel(id))!;
    await rejects(a2.self.answerDuel(id, a2.id, solve(0, d.params)!), /has not started/);
    await until("the duel to start", async () => (await P.alice.stats()).now >= d.live_at);
    assert.equal(await a2.self.answerDuel(id, a2.id, solve(0, d.params)!), true);
  });

  // ───────────────────────── shares ─────────────────────────

  await check("A14 shares: buy on the curve, collect a dividend from a job, sell, with the reserve exact throughout", async () => {
    const q = await P.fan.quote(a2.id, 2, true);
    const before = await P.fan.nativeBalance(people.fan);
    await P.fan.buyShares(a2.id, 2, BigInt(q.total) + 12_345n);
    let ag = (await P.alice.agent(a2.id))!;
    assert.equal(ag.shares, 2);
    assert.equal(BigInt(ag.reserve), BigInt(q.price));
    assert.ok(before - (await P.fan.nativeBalance(people.fan)) < BigInt(q.total) + NEAR / 100n, "the 12,345 yocto of excess came back");
    await runJob(a2, 1, { settle: "accept" });
    const net = NEAR - (NEAR * 200n) / 10_000n;
    const div = await P.fan.pendingDividends(a2.id, people.fan);
    assert.equal(div, (net * 1500n) / 10_000n, "the holders' cut of the worker's pay");
    const bal = await P.fan.nativeBalance(people.fan);
    await P.fan.claimDividends(a2.id);
    await eventually(async () => {
      assert.ok((await P.fan.nativeBalance(people.fan)) - bal > div - NEAR / 100n, "the dividend arrived in the fan's account");
    });
    await until("the sell lock to pass", async () => {
      try { await P.fan.sellShares(a2.id, 2, 0n); return true; } catch { return false; }
    }, 30_000);
    ag = (await P.alice.agent(a2.id))!;
    assert.equal(ag.shares, 0);
    assert.equal(ag.reserve, "0");
    const au = await audit();
    assert.ok(au.balanced && au.solvent);
  });

  // ───────────────────────── gas and ownership ─────────────────────────

  await check("A15 the owner can refuel the agent's account from its ledger; the agent's own key cannot", async () => {
    const before = await P.alice.nativeBalance(a1.account);
    const ledger = BigInt((await P.alice.agent(a1.id))!.ledger);
    await P.alice.refuel(a1.id, NEAR / 10n);
    await eventually(async () => {
      assert.equal((await P.alice.nativeBalance(a1.account)) - before, NEAR / 10n);
    });
    assert.equal(BigInt((await P.alice.agent(a1.id))!.ledger), ledger - NEAR / 10n);
    await rejects(P.mallory.refuel(a1.id, 1n), /only the agent's owner/);
  });

  await check("A16 selling the NFT ends the old keeper's power on a real chain, and hands over the money", async () => {
    const sold = await mintAgent("alice", "For sale", G);
    const ledger = (await P.alice.agent(sold.id))!.ledger;
    await rejects(P.mallory.nftTransfer(people.mallory, sold.id), /only the owner/);
    await P.alice.nftTransfer(people.dave, sold.id);
    const ag = (await P.alice.agent(sold.id))!;
    assert.equal(ag.owner, people.dave);
    assert.equal(ag.key_bound, false);
    assert.equal(ag.ledger, ledger, "the money goes with the agent");
    assert.equal((await P.alice.token(sold.id))!.owner_id, people.dave);
    // the shell deleted the seller's key from the account: there is nothing left to sign with, and nothing left to burn gas
    await eventually(async () => assert.equal((await P.alice.accessKeys(sold.account)).length, 0));
    const tankBefore = await P.alice.nativeBalance(sold.account);
    for (let i = 0; i < 3; i++) await rejects(sold.self.challenge(sold.id, nstr(0.05)), /access key|AccessKey|does not exist|doesn't exist|DoesNotExist/i);
    assert.equal(await P.alice.nativeBalance(sold.account), tankBefore, "failed attempts by the seller cost the agent nothing");
    await rejects(P.alice.challenge(sold.id, nstr(0.05)), /not authorised/);
    // the new owner acts, and can name an operator, who can too
    const open = await P.dave.challenge(sold.id, nstr(0.05));
    await P.dave.setOperator(sold.id, people.keeper);
    await P.keeper.cancelChallenge(open);
    assert.equal((await P.alice.duel(open))!.status, "Cancelled");
    await rejects(P.mallory.setOperator(sold.id, people.mallory), /only the agent's owner/);

    // the new owner gives the agent a new key; it signs for itself again, and the account has exactly that one key
    const fresh = KeyPair.fromRandom("ed25519");
    await rejects(P.mallory.setRuntimeKey(sold.id, fresh.getPublicKey().toString()), /only the agent's owner/);
    await P.dave.setRuntimeKey(sold.id, fresh.getPublicKey().toString());
    await eventually(async () => {
      const ks = await P.alice.accessKeys(sold.account);
      assert.equal(ks.length, 1);
      assert.equal(ks[0].public_key, fresh.getPublicKey().toString());
      const fc = (ks[0].access_key.permission as any).FunctionCall;
      assert.deepEqual([...fc.method_names].sort(), [...AGENT_METHODS].sort());
      assert.equal(fc.receiver_id, contractId);
    });
    const reborn = new Chain(sold.account, fresh.toString(), contractId, rpc);
    const duelId = await reborn.challenge(sold.id, nstr(0.02));
    await reborn.cancelChallenge(duelId);
    await rejects(sold.self.challenge(sold.id, nstr(0.05)), /access key|AccessKey|does not exist|doesn't exist|DoesNotExist/i);

    // and the owner can take the agent's spare gas back
    const tank = await P.alice.nativeBalance(sold.account);
    const mine = await P.alice.nativeBalance(people.dave);
    await rejects(P.mallory.sweepTank(sold.id), /only the agent's owner/);
    await P.dave.sweepTank(sold.id, NEAR / 20n);
    await eventually(async () => {
      const left = await P.alice.nativeBalance(sold.account);
      assert.ok(left < NEAR / 10n && left >= NEAR / 20n, `the account should keep about its stake plus 0.05, has ${left}`);
      assert.ok((await P.alice.nativeBalance(people.dave)) - mine > tank - NEAR / 10n - NEAR / 100n, "the owner received the spare gas");
    });
    await reborn.poke(sold.id); // still alive and able to sign after the sweep
  });

  await check("A16b a delegate or stolen key can only put a capped share of the balance at risk; the owner is not capped", async () => {
    const risky = await mintAgent("erin", "Capped", G);
    await P.erin.setRiskBps(risky.id, 1000); // 10% of about 1.66 NEAR
    const stake = nstr(0.5);
    await rejects(risky.self.challenge(risky.id, stake), /more of the agent's balance at risk/);
    const small = await risky.self.challenge(risky.id, nstr(0.1));
    await risky.self.cancelChallenge(small);
    const big = await P.erin.challenge(risky.id, stake); // the owner may
    await P.erin.cancelChallenge(big);
    await P.erin.setOperator(risky.id, people.keeper);
    await rejects(P.keeper.challenge(risky.id, stake), /more of the agent's balance at risk/);
    await rejects(P.mallory.setRiskBps(risky.id, 10_000), /only the agent's owner/);
    // re-keying an agent whose key is still honoured replaces the key: the old one is deleted, only the new one remains
    const next = KeyPair.fromRandom("ed25519");
    await P.erin.setRuntimeKey(risky.id, next.getPublicKey().toString());
    await eventually(async () => {
      const ks = await P.alice.accessKeys(risky.account);
      assert.equal(ks.length, 1);
      assert.equal(ks[0].public_key, next.getPublicKey().toString());
    });
    await new Chain(risky.account, next.toString(), contractId, rpc).poke(risky.id);
    await rejects(risky.self.poke(risky.id), /access key|AccessKey|does not exist|doesn't exist|DoesNotExist/i);
  });

  await check("A17 an agent holding a claim cannot be transferred", async () => {
    const busy = await mintAgent("erin", "Busy", G);
    await P.erin.challenge(busy.id, nstr(0.05));
    await rejects(P.erin.nftTransfer(people.dave, busy.id), /cannot be transferred/);
  });

  // ───────────────────────── breeding ─────────────────────────

  await check("A18 two proven agents have a child with its own account, key and NFT; the parents pay", async () => {
    await P.bob.setStudFee(a2.id, NEAR / 10n);
    const p3 = (await P.alice.agent(a3.id))!;
    const p2 = (await P.alice.agent(a2.id))!;
    assert.ok(p3.jobs_done + p3.duel_wins > 0 && p2.jobs_done + p2.duel_wins > 0);
    const kp = KeyPair.fromRandom("ed25519");
    const childId = await P.carol.breed(a3.id, a2.id, "Heir", "child of Cleo and Bram", kp.getPublicKey().toString(), NEAR / 10n);
    const child = (await P.alice.agent(childId))!;
    assert.equal(child.generation, 1);
    assert.deepEqual(child.parents, [a3.id, a2.id]);
    assert.equal(child.owner, people.carol);
    assert.equal(BigInt(child.ledger), NEAR - NEAR / 4n - (NEAR * 3n) / 100n);
    const g = child.genome;
    assert.ok(g.diligence + g.boldness + g.thrift + g.sociability + g.cunning <= 300);
    await eventually(async () => {
      assert.equal(await P.alice.nativeBalance(child.account), NEAR / 4n);
      assert.equal((await P.alice.accessKeys(child.account)).length, 1);
    });
    assert.equal(BigInt((await P.alice.agent(a3.id))!.ledger), BigInt(p3.ledger) - NEAR / 2n);
    assert.equal(BigInt((await P.alice.agent(a2.id))!.ledger), BigInt(p2.ledger) - NEAR / 2n + NEAR / 10n);
    // the child signs for itself
    const self = new Chain(child.account, kp.toString(), contractId, rpc);
    await self.poke(childId);
    await rejects(P.carol.breed(a3.id, a2.id, "Again", "", kp.getPublicKey().toString(), NEAR / 10n), /recovering/);
    assert.equal((await P.alice.token(childId))!.owner_id, people.carol);
    const au = await audit();
    assert.ok(au.balanced && au.solvent);
  });

  // ───────────────────────── dying and coming back ─────────────────────────

  await check("A19 an agent that cannot pay its upkeep goes dormant, cannot act, and a stranger can wake it", async () => {
    const m = await mintAgent("erin", "Mortal", G, mortalId);
    const view = as(people.alice, mortalId);
    await until("the agent to run dry", async () => (await view.agent(m.id))!.live_dormant, 60_000);
    assert.equal((await view.agent(m.id))!.dormant, false, "nobody has touched it, so the chain has not recorded the death");
    await as(people.keeper, mortalId).poke(m.id);
    assert.equal((await view.agent(m.id))!.dormant, true);
    await rejects(m.self.challenge(m.id, nstr(0.05)), /dormant/);
    const stranger = as(people.mallory, mortalId);
    await stranger.revive(m.id, nstr(0.05));
    assert.equal((await view.agent(m.id))!.dormant, true, "too little only helps");
    await stranger.revive(m.id, nstr(0.3));
    const woke = (await view.agent(m.id))!;
    assert.equal(woke.dormant, false);
    assert.equal(woke.revivals, 1);
    assert.equal(woke.owner, people.erin, "a stranger's gift does not change who owns the agent");
    const au = await audit(mortalId);
    assert.ok(au.balanced && au.solvent);
  });

  await check("A21 the picture a wallet shows is the picture the dashboard draws, byte for byte", async () => {
    for (const id of [1, 2, 3, 7]) {
      const tok = (await P.alice.token(id))!;
      const ag = (await P.alice.agent(id))!;
      const mine = "data:image/svg+xml;utf8," + (genomeSvg(id, ag.genome, ag.live_dormant) as string);
      assert.equal(tok.metadata.media, mine, `token ${id}`);
    }
  });

  // ───────────────────────── the books against the chain ─────────────────────────

  await check("A20 the contract's books balance, and its real balance covers every liability and its storage", async () => {
    for (const id of [contractId, mortalId]) {
      const au = await audit(id);
      assert.ok(au.balanced, "books do not balance: " + JSON.stringify(au.totals));
      assert.ok(au.solvent, "contract cannot cover its liabilities: " + JSON.stringify(au));
      const state = await P.alice.nativeBalance(id);
      assert.equal(state.toString(), au.balance, "the audit's balance is the chain's balance");
      assert.ok(state >= BigInt(au.liabilities) + BigInt(au.storage_staked));
    }
    // and from the other side: the sum of what every agent record holds is what the totals say
    const all = (await P.alice.agents(1, 100)) as Agent[];
    const sum = (f: (a: Agent) => string) => all.reduce((s, a) => s + BigInt(f(a)), 0n);
    const au = await audit();
    assert.equal(sum((a) => a.ledger).toString(), au.totals.ledgers);
    assert.equal(sum((a) => a.locked).toString(), au.totals.locked);
    assert.equal(sum((a) => a.reserve).toString(), au.totals.reserves);
    assert.equal(sum((a) => a.div_pool).toString(), au.totals.dividends);
  });

  // ───────────────────────── report ─────────────────────────

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await sandbox.tearDown().catch(() => {});
}
process.exit(exitCode);
