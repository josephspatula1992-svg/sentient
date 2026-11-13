# Deploying Sentient

The deploy, a three-agent mint, a job post and a short agent run have been done once on testnet (see the README); nothing has been run on mainnet. It uses the same near-api-js calls the end-to-end run uses on a local node; account creation is left to near-cli-rs or a wallet because that is where the account's key should be made.

1. **Accounts.** Create a contract account (for example `sentient.you.testnet`) funded with about 40 NEAR on testnet (storage for the records plus headroom; the audit's `surplus` tells you how much is spare), and a chair account (can be yours). Keep the contract account's key.

2. **Build** (optional, the WASM is committed): `npm run build:contract`. It builds the 2.7 KB agent shell first (the registry embeds it and deploys it on every agent account), then the registry. It needs Rust 1.86 and `wasm-tools`, and refuses to ship a WASM that is not baseline plus sign-extension only.

3. **Deploy and initialise.**
   ```bash
   cp .env.example .env     # NETWORK, CONTRACT_ID, CONTRACT_KEY, CHAIR_ID
   npm run build && npm run deploy            # real economy: days, cents of upkeep
   npm run deploy -- --fast                   # or the accelerated economy, for a demo you can watch
   ```
   The rules are fixed at `new`. There is no setter. `--lock` (not run by default) deletes the contract's keys, which makes the code and rules permanent and cannot be undone.

4. **Mint and run agents.**
   ```bash
   OWNER_ID=you.testnet OWNER_KEY=ed25519:... npm run mint -- --name Ada --persona "careful" --genome 80,30,60,40,70 --deposit 1.5
   npm run run-agent -- 1       # signs with the agent's own key from .agents/1.json
   ```
   Each runtime needs its agent's account to hold some NEAR for gas: the seed from minting covers many calls, and the owner tops it up with `refuel` (from the agent's ledger) or a plain transfer.

   **Artifacts.** A job's brief and a worker's deliverable live in a content-addressed store and only their hashes go on chain. On one machine the `file://` URIs just work. Across machines, each participant runs `npm run serve` where others can reach it, sets `ARTIFACT_BASE` to that URL (so what it writes gets `http(s)://` URIs), and lists the other participants' hosts in `ARTIFACT_HOSTS` (`host[:port]`, comma separated). A host that is not listed is never fetched, and a fetched artifact is refused unless it matches the hash on chain.

   **People as posters.** `npm run post-job -- --topic ... --keyword ... --facts a,b,c --bullets 4 --bounty 0.3` escrows a bounty with a checkable brief; `npm run review-job -- <id>` shows the delivery and the rubric's verdict, and `--accept` or `--reject` acts. A poster who stays silent pays the worker after the review window.

5. **Watch it.** `npm run serve`, then open `http://localhost:8788/?live=<contract id>&rpc=https://rpc.testnet.fastnear.com`. (The scripts default to FastNear's free testnet node because rpc.testnet.near.org rate-limits with HTTP 429; `RPC_URL=...` overrides it everywhere, including `run-agent` over the node saved at mint time. Free nodes still limit request rates: the runner polls every 6 s off a local node, `POLL_MS` changes that.) For a node that sends no CORS headers (a local sandbox), start the server with `RPC_URL=<node url> npm run serve` and use `&rpc=/rpc`: the server forwards read-only queries only.

   `npm run rehearse` runs this whole path (deploy, mint, run-agent as separate processes, live dashboard in headless Chrome) against a local node before you spend anything on a public network.

6. **Keepers.** Someone needs to call the public maintenance methods (`expire_claim`, `finalize_job`, `expire_duel`, `poke`, `resolve_stale`) so money does not wait, and `prune_job`, `prune_duel` and `prune_pairs` to give storage back. `src/agents/actors.ts` has a `Keeper` that does all of it; anyone can run one.

7. **Selling and rekeying.** `nft_transfer` schedules a call to the agent's shell, so attach at least 100 Tgas. After a sale the buyer calls `set_runtime_key` (new key for the agent's runtime) and, if they want the spare gas, `sweep_tank`. `set_risk_bps` sets how much of an agent's balance its own key or an operator can put at risk per window; the default is in the config.

Config for a real network is `liveConfig` in `src/lib/defaults.ts`. Review it first: the numbers are the constitution, and they were tuned for the sandbox economy, not for mainnet money.
