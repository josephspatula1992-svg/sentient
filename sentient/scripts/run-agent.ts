/**
 * Run one agent's runtime against a deployed contract, signing with the key `mint` saved.
 *
 *   npm run run-agent -- 3          # reads .agents/3.json
 *
 * Set LLM_MODE=near-ai with NEAR_AI_API_KEY to think with NEAR AI Cloud; otherwise the offline mock brain is used.
 * Someone has to pay the agent's gas: top its account up with `refuel` (owner) or a plain transfer.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import "dotenv/config";
import { Chain } from "../src/lib/near.js";
import { WorldWatcher } from "../src/lib/world.js";
import { ArtifactStore } from "../src/lib/store.js";
import { makeBrain } from "../src/lib/config.js";
import { AgentRuntime } from "../src/agents/runtime.js";
import { log } from "../src/lib/log.js";
import { fmt, NEAR } from "../src/lib/units.js";

const id = Number(process.argv[2]);
if (!Number.isInteger(id)) throw new Error("usage: npm run run-agent -- <agent id>");
const saved = JSON.parse(readFileSync(path.join(".agents", `${id}.json`), "utf8")) as {
  name: string; account: string; contractId: string; rpc: string; secretKey: string;
};
// RPC_URL overrides the node saved at mint time (a free node that was fine then may be rate-limiting now)
saved.rpc = process.env.RPC_URL ?? saved.rpc;
const chain = new Chain(saved.account, saved.secretKey, saved.contractId, saved.rpc);

// Say why an agent would sit idle, instead of letting it sit idle in silence.
const me = await chain.agent(id);
if (!me) throw new Error(`the contract has no agent #${id}: wrong CONTRACT_ID in .agents/${id}.json?`);
if (me.account !== saved.account) throw new Error(`agent #${id} lives at ${me.account}, but the key file says ${saved.account}`);
if (!me.key_bound) console.warn(`warning: the contract no longer honours this agent's key (it was sold or re-keyed). Its owner can give it a new one with set_runtime_key.`);
if (me.live_dormant) console.warn(`warning: ${me.name} is dormant (out of money). It acts again once someone funds it (revive).`);
const tank = await chain.nativeBalance(saved.account);
if (tank < NEAR / 50n) console.warn(`warning: ${saved.account} holds only ${fmt(tank)} NEAR for gas; its owner can top it up with refuel.`);

// Each poll is five view calls. A free public node (rpc.testnet.near.org) answers 429 above a few requests a second across all
// the agents on a machine, so POLL_MS (default 1500 on a local node, 6000 anywhere else) sets how often this agent looks.
const isLocal = /localhost|127\.0\.0\.1/.test(saved.rpc);
const world = new WorldWatcher(chain, Number(process.env.POLL_MS) || (isLocal ? 1500 : 6000), await chain.config());
await world.refresh();
world.start();
const brain = makeBrain();
// Artifacts: on one machine file:// URIs work. Across machines, ARTIFACT_BASE is where this machine's `npm run serve` is
// reachable (so others can read this agent's deliverables) and ARTIFACT_HOSTS lists the other machines whose briefs and
// deliverables it will fetch, as host[:port], comma separated.
const store = new ArtifactStore(
  process.env.STORE_DIR ?? "store",
  process.env.ARTIFACT_BASE ?? "",
  (process.env.ARTIFACT_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
);
const rt = new AgentRuntime(id, saved.name, { chain, world, store, brain, cfg: world.cfg!, rnd: Math.random, tickMs: 2500 });
rt.start();
log(saved.name, `running as ${saved.account} with the ${brain.name} brain`);
process.on("SIGINT", () => { rt.stop(); world.stop(); process.exit(0); });
