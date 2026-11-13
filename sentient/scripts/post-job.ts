/**
 * Post a job as a person: escrow a bounty, with a brief the agents can check their work against.
 *
 *   POSTER_ID=you.testnet POSTER_KEY=ed25519:... CONTRACT_ID=... \
 *     npm run post-job -- --topic "How NEAR chain signatures work" --keyword MPC --facts signature,threshold,key --bullets 4 --bounty 0.3
 *
 * The brief is saved in the artifact store and only its hash goes on chain. Agents on other machines can read it if this
 * machine's `npm run serve` is reachable at ARTIFACT_BASE (otherwise the brief is a file:// URI that only this machine can
 * open). Review the delivery later with `npm run review-job -- <id>`; a poster who stays silent pays the worker after the
 * review window, so do look.
 */
import "dotenv/config";
import { Chain } from "../src/lib/near.js";
import { ArtifactStore } from "../src/lib/store.js";
import { briefText, type Brief } from "../src/lib/jobs.js";
import { fmt } from "../src/lib/units.js";
import { nstr } from "../src/lib/defaults.js";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const must = (n: string) => {
  const v = arg(n);
  if (!v) throw new Error(`--${n} is required`);
  return v;
};

const network = process.env.NETWORK ?? "testnet";
const rpc = process.env.RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com");
const chain = new Chain(need("POSTER_ID"), need("POSTER_KEY"), need("CONTRACT_ID"), rpc);

const brief: Brief = {
  topic: must("topic"),
  keyword: must("keyword"),
  facts: must("facts").split(",").map((f) => f.trim().toLowerCase()).filter(Boolean),
  bullets: Number(arg("bullets", "3")),
};
if (!Number.isInteger(brief.bullets) || brief.bullets < 1 || brief.bullets > 12) throw new Error("--bullets is 1 to 12");
if (brief.facts.length === 0) throw new Error("--facts needs at least one word a good answer would touch");

const cfg = await chain.config();
const bounty = BigInt(nstr(Number(arg("bounty", "0.2"))));
if (bounty < BigInt(cfg.min_bounty)) throw new Error(`--bounty is below the minimum of ${fmt(cfg.min_bounty)} NEAR`);
const workSecs = Number(arg("work-secs", String(Math.max(cfg.min_work_secs, 3600))));
if (!(workSecs >= cfg.min_work_secs && workSecs <= cfg.max_work_secs)) throw new Error(`--work-secs must be ${cfg.min_work_secs} to ${cfg.max_work_secs}`);

const store = new ArtifactStore(process.env.STORE_DIR ?? "store", process.env.ARTIFACT_BASE ?? "");
const blob = store.put(briefText(brief));
const deposit = bounty + BigInt(cfg.job_storage_fee);
const minRep = arg("min-rep") === undefined ? undefined : Number(arg("min-rep"));
const id = await chain.postJob({ title: brief.topic.slice(0, 78), briefUri: blob.uri, briefHash: blob.hash, deposit, workSecs, minRep });
console.log(`posted job #${id}: ${fmt(bounty)} NEAR bounty (+${fmt(cfg.job_storage_fee)} storage fee), ${Math.round(workSecs / 60)} min to work`);
if (blob.uri.startsWith("file://")) {
  console.log("note: the brief is a file:// URI, so only this machine can read it. Set ARTIFACT_BASE and run `npm run serve` for other machines' agents.");
}
console.log(`later: npm run review-job -- ${id}   (you have ${Math.round(cfg.review_secs / 60)} min after delivery before silence pays the worker)`);
