/**
 * Look at what an agent delivered for your job, check it against your brief, and accept or reject it.
 *
 *   POSTER_ID=you.testnet POSTER_KEY=ed25519:... CONTRACT_ID=... npm run review-job -- 7            # show the verdict
 *   ... npm run review-job -- 7 --accept                                                             # pay the worker
 *   ... npm run review-job -- 7 --reject                                                             # send it to the chair
 *
 * The deliverable is fetched by the hash the worker committed on chain and refused if it does not match. If the worker's
 * machine is not this one, list it in ARTIFACT_HOSTS (host[:port], comma separated). The rubric is the same one the chair
 * uses in a dispute, so a rejection it would not back is one you are likely to lose.
 */
import "dotenv/config";
import { Chain } from "../src/lib/near.js";
import { ArtifactStore } from "../src/lib/store.js";
import { grade, parseBrief } from "../src/lib/jobs.js";
import { fmt } from "../src/lib/units.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};
const id = Number(process.argv[2]);
if (!Number.isInteger(id)) throw new Error("usage: npm run review-job -- <job id> [--accept | --reject]");
const accept = process.argv.includes("--accept");
const reject = process.argv.includes("--reject");
if (accept && reject) throw new Error("choose --accept or --reject, not both");

const network = process.env.NETWORK ?? "testnet";
const rpc = process.env.RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com");
const chain = new Chain(need("POSTER_ID"), need("POSTER_KEY"), need("CONTRACT_ID"), rpc);
const store = new ArtifactStore(
  process.env.STORE_DIR ?? "store",
  process.env.ARTIFACT_BASE ?? "",
  (process.env.ARTIFACT_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
);

const job = await chain.job(id);
if (!job) throw new Error(`no job #${id} (it may have been pruned after it finished)`);
if (job.poster !== chain.accountId) throw new Error(`job #${id} was posted by ${job.poster}, not ${chain.accountId}`);
console.log(`job #${id} "${job.title}": ${job.status}, bounty ${fmt(job.bounty)} NEAR`);
if (job.status !== "Submitted") {
  console.log(job.status === "Open" ? "nobody has taken it yet." : job.status === "Claimed" ? `agent #${job.worker} is working on it.` : "nothing to review.");
  process.exit(0);
}

const cfg = await chain.config();
const left = job.submitted_at + cfg.review_secs - (await chain.stats()).now;
console.log(`delivered by agent #${job.worker}; ${left > 0 ? `${Math.round(left / 60)} min left to decide before silence pays the worker` : "the review window is over: anyone can now finalize it, you can no longer reject"}`);

const brief = parseBrief(await store.get(job.brief_uri, job.brief_hash));
const text = await store.get(job.sub_uri, job.sub_hash);
const verdict = grade(brief, text);
console.log(`\n--- the delivery ---\n${text}\n--------------------\nrubric: score ${verdict.score}, ${verdict.pass ? "PASS" : "FAIL"}${verdict.reasons.length ? ` (${verdict.reasons.join("; ")})` : ""}`);

if (accept) {
  await chain.acceptWork(id);
  console.log("accepted: the worker is paid.");
} else if (reject) {
  if (verdict.pass) console.warn("warning: the rubric passes this delivery, so the chair is likely to rule for the worker.");
  await chain.rejectWork(id, verdict.reasons.join("; ") || "rejected by the poster");
  console.log("rejected: the chair decides.");
} else {
  console.log(`\nre-run with --accept or --reject to act.`);
}
