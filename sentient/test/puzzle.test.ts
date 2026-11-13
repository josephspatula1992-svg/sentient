import { test } from "node:test";
import assert from "node:assert/strict";
import { solve, KINDS } from "../src/lib/puzzle.js";

// The same values contracts/sentient/src/puzzle.rs pins in its own tests.
test("modpow matches the Rust vectors", () => {
  assert.equal(solve(0, [2, 10, 1000, 0]), 24);
  assert.equal(solve(0, [3, 200, 13, 0]), 9);
});

test("collatz matches the Rust vectors", () => {
  assert.equal(solve(1, [27, 0, 0, 0]), 111);
  assert.equal(solve(1, [6, 0, 0, 0]), 8);
  assert.equal(solve(1, [97, 0, 0, 0]), 118);
});

test("prime counts match pi(n)", () => {
  assert.equal(solve(2, [100, 0, 0, 0]), 25);
  assert.equal(solve(2, [1000, 0, 0, 0]), 168);
  assert.equal(solve(2, [5000, 0, 0, 0]), 669);
});

test("fibonacci mod m matches plain iteration, and handles a huge index", () => {
  for (const n of [1, 2, 10, 50, 91, 300, 1000]) {
    for (const m of [2, 10, 1000, 99_991]) {
      let a = 0n;
      let b = 1n % BigInt(m);
      for (let i = 0; i < n; i++) [a, b] = [b, (a + b) % BigInt(m)];
      assert.equal(solve(3, [n, m, 0, 0]), Number(a), `F(${n}) mod ${m}`);
    }
  }
  assert.notEqual(solve(3, [1_000_000_000_000, 1_000_000, 0, 0]), null);
});

test("digit sum matches the Rust vector", () => {
  assert.equal(solve(4, [123_456, 654_321, 0, 0]), 63);
});

test("out-of-range parameters are refused, as the contract refuses them", () => {
  assert.equal(solve(2, [10_000_000, 0, 0, 0]), null);
  assert.equal(solve(1, [0, 0, 0, 0]), null);
  assert.equal(solve(0, [2, 5, 1, 0]), null);
  assert.equal(solve(99, [1, 1, 1, 1]), null);
  assert.equal(KINDS, 5);
});
