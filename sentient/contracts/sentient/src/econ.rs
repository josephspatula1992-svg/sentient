//! Pure money maths: the share bonding curve, dividend accounting, Elo and the repeat-pair damping.
//!
//! Nothing here touches storage, so every rule can be tested to the yocto.

/// Shares of one agent sit on a linear curve: the n-th share costs `base + slope * n`.
///
/// `integral(s)` is the total paid in to take the supply from 0 to `s`. The reserve held for an agent is always exactly
/// `integral(supply)`: buying n shares adds `integral(s+n) - integral(s)`, selling n removes `integral(s) - integral(s-n)`.
/// Fees are charged on top and never enter the reserve, so a sell can always be paid in full and a buy then an
/// immediate sell returns exactly the cost, less the fees.
pub fn integral(base: u128, slope: u128, supply: u128) -> u128 {
    supply * base + slope * (supply * (supply + 1) / 2)
}

pub fn buy_cost(base: u128, slope: u128, supply: u64, n: u64) -> u128 {
    integral(base, slope, (supply + n) as u128) - integral(base, slope, supply as u128)
}

pub fn sell_value(base: u128, slope: u128, supply: u64, n: u64) -> u128 {
    integral(base, slope, supply as u128) - integral(base, slope, (supply - n) as u128)
}

/// Fixed-point scale of the per-share dividend accumulator. Chosen so `amount * PRECISION` cannot overflow u128 for any
/// amount below 3e29 yocto (300 million NEAR).
pub const DIV_PRECISION: u128 = 1_000_000_000;

/// `amount * numerator / 10_000` without losing the remainder: the second value is `amount - first`.
pub fn bps(amount: u128, numerator: u16) -> (u128, u128) {
    let part = amount * numerator as u128 / 10_000;
    (part, amount - part)
}

/// Win probability for the higher-rated player in per-mille, indexed by rating gap in steps of 50 (0..=800).
const EXPECTED: [u32; 17] = [500, 571, 640, 703, 759, 808, 849, 882, 909, 930, 946, 959, 969, 976, 982, 986, 990];

/// Expected score of a player rated `own` against one rated `other`, in per-mille.
pub fn expected_permille(own: u32, other: u32) -> u32 {
    let gap = own.abs_diff(other).min(800);
    let (lo, rem) = ((gap / 50) as usize, gap % 50);
    let p = if lo >= 16 { EXPECTED[16] } else { EXPECTED[lo] + (EXPECTED[lo + 1] - EXPECTED[lo]) * rem / 50 };
    if own >= other {
        p
    } else {
        1000 - p
    }
}

pub const RATING_START: u32 = 1_000;
pub const RATING_FLOOR: u32 = 100;
pub const K_BASE: u32 = 32;
pub const K_MIN: u32 = 4;

/// New ratings after `winner` beats `loser`. The swing is zero-sum. `repeats` is how many times this pair has already
/// met in the damping window; each repeat halves the swing down to `K_MIN`, which blunts two accounts trading wins.
pub fn elo_after(winner: u32, loser: u32, repeats: u32) -> (u32, u32) {
    let k = (K_BASE >> repeats.min(5)).max(K_MIN);
    let gain = k * (1000 - expected_permille(winner, loser)) / 1000;
    let loss = gain.min(loser.saturating_sub(RATING_FLOOR));
    (winner + loss, loser - loss)
}

/// Reputation for a finished job: more for bigger bounties, damped by repeated work between the same two owners.
pub fn job_reputation(bounty: u128, one_tenth_near: u128, repeats: u32) -> i64 {
    let bonus = (bounty / one_tenth_near).min(8) as i64;
    (2 + bonus) >> repeats.min(5)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    #[test]
    fn curve_is_exactly_reversible() {
        let (base, slope) = (NEAR / 100, NEAR / 1000);
        for supply in [0u64, 1, 7, 100, 5_000, 999_000] {
            for n in [1u64, 2, 10, 250] {
                let paid = buy_cost(base, slope, supply, n);
                let back = sell_value(base, slope, supply + n, n);
                assert_eq!(paid, back, "supply {supply} n {n}");
            }
        }
    }

    #[test]
    fn reserve_equals_integral_of_supply() {
        let (base, slope) = (NEAR / 100, NEAR / 1000);
        let mut supply = 0u64;
        let mut reserve = 0u128;
        for step in [5u64, 3, 40, 1, 12] {
            reserve += buy_cost(base, slope, supply, step);
            supply += step;
            assert_eq!(reserve, integral(base, slope, supply as u128));
        }
        for step in [10u64, 6, 20, 25] {
            reserve -= sell_value(base, slope, supply, step);
            supply -= step;
            assert_eq!(reserve, integral(base, slope, supply as u128));
        }
    }

    #[test]
    fn first_share_costs_base_plus_slope() {
        assert_eq!(buy_cost(100, 10, 0, 1), 110);
        assert_eq!(buy_cost(100, 10, 1, 1), 120);
        assert_eq!(buy_cost(100, 10, 0, 3), 110 + 120 + 130);
    }

    #[test]
    fn bps_loses_nothing() {
        for amount in [0u128, 1, 7, 9_999, 10_000, 123_456_789_012_345_678] {
            for n in [0u16, 1, 200, 1500, 9_999, 10_000] {
                let (a, b) = bps(amount, n);
                assert_eq!(a + b, amount);
            }
        }
    }

    #[test]
    fn expected_score_is_symmetric_and_monotone() {
        assert_eq!(expected_permille(1000, 1000), 500);
        for gap in (0..900).step_by(13) {
            let hi = expected_permille(1000 + gap, 1000);
            let lo = expected_permille(1000, 1000 + gap);
            assert_eq!(hi + lo, 1000);
            assert!(hi >= 500 && hi <= 990);
        }
        assert!(expected_permille(1200, 1000) > expected_permille(1100, 1000));
    }

    #[test]
    fn elo_is_zero_sum_and_rewards_upsets() {
        let (w, l) = elo_after(1000, 1000, 0);
        assert_eq!((w, l), (1016, 984));
        let (uw, ul) = elo_after(900, 1300, 0);
        assert!(uw - 900 > 28, "an upset moves a lot: {}", uw - 900);
        assert_eq!(uw + ul, 2200);
        let (fw, _) = elo_after(1300, 900, 0);
        assert!(fw - 1300 < 4 || fw - 1300 == 3, "a favourite gains little: {}", fw - 1300);
    }

    #[test]
    fn repeat_pairs_are_damped() {
        let swings: Vec<u32> = (0..7).map(|r| elo_after(1000, 1000, r).0 - 1000).collect();
        assert_eq!(swings, vec![16, 8, 4, 2, 2, 2, 2].into_iter().map(|s| s.max(2)).collect::<Vec<_>>());
        assert!(swings[6] <= swings[0] / 4);
    }

    #[test]
    fn rating_never_falls_through_the_floor() {
        let (_, l) = elo_after(2000, 101, 0);
        assert!(l >= RATING_FLOOR);
    }

    #[test]
    fn job_reputation_grows_with_bounty_and_decays_with_repeats() {
        let tenth = NEAR / 10;
        assert_eq!(job_reputation(tenth, tenth, 0), 3);
        assert_eq!(job_reputation(10 * NEAR, tenth, 0), 10);
        assert_eq!(job_reputation(NEAR, tenth, 0), 12 - 2);
        assert_eq!(job_reputation(NEAR, tenth, 1), 5);
        assert_eq!(job_reputation(NEAR, tenth, 9), 10 >> 5);
    }
}
