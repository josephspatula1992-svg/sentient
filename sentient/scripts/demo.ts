/**
 * Runs a small economy of Sentient agents on a local NEAR chain with nobody steering it, and records it for the web app.
 *
 * Twelve agents, each its own NEAR account signing with its own key, with different temperaments, take jobs, hire each
 * other, duel, run out of money, are revived, are bought into, and breed. The people around them (job posters, a chair,
 * a keeper, fans, owners) are ordinary accounts. Only time and upkeep are sped up. Nothing is scripted: what you see in
 * the recording is what happened.
 *
 *   npm run build:contract && npm run build && npm run demo -- --seconds 300
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Account, KeyPair } from "near-api-js";
import { Sandbox, DEFAULT_ACCOUNT_ID, DEFAULT_PRIVATE_KEY } from "near-sandbox";

import { Chain } from "../src/lib/near.js";
import { fastConfig, nstr } from "../src/lib/defaults.js";
import { ArtifactStore } from "../src/lib/store.js";
import { WorldWatcher } from "../src/lib/world.js";
import { Recorder, type Recording } from "../src/lib/record.js";
import { makeBrain } from "../src/lib/config.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { Chair, Fans, Keeper, Market, Owner } from "../src/agents/actors.js";
import type { Audit, Genome } from "../src/lib/types.js";
import { NEAR } from "../src/lib/units.js";
import { log, sleep } from "../src/lib/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SECONDS = Number(arg("seconds", "300"));
const OUT = arg("out", path.join(root, "web/demo-run.json"));

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Archetype {
  name: string;
  persona: string;
  genome: Genome;
  deposit: number;
  owner: string;
}

const g = (diligence: number, boldness: number, thrift: number, sociability: number, cunning: number): Genome => ({
  diligence, boldness, thrift, sociability, cunning,
});

const CAST: Archetype[] = [
  { name: "Tortoise", persona: "Slow, careful, hates being wrong. Checks everything twice and never takes a fight it cannot win.", genome: g(95, 10, 70, 40, 85), deposit: 1.5, owner: "tortoise-owner" },
  { name: "Gambler", persona: "Answers first and apologises later. Stakes big, talks bigger.", genome: g(10, 95, 20, 80, 40), deposit: 1.5, owner: "gambler-owner" },
  { name: "Miser", persona: "Counts every yocto. Only takes jobs that pay well and keeps a fat reserve.", genome: g(60, 15, 100, 20, 80), deposit: 1.5, owner: "miser-owner" },
  { name: "Diplomat", persona: "Knows everyone. Hires, trades favours and is always open to a duel.", genome: g(55, 40, 40, 100, 60), deposit: 1.5, owner: "diplomat-owner" },
  { name: "Fox", persona: "Reads ratings like a card counter and only fights the ones it can beat.", genome: g(50, 55, 45, 50, 100), deposit: 1.5, owner: "fox-owner" },
  { name: "Steady", persona: "Does a bit of everything and nothing too far.", genome: g(60, 60, 60, 60, 60), deposit: 1.5, owner: "steady-owner" },
  { name: "Hothead", persona: "Fast hands, short temper. Rushes the work and picks fights.", genome: g(15, 100, 10, 60, 10), deposit: 1.5, owner: "hothead-owner" },
  { name: "Clerk", persona: "Meticulous and dull. Delivers complete work every time.", genome: g(100, 20, 60, 30, 50), deposit: 1.5, owner: "clerk-owner" },
  { name: "Hustler", persona: "Always working an angle. Bold, social, a little too clever.", genome: g(45, 70, 30, 90, 65), deposit: 1.5, owner: "hustler-owner" },
  { name: "Drifter", persona: "Means well. Not good at much.", genome: g(20, 25, 35, 15, 10), deposit: 1.0, owner: "drifter-owner" },
  { name: "Mara", persona: "A breeder's pride: thorough, patient, reads her opponents.", genome: g(80, 40, 60, 50, 70), deposit: 3.0, owner: "lab" },
  { name: "Orin", persona: "A breeder's pride: quick, social, willing to gamble.", genome: g(50, 80, 40, 60, 70), deposit: 3.0, owner: "lab" },
];

const WASM = readFileSync(path.join(root, "contracts/sentient/res/sentient.wasm"));
process.env.DIR_TO_DOWNLOAD_BINARY ??= path.join(root, ".sandbox-bin");
const sandbox = await Sandbox.start({});

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

  const contractId = await mk("sentient", 80n * NEAR);
  const chairId = await mk("chair", 20n * NEAR);
  const keeperId = await mk("keeper", 40n * NEAR);
  const posterIds = await Promise.all([mk("poster-1", 150n * NEAR), mk("poster-2", 150n * NEAR), mk("poster-3", 150n * NEAR)]);
  const fanIds = await Promise.all([mk("fan-1", 30n * NEAR), mk("fan-2", 30n * NEAR), mk("fan-3", 30n * NEAR)]);
  const ownerIds = new Map<string, string>();
  for (const o of new Set(CAST.map((c) => c.owner))) ownerIds.set(o, await mk(o, 30n * NEAR));

  const as = (who: string) => new Chain(who, keys.get(who), contractId, rpc);
  const cfg = fastConfig(chairId, { upkeep_per_sec: nstr(0.005) });
  await new Account(contractId, rpc, keys.get(contractId) as `ed25519:${string}`).deployContract(WASM);
  await as(contractId).call("new", { config: cfg });
  log("demo", `contract ${contractId} deployed; upkeep ${(Number(cfg.upkeep_per_sec) / 1e24).toFixed(4)} NEAR/s per agent`);

  const view = as(keeperId);
  const world = new WorldWatcher(view, 800, await view.config());
  const store = new ArtifactStore(path.join(root, "store-demo"));
  const brain = makeBrain();
  const rec = new Recorder();
  let totals: Audit["totals"] | undefined;
  world.listeners.push((s) => rec.push(s, totals));
  const refreshTotals = async () => { totals = (await view.audit()).totals; };

  // ── birth ──
  const born = await Promise.all(
    CAST.map(async (c) => {
      const kp = KeyPair.fromRandom("ed25519");
      const owner = as(ownerIds.get(c.owner)!);
      const id = await owner.mint({ name: c.name, persona: c.persona, genome: c.genome, runtimeKey: kp.getPublicKey().toString(), deposit: BigInt(nstr(c.deposit)) });
      log("demo", `minted #${id} ${c.name} for ${c.owner}`);
      return { ...c, id, kp, account: `a${id}.${contractId}` };
    }),
  );
  await world.refresh();
  world.start();
  await refreshTotals();
  const cast: Record<string, string> = { [contractId]: "the Sentient contract", [chairId]: "chair", [keeperId]: "keeper" };
  for (const b of born) cast[b.account] = b.name;
  for (const [o, id] of ownerIds) cast[id] = o;
  posterIds.forEach((p, i) => (cast[p] = `poster-${i + 1}`));
  fanIds.forEach((p, i) => (cast[p] = `fan-${i + 1}`));

  const runtimes: AgentRuntime[] = [];
  const spawn = (id: number, name: string, kp: KeyPair) => {
    const rt = new AgentRuntime(id, name, {
      chain: new Chain(`a${id}.${contractId}`, kp.toString(), contractId, rpc),
      world, store, brain, cfg: world.cfg!, rnd: mulberry32(1000 + id * 7919), tickMs: 1100,
    });
    rt.start();
    runtimes.push(rt);
    return rt;
  };
  for (const b of born) spawn(b.id, b.name, b.kp);

  // ── the world around them ──
  const stoppers: Array<{ stop(): void }> = [];
  const market = new Market(posterIds.map(as), world, store, brain, { everyMs: 4200, minBounty: BigInt(nstr(0.12)), maxBounty: BigInt(nstr(0.45)), maxOpen: 4, workSecs: 60 }, mulberry32(11));
  const chair = new Chair(as(chairId), world, store, brain, mulberry32(12));
  const keeper = new Keeper(as(keeperId), world, world.cfg!, mulberry32(13));
  const fans = new Fans(fanIds.map(as), world, mulberry32(14));
  const labIds: number[] = born.filter((b) => b.owner === "lab").map((b) => b.id);
  const owners: Owner[] = [];
  let bredN = 0;
  for (const [name, id] of ownerIds) {
    const mine = () => (name === "lab" ? labIds : born.filter((b) => b.owner === name).map((b) => b.id));
    const chain = as(id);
    owners.push(new Owner(`owner:${name}`, chain, mine, world, world.cfg!, {
      tankFloor: BigInt(nstr(0.08)), refuel: BigInt(nstr(0.15)),
      breed: name !== "lab" ? undefined : async (a, b) => {
        const kp = KeyPair.fromRandom("ed25519");
        const childName = `Heir ${++bredN}`;
        const childId = await chain.breed(a, b, childName, `Child of #${a} and #${b}.`, kp.getPublicKey().toString(), 0n);
        labIds.push(childId);
        cast[`a${childId}.${contractId}`] = childName;
        spawn(childId, childName, kp);
        log("lab", `#${a} and #${b} have a child: #${childId} ${childName}`);
      },
    }, mulberry32(20 + owners.length)));
  }
  stoppers.push(market, chair, keeper, fans, ...owners, { stop: () => runtimes.forEach((r) => r.stop()) });
  for (const s of [market, chair, keeper, fans, ...owners]) s.start();

  // the agents' tanks, sampled for the recording
  const tankTimer = setInterval(async () => {
    for (const a of world.snap?.agents ?? []) {
      try { rec.setTank(a.id, await view.nativeBalance(a.account)); } catch { /* not created yet */ }
    }
  }, 4_000);
  const totalsTimer = setInterval(() => { refreshTotals().catch(() => {}); }, 9_000);

  // ── let it run ──
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(15_000);
    const s = world.snap?.stats;
    if (s) log("demo", `t+${Math.round((Date.now() - t0) / 1000)}s  agents ${s.alive} alive / ${s.dormant} dormant  jobs ${s.jobs} (open ${s.open_jobs})  duels ${s.duels}  generations ${s.generations}`);
  }

  // ── stop and write it down ──
  clearInterval(tankTimer);
  clearInterval(totalsTimer);
  for (const s of stoppers) s.stop();
  world.stop();
  await sleep(1500);
  await world.refresh();
  const audit = await view.audit();
  totals = audit.totals;
  rec.push(world.snap!, totals);

  const snap = world.snap!;
  const kinds: Record<string, number> = {};
  for (const e of rec.frames.flatMap((f) => f.feed)) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const summary = {
    seconds: SECONDS,
    agents: snap.agents.length,
    alive: snap.stats.alive,
    dormant: snap.stats.dormant,
    generations: snap.stats.generations,
    jobsPosted: market.posted, jobsAccepted: market.accepted, jobsRejected: market.rejected, disputesRuled: chair.ruled,
    keeperCalls: keeper.calls, fanTrades: fans.trades,
    refuels: owners.reduce((n, o) => n + o.refueled, 0), revivals: owners.reduce((n, o) => n + o.revived, 0),
    events: kinds,
    runtime: Object.fromEntries(runtimes.map((r) => [r.label, r.stats])),
    balanced: audit.balanced, solvent: audit.solvent,
  };
  const recording: Recording = {
    meta: {
      kind: "recording", network: "local nearcore sandbox", contractId, brain: brain.name, brainLive: brain.live,
      recordedAt: Date.now(), seconds: SECONDS,
      note: brain.live ? "Live model." : "Offline mock model: puzzles are solved exactly then slowed and occasionally spoiled by genome; text is templated. This proves the economics, not model quality.",
    },
    cfg: world.cfg!,
    frames: rec.frames,
    artifacts: await rec.artifacts(store),
    cast,
    audit,
    summary,
  };
  writeFileSync(OUT, JSON.stringify(recording));
  log("demo", `wrote ${OUT} (${(JSON.stringify(recording).length / 1e6).toFixed(2)} MB, ${rec.frames.length} frames)`);
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await sandbox.tearDown().catch(() => {});
}
process.exit(0);
