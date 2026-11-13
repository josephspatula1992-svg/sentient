//! Duel puzzles.
//!
//! Every puzzle is a pure function of a few public numbers, so any agent can solve one off chain and the contract can
//! check the answer itself: no oracle, no judge, no off-chain referee. The parameters come from the chain's random seed
//! at the moment a duel is accepted, so neither side can have prepared the question.
//!
//! The contract never stores the answer. It recomputes it when an answer arrives.

pub const KINDS: u8 = 5;

pub const MODPOW: u8 = 0;
pub const COLLATZ: u8 = 1;
pub const PRIMES: u8 = 2;
pub const FIBMOD: u8 = 3;
pub const DIGITS: u8 = 4;

pub fn kind_name(kind: u8) -> &'static str {
    match kind {
        MODPOW => "modpow",
        COLLATZ => "collatz",
        PRIMES => "primes",
        FIBMOD => "fibmod",
        DIGITS => "digits",
        _ => "unknown",
    }
}

fn word(seed: &[u8; 32], i: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&seed[i * 8..i * 8 + 8]);
    u64::from_le_bytes(b)
}

/// Parameters for a puzzle of `kind`, derived from 32 bytes of seed. Ranges keep every `solve` cheap and bounded.
pub fn generate(kind: u8, seed: &[u8; 32]) -> [u64; 4] {
    let (w0, w1, w2) = (word(seed, 0), word(seed, 1), word(seed, 2));
    match kind {
        MODPOW => [2 + w0 % 998, 1_000 + w1 % 999_000, 1_009 + w2 % 98_991, 0],
        COLLATZ => [27 + w0 % 9_973, 0, 0, 0],
        PRIMES => [500 + w0 % 4_501, 0, 0, 0],
        FIBMOD => [1_000_000 + w0 % 1_000_000_000_000, 1_000 + w1 % 999_000, 0, 0],
        DIGITS => [100_000 + w0 % 900_000, 100_000 + w1 % 900_000, 0, 0],
        _ => [0; 4],
    }
}

/// The right answer, or `None` when the parameters are outside what `generate` can produce (so a corrupted record can
/// never make the contract loop for long).
pub fn solve(kind: u8, p: &[u64; 4]) -> Option<u64> {
    match kind {
        MODPOW => {
            let (b, e, m) = (p[0], p[1], p[2]);
            if b == 0 || m < 2 || m > 1_000_000 || e > 10_000_000 {
                return None;
            }
            Some(modpow(b as u128, e, m as u128) as u64)
        }
        COLLATZ => {
            let mut n = p[0];
            if n == 0 || n > 100_000 {
                return None;
            }
            let mut steps = 0u64;
            while n != 1 {
                n = if n % 2 == 0 { n / 2 } else { 3 * n + 1 };
                steps += 1;
                if steps > 100_000 {
                    return None;
                }
            }
            Some(steps)
        }
        PRIMES => {
            let n = p[0] as usize;
            if !(2..=20_000).contains(&n) {
                return None;
            }
            let mut composite = vec![false; n + 1];
            let mut count = 0u64;
            for i in 2..=n {
                if !composite[i] {
                    count += 1;
                    let mut j = i * i;
                    while j <= n {
                        composite[j] = true;
                        j += i;
                    }
                }
            }
            Some(count)
        }
        FIBMOD => {
            let (n, m) = (p[0], p[1]);
            if m < 2 || m > 1_000_000 {
                return None;
            }
            Some(fib_pair(n, m as u128).0 as u64)
        }
        DIGITS => {
            let (a, b) = (p[0], p[1]);
            if a > 10_000_000 || b > 10_000_000 {
                return None;
            }
            let mut x = a * b;
            let mut s = 0u64;
            while x > 0 {
                s += x % 10;
                x /= 10;
            }
            Some(s)
        }
        _ => None,
    }
}

/// The question in words, so a person or a language model can read it straight off the chain.
pub fn question(kind: u8, p: &[u64; 4]) -> String {
    match kind {
        MODPOW => format!("Compute {}^{} mod {}.", p[0], p[1], p[2]),
        COLLATZ => format!(
            "Start at {}. If the number is even halve it, otherwise triple it and add one. How many steps until it reaches 1?",
            p[0]
        ),
        PRIMES => format!("How many prime numbers are there from 2 up to and including {}?", p[0]),
        FIBMOD => format!("With F(0)=0 and F(1)=1, compute F({}) mod {}.", p[0], p[1]),
        DIGITS => format!("What is the sum of the decimal digits of {} x {}?", p[0], p[1]),
        _ => String::new(),
    }
}

fn modpow(mut base: u128, mut exp: u64, m: u128) -> u128 {
    let mut acc = 1 % m;
    base %= m;
    while exp > 0 {
        if exp & 1 == 1 {
            acc = acc * base % m;
        }
        base = base * base % m;
        exp >>= 1;
    }
    acc
}

/// (F(n), F(n+1)) mod m by fast doubling.
fn fib_pair(n: u64, m: u128) -> (u128, u128) {
    if n == 0 {
        return (0, 1 % m);
    }
    let (a, b) = fib_pair(n / 2, m);
    let c = a * ((2 * b + m - a) % m) % m;
    let d = (a * a + b * b) % m;
    if n % 2 == 0 {
        (c, d)
    } else {
        (d, (c + d) % m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modpow_known_values() {
        assert_eq!(solve(MODPOW, &[2, 10, 1000, 0]), Some(24)); // 1024 mod 1000
        assert_eq!(solve(MODPOW, &[3, 200, 13, 0]), Some(9)); // 3^3=1 mod 13, 200 = 3*66+2 => 9
        assert_eq!(solve(MODPOW, &[7, 1_000_000, 1009, 0]), Some(modpow(7, 1_000_000, 1009) as u64));
    }

    #[test]
    fn collatz_known_values() {
        assert_eq!(solve(COLLATZ, &[27, 0, 0, 0]), Some(111));
        assert_eq!(solve(COLLATZ, &[6, 0, 0, 0]), Some(8));
        assert_eq!(solve(COLLATZ, &[97, 0, 0, 0]), Some(118));
    }

    #[test]
    fn prime_counts_match_pi() {
        assert_eq!(solve(PRIMES, &[100, 0, 0, 0]), Some(25));
        assert_eq!(solve(PRIMES, &[1_000, 0, 0, 0]), Some(168));
        assert_eq!(solve(PRIMES, &[5_000, 0, 0, 0]), Some(669));
    }

    #[test]
    fn fibonacci_mod_matches_iteration() {
        for n in [1u64, 2, 10, 50, 91, 300, 1_000] {
            for m in [2u64, 10, 1_000, 99_991] {
                let (mut a, mut b) = (0u128, 1u128 % m as u128);
                for _ in 0..n {
                    let t = (a + b) % m as u128;
                    a = b;
                    b = t;
                }
                assert_eq!(solve(FIBMOD, &[n, m, 0, 0]), Some(a as u64), "F({n}) mod {m}");
            }
        }
        // F(10^12) mod 1_000_000 is well defined and cheap
        assert!(solve(FIBMOD, &[1_000_000_000_000, 1_000_000, 0, 0]).is_some());
    }

    #[test]
    fn digit_sum_known_value() {
        // 123456 * 654321 = 80_779_853_376 -> 8+0+7+7+9+8+5+3+3+7+6 = 63
        assert_eq!(solve(DIGITS, &[123_456, 654_321, 0, 0]), Some(63));
    }

    #[test]
    fn generated_puzzles_are_always_solvable_and_in_range() {
        for k in 0..KINDS {
            for i in 0..200u32 {
                let mut seed = [0u8; 32];
                for (j, byte) in seed.iter_mut().enumerate() {
                    *byte = (i.wrapping_mul(2_654_435_761).wrapping_add(j as u32 * 97) >> (j % 24)) as u8;
                }
                let p = generate(k, &seed);
                assert!(solve(k, &p).is_some(), "kind {k} params {p:?}");
                assert!(!question(k, &p).is_empty());
            }
        }
    }

    #[test]
    fn out_of_range_parameters_are_refused() {
        assert_eq!(solve(PRIMES, &[10_000_000, 0, 0, 0]), None);
        assert_eq!(solve(COLLATZ, &[0, 0, 0, 0]), None);
        assert_eq!(solve(MODPOW, &[2, 5, 1, 0]), None);
        assert_eq!(solve(99, &[1, 1, 1, 1]), None);
    }
}
