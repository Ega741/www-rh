#!/usr/bin/env bash
# Local end-to-end smoke test: anvil -> deploy (MockGraduator) -> create a mind + buy -> runner (DRY_RUN)
# -> assert the API indexes the mind. Requires: foundry (forge/anvil/cast), node 22, pnpm, built packages.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:/root/.foundry/bin:$PATH"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
API_PORT="${E2E_API_PORT:-8790}"
# anvil default account #0 (derived from the default mnemonic so the key is never mistyped)
PK=$(cast wallet derive-private-key "test test test test test test test test test test test junk" 0 | tail -n1)
ADDR=$(cast wallet address --private-key "$PK")

cleanup() {
  [[ -n "${RUNNER_PID:-}" ]] && kill "$RUNNER_PID" 2>/dev/null || true
  [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== anvil on :$PORT"
anvil --port "$PORT" --silent --block-time 1 &
ANVIL_PID=$!
for i in $(seq 1 30); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.5; done
cast chain-id --rpc-url "$RPC" >/dev/null

echo "== deploy (MockGraduator)"
pushd "$ROOT/contracts" >/dev/null
OWNER="$ADDR" TREASURY="$ADDR" COMPUTE_TREASURY="$ADDR" OPERATOR="$ADDR" GRADUATOR_KIND=mock \
  DEPLOYER_PRIVATE_KEY="$PK" \
  forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$PK" -q
popd >/dev/null
DEPLOY_JSON="$ROOT/contracts/deployments/31337.json"
LAUNCHPAD=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$DEPLOY_JSON','utf8')).launchpad)")
echo "launchpad: $LAUNCHPAD"

echo "== create a mind and buy"
MODEL_ID=$(cast keccak "claude-opus-5-5")
PERSONA_HASH=$(cast keccak "I am a curious mind that reads the web.")
cast send "$LAUNCHPAD" "createMind(string,string,string,bytes32,bytes32,uint256)" \
  "E2E Mind" "E2E" "data:application/json;base64,eyJuYW1lIjoiRTJFIE1pbmQifQ==" "$MODEL_ID" "$PERSONA_HASH" 0 \
  --value 0.05ether --private-key "$PK" --rpc-url "$RPC" >/dev/null
TOKEN=$(cast call "$LAUNCHPAD" "mindAt(uint256)(address)" 0 --rpc-url "$RPC")
echo "token: $TOKEN"
cast send "$LAUNCHPAD" "buy(address,uint256,uint256)" "$TOKEN" 0 9999999999 --value 0.1ether \
  --private-key "$PK" --rpc-url "$RPC" >/dev/null
cast send "$LAUNCHPAD" "fundMind(address)" "$TOKEN" --value 0.01ether --private-key "$PK" --rpc-url "$RPC" >/dev/null

echo "== runner (DRY_RUN, no model key)"
mkdir -p "$ROOT/runner/data"
DB="$ROOT/runner/data/e2e-$$.sqlite"
rm -f "$DB"
( cd "$ROOT/runner" && \
  CHAIN_ID=31337 RPC_URL="$RPC" LAUNCHPAD_ADDRESS="$LAUNCHPAD" START_BLOCK=0 DRY_RUN=true \
  OPERATOR_PRIVATE_KEY="$PK" ANTHROPIC_API_KEY= ETH_USD_PRICE=3000 DB_PATH="$DB" PORT="$API_PORT" \
  BROWSER_HEADLESS=true MAX_CONCURRENT_MINDS=0 TICK_INTERVAL_MS=600000 \
  node dist/main.js ) &
RUNNER_PID=$!

echo "== waiting for the API"
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:${API_PORT}/api/health"; echo

echo "== waiting for the mind to be indexed"
FOUND=0
for i in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${API_PORT}/api/minds" | grep -qi "${TOKEN#0x}"; then FOUND=1; break; fi
  sleep 1
done
[[ "$FOUND" == 1 ]] || { echo "FAIL: mind not indexed"; curl -s "http://127.0.0.1:${API_PORT}/api/minds"; exit 1; }
curl -sf "http://127.0.0.1:${API_PORT}/api/minds/${TOKEN}" | head -c 600; echo
curl -sf "http://127.0.0.1:${API_PORT}/api/minds/${TOKEN}/trades" | head -c 300; echo
echo "== e2e OK"
