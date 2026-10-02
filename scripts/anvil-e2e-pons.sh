#!/usr/bin/env bash
# Pons-mode end-to-end smoke test on anvil: deploy Pons mocks + PonsMindRegistry -> launchMind (with a
# dev buy) -> extra buy on the mock curve -> fundMind -> runner (VENUE=pons, DRY_RUN) -> assert the API.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.foundry/bin:/root/.foundry/bin:$PATH"
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
PORT="${ANVIL_PORT:-8546}"
RPC="http://127.0.0.1:${PORT}"
API_PORT="${E2E_API_PORT:-8791}"
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

echo "== deploy Pons mocks + registry"
pushd "$ROOT/contracts" >/dev/null
OWNER="$ADDR" TREASURY="$ADDR" COMPUTE_TREASURY="$ADDR" OPERATOR="$ADDR" DEPLOYER_PRIVATE_KEY="$PK" \
  forge script script/DeployPonsLocal.s.sol --rpc-url "$RPC" --broadcast --private-key "$PK" -q
popd >/dev/null
DEPLOY_JSON="$ROOT/contracts/deployments/31337.json"
read -r REGISTRY FACTORY ESCROW < <(node -e "const d=JSON.parse(require('fs').readFileSync('$DEPLOY_JSON','utf8'));console.log(d.registry,d.pons.factory,d.pons.feeEscrow)")
echo "registry: $REGISTRY factory: $FACTORY escrow: $ESCROW"

echo "== launchMind with a 0.05 ETH dev buy"
LAUNCH_FEE=$(cast call "$FACTORY" "launchFee()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
MODEL_ID=$(cast keccak "claude-opus-5-5")
PERSONA_HASH=$(cast keccak "I am a curious mind that reads the web.")
SALT=$(cast keccak "e2e-pons-$$")
QUOTE_IN=50000000000000000
VALUE=$((LAUNCH_FEE + QUOTE_IN))
URI="data:application/json;base64,eyJuYW1lIjoiRTJFIFBvbnMgTWluZCJ9"
TX=$(cast send "$REGISTRY" \
  "launchMind((string,string,string,string,(string,string,string,string,string),uint16,bytes32,bytes32,uint256),uint256,uint256,bytes32,bytes32,string)" \
  "(\"E2E Pons Mind\",\"EPM\",\"\",\"an e2e coin\",(\"\",\"\",\"\",\"\",\"\"),100,0x0000000000000000000000000000000000000000000000000000000000000000,$SALT,0)" \
  "$QUOTE_IN" 0 "$MODEL_ID" "$PERSONA_HASH" "$URI" \
  --value "$VALUE" --private-key "$PK" --rpc-url "$RPC" --json)
echo "$TX" | python3 -c "import sys,json;r=json.load(sys.stdin);print('launchMind status',r['status'],'gas',int(r['gasUsed'],16))"
TOKEN=$(cast call "$REGISTRY" "mindAt(uint256)(address)" 0 --rpc-url "$RPC")
CURVE=$(cast call "$REGISTRY" "ponsMind(address)((address,address,uint256,bool,bool))" "$TOKEN" --rpc-url "$RPC" | sed -E 's/^\((0x[0-9a-fA-F]+),.*/\1/')
echo "token: $TOKEN curve: $CURVE"

echo "== buy on the Pons curve, fund the mind"
cast send "$CURVE" "buy(uint256,uint256,address)" 100000000000000000 0 "$ADDR" --value 0.1ether --private-key "$PK" --rpc-url "$RPC" >/dev/null
cast send "$REGISTRY" "fundMind(address)" "$TOKEN" --value 0.01ether --private-key "$PK" --rpc-url "$RPC" >/dev/null
echo "claimable: $(cast call "$REGISTRY" 'claimable(address)(uint256)' "$TOKEN" --rpc-url "$RPC")"

echo "== runner (VENUE=pons, DRY_RUN, no model key)"
mkdir -p "$ROOT/runner/data"
DB="$ROOT/runner/data/e2e-pons-$$.sqlite"
rm -f "$DB"
( cd "$ROOT/runner" && \
  VENUE=pons CHAIN_ID=31337 RPC_URL="$RPC" REGISTRY_ADDRESS="$REGISTRY" START_BLOCK=0 DRY_RUN=true \
  OPERATOR_PRIVATE_KEY="$PK" ANTHROPIC_API_KEY= ETH_USD_PRICE=3000 DB_PATH="$DB" PORT="$API_PORT" \
  BROWSER_HEADLESS=true MAX_CONCURRENT_MINDS=1 TICK_INTERVAL_MS=600000 \
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
DETAIL=$(curl -sf "http://127.0.0.1:${API_PORT}/api/minds/${TOKEN}")
echo "$DETAIL" | head -c 700; echo
echo "$DETAIL" | grep -q '"venue":"pons"' || { echo "FAIL: venue is not pons"; exit 1; }
curl -sf "http://127.0.0.1:${API_PORT}/api/minds/${TOKEN}/trades" | head -c 300; echo
curl -sf "http://127.0.0.1:${API_PORT}/api/launch-config" | head -c 300; echo
echo "== e2e (pons) OK"
