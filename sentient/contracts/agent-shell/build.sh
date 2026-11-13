#!/usr/bin/env bash
# Builds contracts/agent-shell/res/agent_shell.wasm in a form NEAR's VM accepts (same recipe as the registry's build.sh).
# The registry embeds this file, so build it first; contracts/sentient/build.sh does.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p res
RUSTFLAGS="-C target-cpu=mvp" cargo build --target wasm32-unknown-unknown --release
RAW=target/wasm32-unknown-unknown/release/agent_shell.wasm
command -v wasm-tools >/dev/null 2>&1 || { echo "Need wasm-tools to normalise the WASM." >&2; exit 1; }
TMP="$(mktemp -d)"
wasm-tools strip -a "$RAW" -o "$TMP/stripped.wasm"
wasm-tools print "$TMP/stripped.wasm" -o "$TMP/m.wat"
wasm-tools parse "$TMP/m.wat" -o res/agent_shell.wasm
rm -rf "$TMP"
wasm-tools validate --features mvp,sign-extension res/agent_shell.wasm
echo "validated: baseline WASM + sign-extension only"
ls -la res/agent_shell.wasm
