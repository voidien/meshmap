#!/usr/bin/env bash
# Build meshmap-wasm and generate JS bindings into web/src/wasm/pkg.
# Needs: rustup target add wasm32-unknown-unknown ; cargo install wasm-bindgen-cli --version 0.2.100
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p meshmap-wasm
wasm-bindgen --target web --out-dir web/src/wasm/pkg \
  target/wasm32-unknown-unknown/release/meshmap_wasm.wasm
ls -la web/src/wasm/pkg
