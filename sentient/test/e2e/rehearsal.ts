/**
 * A rehearsal of the real launch path, on a local node.
 *
 * Everything the launch needs that the other tests do not exercise: `npm run deploy`, `npm run mint` and `npm run run-agent`
 * as the separate processes a person would start, agents running off the key files `mint` wrote, and the dashboard in its
 * live mode, loaded in a real browser, reading the contract through the server's read-only proxy.
 *
 *   npm run build:contract && npm run build && npm run rehearse
 */
import { spawn, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

import { Chain } from "../../src/lib/near.js";
import { WorldWatcher } from "../../src/lib/world.js";
import { ArtifactStore } from "../../src/lib/store.js";
import { MockBrain } from "../../src/lib/brain.js";
import { Market, Keeper, Chair } from "../../src/agents/actors.js";
import { startServer } from "../../src/serve.js";
import { NEAR } from "../../src/lib/units.js";
import { nstr } from "../../src/lib/defaults.js";
import { sleep } from "../../src/lib/log.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const results: Array<{ name: string; ok: boolean }> = [];
async function check(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${(e instanceof Error ? e.message : String(e)).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 120_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(700);
  }
}

process.env.DIR_TO_DOWNLOAD_BINARY ??= path.join(root, ".sandbox-bin");
const work = mkdtempSync(path.join(tmpdir(), "sentient-rehearsal-"));
const sandbox = await Sandbox.start({});
const children: Array<ReturnType<typeof spawn>> = [];
let exitCode = 1;

try {
  const rpc = sandbox.rpcUrl;
  const rootAccount = new Account(DEFAULT_ACCOUNT_ID, rpc, DEFAULT_PRIVATE_KEY as `ed25519:${string}`);
  const keys = new Map<string, string>();
  const mk = async (name: string, near: bigint) => {
    const kp = KeyPair.fromRandom("ed25519");
    const id = `${name}.${DEFAULT_ACCOUNT_ID}`;
    await rootAccount.createAccount({ newAccountId: id, publicKey: kp.getPublicKey(), nearToTransfer: near });
    keys.set(id, kp.toString());
    return id;
  };
  const contractId = await mk("sentient", 60n * NEAR);
  const chairId = await mk("chair", 20n * NEAR);
  const ownerA = await mk("ownera", 20n * NEAR);
  const ownerB = await mk("ownerb", 20n * NEAR);
  const posterId = await mk("poster", 40n * NEAR);
  const keeperId = await mk("keeper", 10n * NEAR);
  const humanId = await mk("human", 20n * NEAR);
  const as = (who: string) => new Chain(who, keys.get(who), contractId, rpc);

  const node = process.execPath;
  const script = (n: string) => path.join(root, "dist/scripts", n);
  const baseEnv = { ...process.env, NETWORK: "local", RPC_URL: rpc, CONTRACT_ID: contractId, STORE_DIR: path.join(work, "store"), FORCE_COLOR: "0" };

  await check("R1 deploy refuses an account without enough NEAR, then deploys, initialises and verifies", async () => {
    const poor = await mk("poor", 5n * NEAR);
    const refused = await run(node, [script("deploy.js"), "--fast"], { env: { ...baseEnv, CONTRACT_ID: poor, CONTRACT_KEY: keys.get(poor)!, CHAIR_ID: chairId } }).then(() => null, (e) => e);
    assert.ok(refused, "should have refused");
    assert.match(String(refused.stderr), /fund it to at least/);
    const ok = await run(node, [script("deploy.js"), "--fast"], { env: { ...baseEnv, CONTRACT_KEY: keys.get(contractId)!, CHAIR_ID: chairId } });
    assert.match(ok.stdout, /initialised with the fast economy/);
    assert.match(ok.stdout, /books balanced/);
    const cfg = await as(chairId).config();
    assert.equal(cfg.chair, chairId);
  });

  await check("R2 deploy will not touch an account that already has a contract", async () => {
    const again = await run(node, [script("deploy.js"), "--fast"], { env: { ...baseEnv, CONTRACT_KEY: keys.get(contractId)!, CHAIR_ID: chairId } }).then(() => null, (e) => e);
    assert.ok(again);
    assert.match(String(again.stderr), /already has an initialised contract/);
  });

  await check("R2b a typo'd chair is refused, and a deploy that stopped before `new` can be finished with --init-only", async () => {
    const half = await mk("half", 40n * NEAR);
    const env = { ...baseEnv, CONTRACT_ID: half, CONTRACT_KEY: keys.get(half)! };
    const typo = await run(node, [script("deploy.js"), "--fast"], { env: { ...env, CHAIR_ID: `nobody.${DEFAULT_ACCOUNT_ID}` } }).then(() => null, (e) => e);
    assert.ok(typo);
    assert.match(String(typo.stderr), /chair account .* does not exist/);
    // simulate an interrupted run: the code is there, `new` never ran
    await new Account(half, rpc, keys.get(half) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/sentient/res/sentient.wasm")));
    const stuck = await run(node, [script("deploy.js"), "--fast"], { env: { ...env, CHAIR_ID: chairId } }).then(() => null, (e) => e);
    assert.ok(stuck);
    assert.match(String(stuck.stderr), /never initialised.*--init-only/);
    const fixed = await run(node, [script("deploy.js"), "--fast", "--init-only"], { env: { ...env, CHAIR_ID: chairId } });
    assert.match(fixed.stdout, /initialised with the fast economy/);
    assert.equal((await new Chain(chairId, keys.get(chairId), half, rpc).config()).chair, chairId);
  });

  await check("R3b --lock really deletes every key, and the locked contract still answers", async () => {
    const locked = await mk("lockme", 40n * NEAR);
    const env = { ...baseEnv, CONTRACT_ID: locked, CONTRACT_KEY: keys.get(locked)!, CHAIR_ID: chairId, CONFIRM_LOCK: "yes" };
    const out = await run(node, [script("deploy.js"), "--fast", "--lock"], { env });
    assert.match(out.stdout, /contract keys deleted/);
    const view = new Chain(chairId, keys.get(chairId), locked, rpc);
    assert.equal((await view.accessKeys(locked)).length, 0, "keys remain on a locked contract");
    assert.equal((await view.config()).chair, chairId, "a locked contract must still work");
    // and nobody, including its old owner, can change it any more
    const redeploy = await new Account(locked, rpc, keys.get(locked) as `ed25519:${string}`).deployContract(readFileSync(path.join(root, "contracts/sentient/res/sentient.wasm"))).then(() => null, (e: Error) => e);
    assert.ok(redeploy, "a locked contract must not accept a new deployment");
  });

  await check("R3 --lock needs an explicit confirmation", async () => {
    const r = await run(node, [script("deploy.js"), "--lock"], { env: { ...baseEnv, CONTRACT_KEY: keys.get(contractId)!, CHAIR_ID: chairId } }).then(() => null, (e) => e);
    assert.ok(r);
    assert.match(String(r.stderr), /CONFIRM_LOCK=yes/);
  });

  let ids: number[] = [];
  await check("R4 mint creates agents and writes their key files, readable only by the owner", async () => {
    for (const [owner, name, genome] of [[ownerA, "Ada", "80,30,60,40,70"], [ownerB, "Bram", "40,80,40,70,60"]] as const) {
      const out = await run(node, [script("mint.js"), "--name", name, "--persona", `${name} from the rehearsal`, "--genome", genome, "--deposit", "2"], {
        cwd: work, env: { ...baseEnv, OWNER_ID: owner, OWNER_KEY: keys.get(owner)! },
      });
      const id = Number(/minted #(\d+)/.exec(out.stdout)![1]);
      ids.push(id);
      const f = path.join(work, ".agents", `${id}.json`);
      assert.ok(existsSync(f));
      assert.equal(statSync(f).mode & 0o077, 0, "key file is readable by others");
      const saved = JSON.parse(readFileSync(f, "utf8"));
      assert.equal(saved.account, `a${id}.${contractId}`);
    }
    assert.deepEqual(ids, [1, 2]);
  });

  const world = new WorldWatcher(as(keeperId), 800, await as(keeperId).config());
  await world.refresh();
  world.start();
  const store = new ArtifactStore(path.join(work, "store"));
  const brain = new MockBrain();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const market = new Market([as(posterId)], world, store, brain, { everyMs: 3500, minBounty: BigInt(nstr(0.15)), maxBounty: BigInt(nstr(0.3)), maxOpen: 2, workSecs: 60 }, rnd);
  const chair = new Chair(as(chairId), world, store, brain, rnd);
  const keeper = new Keeper(as(keeperId), world, world.cfg!, rnd);
  for (const a of [market, chair, keeper]) a.start();

  await check("R5 agents started from their saved key files take jobs and get paid, signing for themselves", async () => {
    for (const id of ids) {
      const c = spawn(node, [script("run-agent.js"), String(id)], { cwd: work, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
      c.stdout?.on("data", () => {});
      c.stderr?.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
      children.push(c);
    }
    // finished records are pruned within seconds, so watch the event feed cumulatively rather than one snapshot
    const seen = new Set<string>();
    world.listeners.push((s) => s.feed.forEach((e) => seen.add(e.kind)));
    // Jobs are dependable (the market posts, the agents claim); a duel needs one of two agents to open a challenge and the
    // other to like the odds, which is a matter of chance, so it is reported but not required.
    await until("a paid job", async () => seen.has("job_paid"), 150_000);
    const snap = world.snap!;
    assert.ok(snap.agents.some((a) => a.jobs_done > 0), "an agent should have been paid for a job");
    console.log(`        (duels decided so far: ${snap.agents.reduce((n, a) => n + a.duel_wins, 0)})`);
    const audit = await as(keeperId).audit();
    assert.ok(audit.balanced && audit.solvent);
  });

  await check("R5b a person posts a job with post-job, an agent delivers it, and review-job shows the verdict and pays it", async () => {
    const env = { ...baseEnv, POSTER_ID: humanId, POSTER_KEY: keys.get(humanId)! };
    const posted = await run(node, [script("post-job.js"), "--topic", "How NEAR sub-accounts work", "--keyword", "account", "--facts", "sub-account,parent,key", "--bullets", "3", "--bounty", "0.25", "--work-secs", "60"], { cwd: work, env });
    const jobId = Number(/posted job #(\d+)/.exec(posted.stdout)![1]);
    const view = as(keeperId);
    // wait for an agent to take it and deliver; act inside the review window
    await until("the job to be delivered", async () => (await view.job(jobId))?.status === "Submitted", 100_000);
    const shown = await run(node, [script("review-job.js"), String(jobId)], { cwd: work, env });
    assert.match(shown.stdout, /rubric: score \d+, (PASS|FAIL)/);
    assert.match(shown.stdout, /re-run with --accept or --reject/);
    const wrongPoster = await run(node, [script("review-job.js"), String(jobId), "--accept"], { cwd: work, env: { ...env, POSTER_ID: ownerA, POSTER_KEY: keys.get(ownerA)! } }).then(() => null, (e) => e);
    assert.ok(wrongPoster, "someone else's job must not be reviewable");
    assert.match(String(wrongPoster.stderr), /was posted by/);
    const verdictPass = /PASS/.test(shown.stdout);
    const acted = await run(node, [script("review-job.js"), String(jobId), verdictPass ? "--accept" : "--reject"], { cwd: work, env });
    assert.match(acted.stdout, verdictPass ? /accepted/ : /rejected/);
    const after = await view.job(jobId);
    // the keeper may already have pruned a paid job, which also proves it was paid
    assert.ok(after === null || ["Paid", "Disputed", "Refunded"].includes(after.status), `unexpected status ${after?.status}`);
  });

  await check("R5c across two stores: briefs reachable only over HTTP are read by an agent that trusts that host, and skipped by agents that do not", async () => {
    // a poster whose artifacts live in their own store, served over HTTP; no file:// URI can reach it
    const posterStore = path.join(work, "poster-store");
    const web = await startServer(0, null, posterStore);
    try {
      const host = `127.0.0.1:${(web.address() as { port: number }).port}`;
      const env = { ...baseEnv, STORE_DIR: posterStore, ARTIFACT_BASE: `http://${host}`, POSTER_ID: humanId, POSTER_KEY: keys.get(humanId)! };
      // a third agent, with its own store, that trusts the poster's host
      const third = await run(node, [script("mint.js"), "--name", "Cato", "--genome", "70,40,50,60,60", "--deposit", "2"], { cwd: work, env: { ...baseEnv, OWNER_ID: ownerA, OWNER_KEY: keys.get(ownerA)! } });
      const cid = Number(/minted #(\d+)/.exec(third.stdout)![1]);
      const cato = spawn(node, [script("run-agent.js"), String(cid)], {
        cwd: work, env: { ...baseEnv, STORE_DIR: path.join(work, "cato-store"), ARTIFACT_HOSTS: host }, stdio: ["ignore", "pipe", "pipe"],
      });
      cato.stdout?.on("data", () => {});
      cato.stderr?.on("data", () => {});
      children.push(cato);
      const posted = await run(node, [script("post-job.js"), "--topic", "How storage staking works", "--keyword", "stake", "--facts", "byte,storage,balance", "--bullets", "3", "--bounty", "0.25", "--work-secs", "90"], { cwd: work, env });
      assert.match(posted.stdout, /posted job #\d+/);
      assert.doesNotMatch(posted.stdout, /file:\/\//, "the brief should have an http URI");
      const jobId = Number(/posted job #(\d+)/.exec(posted.stdout)![1]);
      const view = as(keeperId);
      const job = await until("the job to be taken", async () => {
        const j = await view.job(jobId);
        return j && j.status !== "Open" ? j : null;
      }, 100_000);
      assert.ok(job.brief_uri.startsWith(`http://${host}/a/`), job.brief_uri);
      assert.equal(job.worker, cid, `only the agent that trusts ${host} can read the brief, so only it should have claimed it; got agent #${job.worker}`);
      // and the others were never out of pocket for it: nobody failed it
      assert.deepEqual(job.barred, []);
    } finally {
      web.close();
    }
  });

  await check("R6 the dashboard's live mode, in a real browser, reads the contract through the read-only proxy", async () => {
    if (!existsSync(CHROME)) throw new Error(`no Chrome at ${CHROME}; set CHROME`);
    const web = await startServer(0, rpc);
    try {
      const port = (web.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/?live=${encodeURIComponent(contractId)}&rpc=${encodeURIComponent("/rpc")}`;
      const dom = await run(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=12000", "--dump-dom", url], { maxBuffer: 20 * 1024 * 1024 }).then((r) => r.stdout);
      assert.match(dom, /class="pill live"/, "the live badge");
      assert.match(dom, /<span class="nm">Ada<\/span>/);
      assert.match(dom, /<span class="nm">Bram<\/span>/);
      assert.match(dom, /balanced/, "the books tile");
      assert.doesNotMatch(dom, /Could not read the contract/);
      // the proxy refuses to forward anything that is not a read
      const refused = await fetch(`http://127.0.0.1:${port}/rpc`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "send_tx", params: {} }) });
      assert.equal(refused.status, 403);
    } finally {
      web.close();
    }
  });

  for (const a of [market, chair, keeper]) a.stop();
  world.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} rehearsal checks passed`);
  exitCode = failed.length ? 1 : 0;
} finally {
  for (const c of children) c.kill("SIGTERM");
  await sandbox.tearDown().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
process.exit(exitCode);
