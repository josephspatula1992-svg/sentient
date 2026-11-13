/** Shapes the contract returns. Money is always a decimal string of yoctoNEAR. */

export interface Genome {
  diligence: number;
  boldness: number;
  thrift: number;
  sociability: number;
  cunning: number;
}

export const TRAITS = ["diligence", "boldness", "thrift", "sociability", "cunning"] as const;

export interface Agent {
  id: number;
  owner: string;
  account: string;
  key: string;
  key_bound: boolean;
  operator: string | null;
  name: string;
  persona: string;
  genome: Genome;
  generation: number;
  parents: [number, number] | null;
  born: number;
  dormant: boolean;
  revivals: number;
  ledger: string;
  locked: string;
  last_upkeep: number;
  jobs_done: number;
  jobs_failed: number;
  duel_wins: number;
  duel_losses: number;
  earned: string;
  lost: string;
  upkeep_paid: string;
  reputation: number;
  rating: number;
  breed_ready_at: number;
  risk_bps: number;
  win_start: number;
  win_base: string;
  win_lost: string;
  stud_fee: string | null;
  offspring: number;
  active_claims: number;
  active_duels: number;
  shares: number;
  reserve: string;
  div_acc: string;
  div_pool: string;
  last_active: number;
  // added by the view
  live_ledger: string;
  live_dormant: boolean;
  runway_secs: number;
  share_price: string;
}

export type JobStatus = "Open" | "Claimed" | "Submitted" | "Disputed" | "Paid" | "Refunded" | "Split" | "Cancelled";
export type DuelStatus = "Open" | "Live" | "Settled" | "Drawn" | "Cancelled";
export type Ruling = "PayWorker" | "RefundPoster" | "Split";

export interface Job {
  id: number;
  poster: string;
  poster_owner: string;
  poster_agent: number | null;
  title: string;
  brief_uri: string;
  brief_hash: string;
  bounty: string;
  bond: string;
  min_rep: number;
  work_secs: number;
  status: JobStatus;
  posted: number;
  worker: number | null;
  claimed_at: number;
  deadline: number;
  sub_hash: string;
  sub_uri: string;
  submitted_at: number;
  dispute_reason: string;
  disputed_at: number;
  barred: number[];
  attempts: number;
  settled_at: number;
  paid_worker: string;
}

export interface Duel {
  id: number;
  kind: number | null;
  params: [number, number, number, number];
  question: string;
  a: number;
  b: number | null;
  target: number | null;
  stake: string;
  status: DuelStatus;
  created: number;
  live_at: number;
  deadline: number;
  wrong_a: boolean;
  wrong_b: boolean;
  winner: number | null;
  rating_swing: number;
  settled_at: number;
}

export interface FeedEntry {
  seq: number;
  ts: number;
  kind: string;
  a: number;
  b: number;
  amount: string;
  note: string;
}

export interface Totals {
  received: string;
  sent: string;
  ledgers: string;
  locked: string;
  escrow: string;
  reserves: string;
  dividends: string;
  treasury: string;
  credits: string;
}

export interface Audit {
  totals: Totals;
  liabilities: string;
  balanced: boolean;
  balance: string;
  storage_staked: string;
  surplus: string;
  solvent: boolean;
}

export interface Stats {
  agents: number;
  alive: number;
  dormant: number;
  jobs: number;
  open_jobs: number;
  duels: number;
  live_duels: number;
  generations: number;
  feed_seq: number;
  now: number;
}

export interface Holding {
  shares: number;
  snap: string;
  pending: string;
  last_buy: number;
}

export interface Quote {
  price: string;
  fee: string;
  total: string;
}

export interface Config {
  chair: string;
  mint_min: string;
  seed_gas: string;
  storage_fee: string;
  mint_fee_bps: number;
  min_ledger: string;
  upkeep_per_sec: string;
  revive_min: string;
  min_bounty: string;
  job_storage_fee: string;
  job_fee_bps: number;
  bond_bps: number;
  min_bond: string;
  min_work_secs: number;
  max_work_secs: number;
  review_secs: number;
  arbiter_secs: number;
  prune_secs: number;
  max_claims: number;
  min_stake: string;
  duel_storage_fee: string;
  duel_fee_bps: number;
  duel_start_secs: number;
  duel_window_secs: number;
  challenge_ttl_secs: number;
  max_duels: number;
  dividend_bps: number;
  curve_base: string;
  curve_slope: string;
  trade_fee_bps: number;
  royalty_bps: number;
  sell_lock_secs: number;
  holding_storage_fee: string;
  max_shares_per_trade: number;
  actor_risk_bps: number;
  risk_window_secs: number;
  breed_cost: string;
  breed_cooldown_secs: number;
}

export interface Token {
  token_id: string;
  owner_id: string;
  metadata: { title: string; description: string; media: string; copies: number; extra: string };
}

/** The methods an agent's own key may call. Must equal the contract's AGENT_METHODS. */
export const AGENT_METHODS = [
  "post_job", "claim_job", "submit_work", "accept_work", "reject_work", "finalize_job", "expire_claim", "cancel_job",
  "challenge", "accept_duel", "answer_duel", "cancel_challenge", "expire_duel", "poke",
];
