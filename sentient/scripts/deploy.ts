/**
 * Deploy the contract to testnet or mainnet (or a local node) and initialise it.
 *
 *   NETWORK=testnet CONTRACT_ID=sentient.you.testnet CONTRACT_KEY=ed25519:... CHAIR_ID=you.testnet npm run deploy
 *
 * The contract account must already exist and hold enough NEAR (create it with near-cli-rs or a wallet; see DEPLOY.md).
 * Flags:
 *   --fast                     the accelerated economy (seconds, not days) instead of the real one
 *   --init-only                initialise an account that has the code but was never initialised (after an interrupted run)
 *   --lock                     delete the contract's keys afterwards, which makes the code and rules permanent. Irreversible.
 *                              Needs CONFIRM_LOCK=yes in the environment as well.
 *   --i-know-this-is-mainnet   required for NETWORK=mainnet
 *
 * It refuses to touch an account that already has code, checks the result after deploying, and prints the dashboard URL.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Account, KeyPair } from "near-api-js";
import { Chain } from "../src/lib/near.js";
import { fastConfig, liveConfig } from "../src/lib/defaults.js";
import { fmt, NEAR } from "../src/lib/units.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const flag = (f: string) => process.argv.includes(f);
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k} (see .env.example)`);
  return v;
};
const die = (msg: string): never => {
  console.error(`deploy: ${msg}`);
  process.exit(1);
};

const network = process.env.NETWORK ?? "testnet";
if (network === "mainnet" && !flag("--i-know-this-is-mainnet")) die("mainnet needs --i-know-this-is-mainnet");
const rpc = process.env.RPC_URL ?? (network === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.fastnear.com");
const contractId = need("CONTRACT_ID");
const key = need("CONTRACT_KEY") as `ed25519:${string}`;
const chair = need("CHAIR_ID");
const minBalance = BigInt(Math.round(Number(process.env.MIN_CONTRACT_BALANCE_NEAR ?? "30") * 1e6)) * (NEAR / 1_000_000n);
const wasm = readFileSync(path.join(root, "contracts/sentient/res/sentient.wasm"));

if (contractId.length > 50) die(`${contractId} is too long: agent accounts are a<id>.${contractId} and must fit in 64 characters`);
if (flag("--lock") && process.env.CONFIRM_LOCK !== "yes") die("--lock deletes the contract's keys for good. Set CONFIRM_LOCK=yes to confirm");

const account = new Account(contractId, rpc, key);
const state = await account.provider.viewAccount({ accountId: contractId }).catch((e: Error) => die(`cannot read ${contractId} on ${rpc}: ${e.message}`));
const balance = BigInt((state as { amount: string | bigint }).amount);
if (balance < minBalance) die(`${contractId} holds ${fmt(balance)} NEAR; fund it to at least ${fmt(minBalance)} (storage for records and the event ring, plus headroom)`);
// The chair cannot be changed once the contract is initialised, so a typo here would leave nobody able to rule on a dispute
// or withdraw revenue for good. Check that the account exists.
await account.provider.viewAccount({ accountId: chair }).catch(() => die(`the chair account ${chair} does not exist on ${rpc}`));

const fast = flag("--fast");
const chain = new Chain(contractId, key, contractId, rpc);
const hasCode = (state as { code_hash: string }).code_hash !== "11111111111111111111111111111111";
if (hasCode) {
  // Either a finished deployment, or one that was deployed but never initialised (for example `new` failed).
  const initialised = await chain.config().then(() => true, () => false);
  if (initialised) die(`${contractId} already has an initialised contract. This script only sets up a fresh account.`);
  if (!flag("--init-only")) {
    die(`${contractId} has code but was never initialised (a previous run stopped after deploying?). Re-run with --init-only to initialise it.`);
  }
  console.log(`${contractId} has code but is not initialised: initialising it`);
} else {
  if (flag("--init-only")) die("--init-only is for an account that already has the code");
  console.log(`deploying ${wasm.length} bytes to ${contractId} on ${network} (${rpc}), balance ${fmt(balance)} NEAR`);
  await account.deployContract(wasm);
}
await chain.call("new", { config: fast ? fastConfig(chair) : liveConfig(chair) });

// check what is now on chain, not what we sent
const cfg = await chain.config();
const audit = await chain.audit();
if (cfg.chair !== chair) die(`the deployed contract's chair is ${cfg.chair}, expected ${chair}`);
if (!audit.balanced || !audit.solvent) die("the deployed contract's books are not balanced and solvent");
console.log(`initialised with the ${fast ? "fast" : "live"} economy, chair ${chair}; books balanced, surplus ${fmt(audit.surplus)} NEAR`);

if (flag("--lock")) {
  // delete every other key first, and the one that signs last, or the first deletion would strand the rest
  const keys = (await account.provider.viewAccessKeyList({ accountId: contractId })).keys.map((k) => k.public_key);
  const own = KeyPair.fromString(key).getPublicKey().toString();
  for (const k of [...keys.filter((k) => k !== own), ...keys.filter((k) => k === own)]) await account.deleteKey(k);
  const left = (await account.provider.viewAccessKeyList({ accountId: contractId })).keys.length;
  if (left !== 0) die(`${left} keys remain on ${contractId}`);
  console.log("contract keys deleted: the code and the rules can no longer change");
}

const live = `http://localhost:8788/?live=${encodeURIComponent(contractId)}&rpc=${encodeURIComponent(rpc)}`;
console.log(`next: npm run mint -- --name Ada --genome 80,30,60,40,70, then npm run run-agent -- 1`);
console.log(`watch it: npm run serve, then open ${live}`);
