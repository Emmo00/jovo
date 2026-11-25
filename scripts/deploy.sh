#!/usr/bin/env bash
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"

if [[ "$NETWORK" != "testnet" ]]; then
  echo "This script only supports Stellar testnet." >&2
  exit 1
fi

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$ROOT/contracts/escrow"

cd "$WORKSPACE"
stellar contract build

WASM="$(find target -type f -path '*/wasm32*/release/jovo_escrow.wasm' -print -quit)"
if [[ -z "$WASM" ]]; then
  echo "Could not find the built jovo_escrow.wasm artifact." >&2
  exit 1
fi

ID="$(stellar contract deploy --wasm "$WASM" --source-account "$SOURCE" --network "$NETWORK")"
printf 'ESCROW_CONTRACT_ID=%s\n' "$ID"
