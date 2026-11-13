/**
 * Mint an agent and save the key its runtime will sign with.
 *
 *   NETWORK=testnet CONTRACT_ID=... OWNER_ID=you.testnet OWNER_KEY=ed25519:... \
 *     npm run mint -- --name Ada --persona "careful and dull" --genome 80,30,60,40,70 --deposit 1.5
 *
 * Without --genome one is drawn at random. The runtime key is written to .agents/<id>.json (gitignored): it is a
 * function-call key, so losing it costs the agent its voice, not its owner any money.
 */
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import "dotenv/config";
import { KeyPair } from "near-api-js";
import { Chain } from "../src/lib/near.js";
import { nstr } from "../src/lib/defaults.js";
import type { Genome } from "../src/lib/types.js";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

const network = process.env.NETWORK ?? "testnet";
const rpc = process.env.RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com");
const contractId = need("CONTRACT_ID");
const owner = new Chain(need("OWNER_ID"), need("OWNER_KEY"), contractId, rpc);

let genome: Genome | undefined;
const gs = arg("genome");
if (gs) {
  const t = gs.split(",").map((x) => Number(x.trim()));
  if (t.length !== 5 || t.some((x) => !Number.isInteger(x) || x < 0 || x > 100) || t.reduce((a, b) => a + b, 0) > 300) {
    throw new Error("--genome is five whole numbers, diligence,boldness,thrift,sociability,cunning, each 0-100, summing to at most 300");
  }
  const [diligence, boldness, thrift, sociability, cunning] = t;
  genome = { diligence, boldness, thrift, sociability, cunning };
}
const deposit = Number(arg("deposit", "1.5"));
if (!(deposit > 0)) throw new Error("--deposit is an amount of NEAR");
const kp = KeyPair.fromRandom("ed25519");
const name = arg("name", "Agent")!;

// Save the key BEFORE minting. If the process died between the mint and the write, the agent would exist with a key nobody
// kept; this way the worst case is a stray pending file. The owner could always re-key it with `set_runtime_key`.
mkdirSync(".agents", { recursive: true });
const pending = `.agents/pending-${Date.now()}.json`;
writeFileSync(pending, JSON.stringify({ name, contractId, network, rpc, secretKey: kp.toString() }, null, 2), { mode: 0o600 });
let id: number;
try {
  id = await owner.mint({ name, persona: arg("persona", "")!, genome, runtimeKey: kp.getPublicKey().toString(), deposit: BigInt(nstr(deposit)) });
  if (!Number.isInteger(id)) throw new Error(`the contract returned ${JSON.stringify(id)} instead of an agent id`);
} catch (e) {
  // A timeout does not mean the mint failed, so the key is kept: if the agent exists, this file is its runtime key.
  console.error(`mint failed or could not be confirmed. If the agent was minted, its runtime key is in ${pending} (check with the contract's nft_tokens_for_owner).`);
  throw e;
}
const account = `a${id}.${contractId}`;
writeFileSync(`.agents/${id}.json`, JSON.stringify({ id, name, account, contractId, network, rpc, secretKey: kp.toString() }, null, 2), { mode: 0o600 });
unlinkSync(pending);
console.log(`minted #${id} ${name}: its account is ${account}; runtime key saved to .agents/${id}.json`);
console.log(`run it with: npm run run-agent -- ${id}`);
