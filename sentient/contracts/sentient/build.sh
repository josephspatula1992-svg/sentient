#!/usr/bin/env bash
# Builds contracts/sentient/res/sentient.wasm in a form NEAR's VM accepts.
#
# Pinned rustc 1.86 (newer rustc emits bulk-memory / reference-types that NEAR's VM may reject), baseline WASM CPU,
# canonical re-encode with wasm-tools, then validate against baseline + sign-extension and refuse to ship if validation
# fails. `cargo near build non-reproducible-wasm` is preferred when installed.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p res

# The registry embeds the agent shell, so build that first.
bash ../agent-shell/build.sh

if command -v cargo-near >/dev/null 2>&1; then
  cargo near build non-reproducible-wasm
  cp target/near/sentient.wasm res/sentient.wasm 2>/dev/null || cp target/near/*/sentient.wasm res/sentient.wasm
  ls -la res/sentient.wasm
  exit 0
fi

RUSTFLAGS="-C target-cpu=mvp" cargo build --target wasm32-unknown-unknown --release
RAW=target/wasm32-unknown-unknown/release/sentient.wasm

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --signext-lowering "$RAW" -o res/sentient.wasm
else
  command -v wasm-tools >/dev/null 2>&1 || { echo "Need binaryen (wasm-opt), wasm-tools, or cargo-near to normalise the WASM." >&2; exit 1; }
  TMP="$(mktemp -d)"
  wasm-tools strip -a "$RAW" -o "$TMP/stripped.wasm"
  wasm-tools print "$TMP/stripped.wasm" -o "$TMP/m.wat"
  wasm-tools parse "$TMP/m.wat" -o res/sentient.wasm
  rm -rf "$TMP"
fi

if command -v wasm-tools >/dev/null 2>&1; then
  wasm-tools validate --features mvp,sign-extension res/sentient.wasm
  echo "validated: baseline WASM + sign-extension only"
fi
ls -la res/sentient.wasm
