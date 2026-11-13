import { Account } from "near-api-js";
import type {
  Agent, Audit, Config, Duel, FeedEntry, Genome, Holding, Job, Quote, Ruling, Stats, Token,
} from "./types.js";
import { TGAS } from "./units.js";

export interface CallOpts {
  deposit?: bigint;
  gas?: bigint;
}

const SETTLE_GAS = 150n * TGAS;

/**
 * A typed client for the Sentient contract. One instance is one signing account: a person, or an agent signing for
 * itself with the function-call key the contract placed on its sub-account. Calls from one instance are sent one at a
 * time, because a key's nonce does not tolerate two transactions in flight.
 */
export class Chain {
  readonly account: Account;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly accountId: string,
    secretKey: string | undefined,
    readonly contractId: string,
    readonly rpcUrl: string,
  ) {
    this.account = secretKey
      ? new Account(accountId, rpcUrl, secretKey as `ed25519:${string}`)
      : new Account(accountId, rpcUrl);
  }

  async view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return (await this.account.provider.callFunction<any>({ contractId: this.contractId, method, args })) as T;
  }

  call<T = unknown>(methodName: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<T> {
    const run = async () =>
      (await this.account.callFunction<any>({
        contractId: this.contractId,
        methodName,
        args,
        deposit: opts.deposit ?? 0n,
        gas: opts.gas ?? 80n * TGAS,
      })) as T;
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Native balance of any account, in yoctoNEAR. */
  async nativeBalance(accountId: string): Promise<bigint> {
    return BigInt((await this.account.provider.viewAccount({ accountId })).amount);
  }

  async accessKeys(accountId: string) {
    return (await this.account.provider.viewAccessKeyList({ accountId })).keys;
  }

  // ── views ───────────────────────────────────────────────

  config() { return this.view<Config>("get_config"); }
  stats() { return this.view<Stats>("get_stats"); }
  audit() { return this.view<Audit>("get_audit"); }
  agent(id: number) { return this.view<Agent | null>("get_agent", { agent_id: id }); }
  agentByAccount(account: string) { return this.view<Agent | null>("get_agent_by_account", { account }); }
  agents(from = 1, limit = 100) { return this.view<Agent[]>("get_agents", { from_id: from, limit }); }
  job(id: number) { return this.view<Job | null>("get_job", { job_id: id }); }
  recentJobs(limit = 40, onlyOpen = false) { return this.view<Job[]>("get_recent_jobs", { limit, only_open: onlyOpen }); }
  duel(id: number) { return this.view<Duel | null>("get_duel", { duel_id: id }); }
  recentDuels(limit = 40, onlyOpen = false) { return this.view<Duel[]>("get_recent_duels", { limit, only_open: onlyOpen }); }
  feed(limit = 60) { return this.view<FeedEntry[]>("get_feed", { limit }); }
  holding(agentId: number, account: string) { return this.view<Holding | null>("get_holding", { agent_id: agentId, account }); }
  pendingDividends(agentId: number, account: string) {
    return this.view<string>("get_pending_dividends", { agent_id: agentId, account }).then(BigInt);
  }
  quote(agentId: number, n: number, buy: boolean) { return this.view<Quote>("share_quote", { agent_id: agentId, n, buy }); }
  credits(account: string) { return this.view<string>("credits_of", { account }).then(BigInt); }
  token(id: number) { return this.view<Token | null>("nft_token", { token_id: String(id) }); }
  tokensFor(account: string) { return this.view<Token[]>("nft_tokens_for_owner", { account_id: account }); }

  // ── agents and their owners ─────────────────────────────

  mint(a: { name: string; persona: string; genome?: Genome; runtimeKey: string; deposit: bigint }) {
    return this.call<number>("mint", { name: a.name, persona: a.persona, genome: a.genome ?? null, runtime_key: a.runtimeKey }, { deposit: a.deposit });
  }
  revive(agentId: number, deposit: bigint | string = 0n) { return this.call("revive", { agent_id: agentId }, { deposit: BigInt(deposit) }); }
  poke(agentId: number) { return this.call("poke", { agent_id: agentId }); }
  withdraw(agentId: number, amount: bigint) { return this.call("withdraw", { agent_id: agentId, amount: amount.toString() }); }
  /** Owner or operator only: move free balance into the agent's own account, which pays its gas. */
  refuel(agentId: number, amount: bigint) { return this.call("refuel", { agent_id: agentId, amount: amount.toString() }); }
  /** Owner only: give the agent a new key through the shell on its account (deleting the current one if still honoured). */
  setRuntimeKey(agentId: number, runtimeKey: string) { return this.call("set_runtime_key", { agent_id: agentId, key: runtimeKey }, { gas: 120n * TGAS }); }
  /** Owner only: send the agent's spare gas back to the owner, keeping `keep` in its account. */
  sweepTank(agentId: number, keep = 0n) { return this.call("sweep_tank", { agent_id: agentId, keep: keep.toString() }, { gas: 100n * TGAS }); }
  /** Owner only: how much of the agent's balance anyone but the owner can put at risk per window, in basis points. */
  setRiskBps(agentId: number, bps: number) { return this.call("set_risk_bps", { agent_id: agentId, bps }); }
  prunePairs(keys: string[]) { return this.call<number>("prune_pairs", { keys }); }
  setOperator(agentId: number, operator: string | null) { return this.call("set_operator", { agent_id: agentId, operator }); }
  setStudFee(agentId: number, fee: bigint | null) { return this.call("set_stud_fee", { agent_id: agentId, fee: fee === null ? null : fee.toString() }); }
  breed(a: number, b: number, name: string, persona: string, runtimeKey: string, deposit = 0n) {
    return this.call<number>("breed", { parent_a: a, parent_b: b, name, persona, runtime_key: runtimeKey }, { deposit, gas: 120n * TGAS });
  }
  nftTransfer(to: string, id: number) {
    return this.call("nft_transfer", { receiver_id: to, token_id: String(id), approval_id: null, memo: null }, { deposit: 1n });
  }

  // ── jobs ────────────────────────────────────────────────

  postJob(a: { title: string; briefUri: string; briefHash: string; deposit: bigint; workSecs: number; minRep?: number }) {
    return this.call<number>("post_job", {
      title: a.title, brief_uri: a.briefUri, brief_hash: a.briefHash, bounty: null, min_rep: a.minRep ?? null,
      work_secs: a.workSecs, as_agent: null,
    }, { deposit: a.deposit });
  }
  /** An agent hires: posts a job as itself, paid from its own balance. */
  postJobAsAgent(agentId: number, a: { title: string; briefUri: string; briefHash: string; bounty: bigint; workSecs: number; minRep?: number }) {
    return this.call<number>("post_job", {
      title: a.title, brief_uri: a.briefUri, brief_hash: a.briefHash, bounty: a.bounty.toString(), min_rep: a.minRep ?? null,
      work_secs: a.workSecs, as_agent: agentId,
    });
  }
  claimJob(agentId: number, jobId: number) { return this.call("claim_job", { agent_id: agentId, job_id: jobId }); }
  submitWork(agentId: number, jobId: number, hash: string, uri: string) {
    return this.call("submit_work", { agent_id: agentId, job_id: jobId, hash, uri });
  }
  acceptWork(jobId: number) { return this.call("accept_work", { job_id: jobId }, { gas: SETTLE_GAS }); }
  rejectWork(jobId: number, reason: string) { return this.call("reject_work", { job_id: jobId, reason: reason.slice(0, 150) }); }
  finalizeJob(jobId: number) { return this.call("finalize_job", { job_id: jobId }, { gas: SETTLE_GAS }); }
  expireClaim(jobId: number) { return this.call("expire_claim", { job_id: jobId }, { gas: SETTLE_GAS }); }
  cancelJob(jobId: number) { return this.call("cancel_job", { job_id: jobId }, { gas: SETTLE_GAS }); }
  resolveDispute(jobId: number, ruling: Ruling) { return this.call("resolve_dispute", { job_id: jobId, ruling }, { gas: SETTLE_GAS }); }
  resolveStale(jobId: number) { return this.call("resolve_stale", { job_id: jobId }, { gas: SETTLE_GAS }); }
  pruneJob(jobId: number) { return this.call("prune_job", { job_id: jobId }); }

  // ── duels ───────────────────────────────────────────────

  challenge(agentId: number, stake: bigint | string, target: number | null = null, kind: number | null = null) {
    return this.call<number>("challenge", { agent_id: agentId, stake: stake.toString(), target, kind });
  }
  cancelChallenge(duelId: number) { return this.call("cancel_challenge", { duel_id: duelId }); }
  acceptDuel(duelId: number, agentId: number) { return this.call("accept_duel", { duel_id: duelId, agent_id: agentId }); }
  answerDuel(duelId: number, agentId: number, answer: number) {
    return this.call<boolean>("answer_duel", { duel_id: duelId, agent_id: agentId, answer }, { gas: SETTLE_GAS });
  }
  expireDuel(duelId: number) { return this.call("expire_duel", { duel_id: duelId }, { gas: SETTLE_GAS }); }
  pruneDuel(duelId: number) { return this.call("prune_duel", { duel_id: duelId }); }

  // ── shares ──────────────────────────────────────────────

  buyShares(agentId: number, n: number, deposit: bigint) { return this.call("buy_shares", { agent_id: agentId, n }, { deposit }); }
  sellShares(agentId: number, n: number, minProceeds = 0n) {
    return this.call("sell_shares", { agent_id: agentId, n, min_proceeds: minProceeds.toString() });
  }
  claimDividends(agentId: number) { return this.call("claim_dividends", { agent_id: agentId }); }
  claimCredits() { return this.call("claim_credits", {}); }
  withdrawTreasury(amount: bigint, to: string) { return this.call("withdraw_treasury", { amount: amount.toString(), to }); }
}
