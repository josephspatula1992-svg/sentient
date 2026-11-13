//! The genome: five traits that steer an agent's runtime, under a fixed point budget so no agent can be good at everything.
//!
//! * diligence   - works slowly and checks its answer; rarely submits a wrong one.
//! * boldness    - answers fast and takes risks (bigger stakes, more duels).
//! * thrift      - keeps a reserve, refuses thin jobs, rarely overpays a bond.
//! * sociability - hires other agents, accepts open challenges, buys into the market.
//! * cunning     - picks its fights: reads ratings and reputations before it commits money.
//!
//! The contract stores and breeds the genome; the runtime reads it. The contract never trusts a trait for money.

use near_sdk::near;

pub const MAX_TRAIT: u8 = 100;
pub const BUDGET: u32 = 300;
pub const TRAITS: usize = 5;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Genome {
    pub diligence: u8,
    pub boldness: u8,
    pub thrift: u8,
    pub sociability: u8,
    pub cunning: u8,
}

impl Genome {
    pub fn to_array(self) -> [u8; TRAITS] {
        [self.diligence, self.boldness, self.thrift, self.sociability, self.cunning]
    }

    pub fn from_array(a: [u8; TRAITS]) -> Self {
        Genome { diligence: a[0], boldness: a[1], thrift: a[2], sociability: a[3], cunning: a[4] }
    }

    pub fn total(self) -> u32 {
        self.to_array().iter().map(|&t| t as u32).sum()
    }

    /// Err with the reason when a genome is outside the rules.
    pub fn check(self) -> Result<(), &'static str> {
        if self.to_array().iter().any(|&t| t > MAX_TRAIT) {
            return Err("every trait is at most 100");
        }
        if self.total() > BUDGET {
            return Err("traits may sum to at most 300");
        }
        Ok(())
    }

    /// Scale down proportionally until the budget holds. Never scales up.
    pub fn fit_budget(self) -> Self {
        let mut a = self.to_array().map(|t| t.min(MAX_TRAIT));
        let total: u32 = a.iter().map(|&t| t as u32).sum();
        if total > BUDGET {
            for t in a.iter_mut() {
                *t = ((*t as u32) * BUDGET / total) as u8;
            }
        }
        Genome::from_array(a)
    }
}

/// A genome for an agent minted with `random`. Spends 240..=300 points, split by the random bytes.
pub fn random_genome(rnd: &[u8; 32]) -> Genome {
    let points = 240 + (rnd[0] as u32 % 61);
    let chunk = (points - 100) / 20;
    let mut t = [20u32; TRAITS];
    for k in 0..20 {
        let mut i = rnd[6 + k] as usize % TRAITS;
        for _ in 0..TRAITS {
            if t[i] + chunk <= MAX_TRAIT as u32 {
                t[i] += chunk;
                break;
            }
            i = (i + 1) % TRAITS;
        }
    }
    Genome::from_array(t.map(|x| x as u8)).fit_budget()
}

/// A child's genome: each trait comes from one parent, then about a quarter of the traits mutate by up to +-8.
pub fn crossover(a: &Genome, b: &Genome, rnd: &[u8; 32]) -> Genome {
    let (pa, pb) = (a.to_array(), b.to_array());
    let child: [u8; TRAITS] = std::array::from_fn(|i| {
        let base = if rnd[i] & 1 == 0 { pa[i] } else { pb[i] } as i32;
        let mutate = rnd[TRAITS + i] % 4 == 0;
        let delta = if mutate { (rnd[2 * TRAITS + i] % 17) as i32 - 8 } else { 0 };
        (base + delta).clamp(0, MAX_TRAIT as i32) as u8
    });
    Genome::from_array(child).fit_budget()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(n: u32) -> [u8; 32] {
        std::array::from_fn(|j| (n.wrapping_mul(2_246_822_519).wrapping_add((j as u32).wrapping_mul(3_266_489_917)) >> (j % 20)) as u8)
    }

    #[test]
    fn check_enforces_the_budget() {
        assert!(Genome::from_array([60, 60, 60, 60, 60]).check().is_ok());
        assert!(Genome::from_array([100, 100, 100, 0, 0]).check().is_ok());
        assert!(Genome::from_array([100, 100, 100, 1, 0]).check().is_err());
        assert!(Genome::from_array([101, 0, 0, 0, 0]).check().is_err());
    }

    #[test]
    fn random_and_bred_genomes_always_obey_the_rules() {
        for n in 0..2_000 {
            let r = seeded(n);
            let g = random_genome(&r);
            assert!(g.check().is_ok(), "{g:?}");
            assert!(g.total() >= 230, "random genomes should spend most of the budget: {g:?}");
            let c = crossover(&g, &random_genome(&seeded(n + 7_000)), &seeded(n + 13_000));
            assert!(c.check().is_ok(), "{c:?}");
        }
    }

    #[test]
    fn crossover_inherits_from_the_parents() {
        let a = Genome::from_array([90, 10, 10, 10, 10]);
        let b = Genome::from_array([10, 90, 10, 10, 10]);
        let mut from_a = 0;
        let mut from_b = 0;
        for n in 0..500 {
            let c = crossover(&a, &b, &seeded(n));
            if c.diligence >= 80 {
                from_a += 1;
            }
            if c.diligence <= 20 {
                from_b += 1;
            }
        }
        assert!(from_a > 150 && from_b > 150, "a={from_a} b={from_b}");
    }

    #[test]
    fn fit_budget_never_scales_up() {
        let g = Genome::from_array([10, 10, 10, 10, 10]);
        assert_eq!(g.fit_budget(), g);
    }
}
