/**
 * The duel puzzles, solved off chain. This must agree with `contracts/sentient/src/puzzle.rs` to the last digit: the
 * contract recomputes the answer itself, so a solver that disagrees loses duels it should win. The end-to-end run plays a
 * real duel of every kind against the deployed contract, which is the test that matters; `test/puzzle.test.ts` pins the
 * same known values the Rust tests pin.
 */

export const KIND_NAMES = ["modpow", "collatz", "primes", "fibmod", "digits"] as const;
export const KINDS = KIND_NAMES.length;

export type Params = [number, number, number, number];

function modpow(base: bigint, exp: bigint, m: bigint): bigint {
  let acc = 1n % m;
  base %= m;
  while (exp > 0n) {
    if (exp & 1n) acc = (acc * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return acc;
}

function fibPair(n: bigint, m: bigint): [bigint, bigint] {
  if (n === 0n) return [0n, 1n % m];
  const [a, b] = fibPair(n / 2n, m);
  const c = (a * ((2n * b + m - a) % m)) % m;
  const d = (a * a + b * b) % m;
  return n % 2n === 0n ? [c, d] : [d, (c + d) % m];
}

/** The right answer, or null when the parameters are outside what the contract can produce. */
export function solve(kind: number, p: readonly number[]): number | null {
  switch (kind) {
    case 0: {
      const [b, e, m] = p;
      if (b === 0 || m < 2 || m > 1_000_000 || e > 10_000_000) return null;
      return Number(modpow(BigInt(b), BigInt(e), BigInt(m)));
    }
    case 1: {
      let n = p[0];
      if (n === 0 || n > 100_000) return null;
      let steps = 0;
      while (n !== 1) {
        n = n % 2 === 0 ? n / 2 : 3 * n + 1;
        if (++steps > 100_000) return null;
      }
      return steps;
    }
    case 2: {
      const n = p[0];
      if (n < 2 || n > 20_000) return null;
      const composite = new Uint8Array(n + 1);
      let count = 0;
      for (let i = 2; i <= n; i++) {
        if (composite[i]) continue;
        count++;
        for (let j = i * i; j <= n; j += i) composite[j] = 1;
      }
      return count;
    }
    case 3: {
      const [n, m] = p;
      if (m < 2 || m > 1_000_000) return null;
      return Number(fibPair(BigInt(n), BigInt(m))[0]);
    }
    case 4: {
      const [a, b] = p;
      if (a > 10_000_000 || b > 10_000_000) return null;
      let x = BigInt(a) * BigInt(b);
      let s = 0n;
      while (x > 0n) {
        s += x % 10n;
        x /= 10n;
      }
      return Number(s);
    }
    default:
      return null;
  }
}
