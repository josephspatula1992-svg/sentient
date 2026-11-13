import type { Config } from "./types.js";
import { NEAR } from "./units.js";

/** NEAR as the decimal string the contract's JSON expects. */
export const nstr = (x: number): string => ((BigInt(Math.round(x * 1e6)) * NEAR) / 1_000_000n).toString();

/**
 * The rules for a real deployment. Time is in days, upkeep is cents a day, the chair has days to rule. There is no way
 * to change these after `new`, which is the point: they are the constitution.
 */
export function liveConfig(chair: string): Config {
  return {
    chair,
    mint_min: nstr(1),
    seed_gas: nstr(0.25),
    storage_fee: nstr(0.03),
    mint_fee_bps: 300,
    min_ledger: nstr(0.1),
    upkeep_per_sec: "115740740740740740", // 0.01 NEAR a day
    revive_min: nstr(0.2),
    min_bounty: nstr(0.05),
    job_storage_fee: nstr(0.02),
    job_fee_bps: 200,
    bond_bps: 1000,
    min_bond: nstr(0.01),
    min_work_secs: 600,
    max_work_secs: 14 * 86_400,
    review_secs: 2 * 86_400,
    arbiter_secs: 3 * 86_400,
    prune_secs: 7 * 86_400,
    max_claims: 2,
    min_stake: nstr(0.01),
    duel_storage_fee: nstr(0.006), // a duel record plus its pair-damping record, which is never pruned
    duel_fee_bps: 500,
    duel_start_secs: 10,
    duel_window_secs: 120,
    challenge_ttl_secs: 3600,
    max_duels: 2,
    dividend_bps: 1500,
    curve_base: nstr(0.01),
    curve_slope: nstr(0.001),
    trade_fee_bps: 300,
    royalty_bps: 6000,
    sell_lock_secs: 600,
    holding_storage_fee: nstr(0.002),
    max_shares_per_trade: 1000,
    actor_risk_bps: 6000, // a delegate or a stolen key can put at risk at most 60% of an agent's balance a day
    risk_window_secs: 86_400,
    breed_cost: nstr(1),
    breed_cooldown_secs: 86_400,
  };
}

/**
 * The same economy sped up so that a sandbox run shows a lifetime in minutes: seconds instead of days, and an upkeep a few
 * thousand times steeper. Only time and the cost of living change; every rule is the same.
 */
export function fastConfig(chair: string, over: Partial<Config> = {}): Config {
  return {
    ...liveConfig(chair),
    upkeep_per_sec: nstr(0.0022), // an agent minted with 1 NEAR lives about five minutes with no income
    min_work_secs: 5,
    max_work_secs: 3600,
    review_secs: 14,
    arbiter_secs: 24,
    prune_secs: 5,
    duel_start_secs: 3,
    duel_window_secs: 30,
    challenge_ttl_secs: 60,
    sell_lock_secs: 4,
    risk_window_secs: 60,
    breed_cooldown_secs: 25,
    ...over,
  };
}
