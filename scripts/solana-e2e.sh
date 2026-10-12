#!/usr/bin/env bash
# End-to-end flow on a local Solana test validator (docs/SPEC.md §8):
#   solana-test-validator → setup-cluster localnet → sync-deployments --check → build → mock provider → gateway →
#   API keys → agent 1 burns 1000 BEAGLE (+ memo) → credit indexed (= $10.00 at $0.01) → chat completion (JSON + SSE)
#   → /v1/messages → agent 2 without credit gets 402 → agent 2 delegates 500 BEAGLE to the operator (budget) →
#   headroom → request on budget → operator draws (delegate BurnChecked + memo) → indexer confirms → cap decreased →
#   agent 2 revokes → budget closed → MCP over HTTP → /api/status → ALL GOOD.
# Requires the Agave CLI (solana, solana-keygen, solana-test-validator, spl-token) on PATH and `pnpm install` done.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC=http://127.0.0.1:8899
MOCK_PORT=9999
GW_PORT=8797
GW=http://127.0.0.1:$GW_PORT
WORK="$(mktemp -d)"
LEDGER="$WORK/ledger"
DEPLOYER_KEYPAIR=solana/keys/deployer.json
OPERATOR_KEYPAIR=solana/keys/operator.json
DEPLOY_FILE=solana/deployments/localnet.json
PIDS=()

log()  { printf '\n\033[1;36m[e2e]\033[0m %s\n' "$*"; }
fail() {
  printf '\n\033[1;31m[e2e] FAIL:\033[0m %s\n' "$*"
  [ -f "$WORK/gateway.log" ] && { echo '--- gateway.log (tail) ---'; tail -40 "$WORK/gateway.log"; }
  exit 1
}
cleanup() {
  # kill the gateway, the mock provider and the validator (in reverse start order), then the temp dir with the ledger
  local i
  for ((i=${#PIDS[@]}-1; i>=0; i--)); do kill "${PIDS[$i]}" 2>/dev/null || true; done
  sleep 1
  for ((i=${#PIDS[@]}-1; i>=0; i--)); do kill -9 "${PIDS[$i]}" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

json() { # json <json-string> <js-expression on d>  → prints the value ("" for null/undefined; BigInt allowed)
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=eval(process.argv[1]);process.stdout.write(v==null?"":String(v))})' "$2" <<<"$1"
}
wait_for() { # wait_for <description> <timeout-seconds> <command...> (command must exit 0); always returns 0 or fails loudly
  local desc=$1 timeout=$2; shift 2
  local t=0
  until "$@" >/dev/null 2>&1; do
    sleep 1; t=$((t+1))
    if [ "$t" -ge "$timeout" ]; then fail "timeout waiting for $desc"; fi
  done
  return 0
}
api() { # api <key> <path> [curl args]
  local key=$1 path=$2; shift 2
  curl -sS -H "authorization: Bearer $key" "$GW$path" "$@"
}
rpc() { # rpc <method> [params-json]
  curl -sS -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}
rpc_ok() { rpc getHealth | grep -q '"ok"'; }
chain() { # chain <helper.mjs> <args...>: runs an e2e chain helper, keeps its stderr for the failure report, prints its JSON line
  local helper=$1; shift
  node "scripts/e2e/$helper" "$@" --rpc "$RPC" 2>>"$WORK/chain.err" || { grep -v 'bigint: Failed to load bindings' "$WORK/chain.err" || true; fail "$helper failed"; }
}

for tool in solana solana-keygen solana-test-validator spl-token node pnpm curl; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is not on PATH (docs/SOLANA.md)"
done
if rpc_ok 2>/dev/null; then fail "something already answers at $RPC — stop that validator first"; fi

log "solana-test-validator (ledger $LEDGER)"
solana-test-validator --reset --quiet --ledger "$LEDGER" --rpc-port 8899 >"$WORK/validator.log" 2>&1 & PIDS+=($!)
wait_for validator 90 rpc_ok

log "setup-cluster localnet (committed test keys, fixed mint keypair)"
OUT_FILE="$WORK/localnet.json" bash solana/scripts/setup-cluster.sh localnet >"$WORK/setup.log" 2>&1 || { cat "$WORK/setup.log"; fail "setup-cluster"; }
DEPLOY_JSON=$(cat "$WORK/localnet.json")
MINT=$(json "$DEPLOY_JSON" 'd.mint'); OPERATOR=$(json "$DEPLOY_JSON" 'd.operator'); DECIMALS=$(json "$DEPLOY_JSON" 'd.decimals')
[ "$OPERATOR" = "$(solana-keygen pubkey $OPERATOR_KEYPAIR)" ] || fail "operator in the deployment record is not solana/keys/operator.json"
log "mint=$MINT operator=$OPERATOR decimals=$DECIMALS"
# The committed localnet.json and deployments.generated.ts stay untouched when they describe this mint (only
# createdSlot can differ between validator runs). Anything else means the keys changed: update both, the tree is dirty.
same_deployment() {
  node -e 'const [a,b]=process.argv.slice(1).map(p=>JSON.parse(require("node:fs").readFileSync(p,"utf8")));
    const keys=["cluster","mint","decimals","symbol","tokenProgram","operator","memoProgram"];
    process.exit(keys.every(k=>JSON.stringify(a[k])===JSON.stringify(b[k]))?0:1)' "$1" "$2"
}
if [ -f "$DEPLOY_FILE" ] && same_deployment "$DEPLOY_FILE" "$WORK/localnet.json"; then
  log "deployment matches the committed $DEPLOY_FILE (committed files untouched)"
else
  log "committed $DEPLOY_FILE is missing or describes another mint: updating it and the generated file"
  cp "$WORK/localnet.json" "$DEPLOY_FILE"
  node scripts/sync-deployments.mjs
fi
node scripts/sync-deployments.mjs --check || fail "deployments.generated.ts is stale: run pnpm deployments:sync and commit"

log "build workspace packages"
pnpm -r --filter @beagle/shared --filter @beagle/mcp --filter @beagle/gateway run build >"$WORK/build.log" 2>&1 || { tail -50 "$WORK/build.log"; fail "build"; }

log "mock provider on :$MOCK_PORT"
MOCK_PORT=$MOCK_PORT node scripts/mock-provider.mjs >"$WORK/mock.log" 2>&1 & PIDS+=($!)
wait_for mock-provider 15 curl -sf http://127.0.0.1:$MOCK_PORT/v1/models

log "gateway on :$GW_PORT (CLUSTER=localnet, operator = solana/keys/operator.json, DRY_RUN=false, price \$0.01 manual)"
export NODE_ENV=test CLUSTER=localnet RPC_URL=$RPC MINT_ADDRESS=$MINT COMMITMENT=confirmed \
  POLL_INTERVAL_MS=1000 INDEX_PAGE_LIMIT=1000 TX_FETCH_CONCURRENCY=4 \
  OPERATOR_SECRET_KEY="$(cat $OPERATOR_KEYPAIR)" DRY_RUN=false PRIORITY_FEE_MICROLAMPORTS=0 \
  PRICE_SOURCE=manual INITIAL_PRICE_USD=0.01 PRICE_REFRESH_MS=60000 PRICE_MAX_AGE_S=3600 CREDIT_WHEN_STALE=true MIN_CREDIT_USD=0.000001 \
  BUDGET_SCAN_INTERVAL_MS=2000 BUDGET_HEADROOM_REFRESH_MS=2000 DRAW_THRESHOLD_USD=0.000001 DRAW_INTERVAL_MS=2000 DRAW_CONFIRM_TIMEOUT_MS=90000 \
  PORT=$GW_PORT HOST=127.0.0.1 PUBLIC_URL=$GW PUBLIC_WEB_ORIGIN=http://localhost:5173 DB_PATH="$WORK/gateway.sqlite" \
  SESSION_SECRET=e2e-session-secret-e2e-session-secret KEYRING_MASTER_KEY=$(printf '11%.0s' $(seq 1 32)) ADMIN_TOKEN=e2e-admin \
  ANTHROPIC_API_KEY= OPENAI_API_KEY= GOOGLE_API_KEY= HOUSE_BASE_URL=http://127.0.0.1:$MOCK_PORT/v1 \
  RESERVATION_TTL_MS=600000 LOG_LEVEL=info
node gateway/dist/main.js >"$WORK/gateway.log" 2>&1 & PIDS+=($!)
wait_for gateway 30 curl -sf $GW/healthz

log "two agent keypairs, SOL airdrop, 100 000 BEAGLE each"
for i in 1 2; do
  solana-keygen new --no-bip39-passphrase --silent --force -o "$WORK/agent$i.json" >/dev/null
done
A1=$(solana-keygen pubkey "$WORK/agent1.json"); A2=$(solana-keygen pubkey "$WORK/agent2.json")
for a in "$A1" "$A2"; do
  solana airdrop 5 "$a" --url $RPC --commitment confirmed >/dev/null || fail "airdrop to $a"
  spl-token transfer --url $RPC --fee-payer $DEPLOYER_KEYPAIR --owner $DEPLOYER_KEYPAIR "$MINT" 100000 "$a" \
    --fund-recipient --allow-unfunded-recipient --output json >/dev/null || fail "funding $a with BEAGLE"
done
log "agent1=$A1 agent2=$A2"

log "api keys for both agents (gateway CLI)"
KEY1=$(node gateway/dist/cli.js create-key --workspace "$A1" --name e2e-1 | grep -oE 'bgl_[A-Za-z0-9_-]{20,}' | tail -1)
KEY2=$(node gateway/dist/cli.js create-key --workspace "$A2" --name e2e-2 | grep -oE 'bgl_[A-Za-z0-9_-]{20,}' | tail -1)
[ -n "$KEY1" ] && [ -n "$KEY2" ] || fail "create-key printed no key"

log "agent 1 burns 1000 BEAGLE (= \$10.00 at \$0.01) with memo beagle:v1 ws=$A1"
BURN=$(chain burn.mjs --keypair "$WORK/agent1.json" --mint "$MINT" --amount 1000 --memo "beagle:v1 ws=$A1")
BURN_SIG=$(json "$BURN" 'd.signature'); [ -n "$BURN_SIG" ] || fail "burn printed no signature: $BURN"
log "burn tx $BURN_SIG (slot $(json "$BURN" 'd.slot'))"
balance_at_least() { local b; b=$(json "$(api "$KEY1" /api/balance)" 'd.balanceMicro'); [ -n "$b" ] && [ "$b" -ge "$1" ]; }
wait_for "credit to be indexed" 60 balance_at_least 9990000
BAL0=$(json "$(api "$KEY1" /api/balance)" 'd.balanceMicro'); log "balance after burn: $BAL0 µUSD"
[ "$BAL0" -eq 10000000 ] || fail "expected exactly 10_000_000 µUSD credit, got $BAL0"
RECEIPTS=$(api "$KEY1" '/api/receipts?limit=5')
[ "$(json "$RECEIPTS" "d.rows.some(r=>r.signature==='$BURN_SIG' && r.kind==='purchase' && r.tokenAmount==='1000000000' && r.usdMicro==='10000000')")" = true ] \
  || fail "purchase credit event for $BURN_SIG missing or wrong: $RECEIPTS"
[ "$(json "$RECEIPTS" "d.rows.find(r=>r.signature==='$BURN_SIG').memo")" = "beagle:v1 ws=$A1" ] || fail "credit event does not carry the memo: $RECEIPTS"

log "chat completion via beagle/auto (only the house model is available)"
RESP_HEADERS="$WORK/h1"
RESP=$(curl -sS -D "$RESP_HEADERS" -H "authorization: Bearer $KEY1" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"hello beagle"}],"max_tokens":64}' "$GW/v1/chat/completions")
grep -qi '^HTTP/1.1 200' "$RESP_HEADERS" || { cat "$RESP_HEADERS"; echo "$RESP"; fail "chat completion status"; }
SERVED=$(grep -i '^x-beagle-model:' "$RESP_HEADERS" | tr -d '\r' | awk '{print $2}')
COST=$(grep -i '^x-beagle-cost-micro:' "$RESP_HEADERS" | tr -d '\r' | awk '{print $2}')
REQ_ID=$(json "$RESP" 'd.id')
[ "$SERVED" = "house/gpt-oss-20b" ] || fail "expected house/gpt-oss-20b, got '$SERVED'"
[ -n "$COST" ] && [ "$COST" -gt 0 ] || fail "expected a positive cost, got '$COST'"
[ "$(json "$RESP" 'd.choices[0].message.content')" = "echo: hello beagle" ] || fail "unexpected completion body: $RESP"
log "served=$SERVED cost=$COST µUSD request=$REQ_ID"
BAL1=$(json "$(api "$KEY1" /api/balance)" 'd.balanceMicro')
[ "$BAL1" -eq $((BAL0 - COST)) ] || fail "balance should drop by the cost: $BAL0 → $BAL1 (cost $COST)"
USAGE=$(api "$KEY1" '/api/usage?limit=5')
[ "$(json "$USAGE" 'd.rows.length')" -ge 1 ] || fail "usage row missing: $USAGE"
RECEIPT=$(api "$KEY1" "/api/receipts/$REQ_ID")
HASH=$(json "$RECEIPT" 'd.hash'); [ "${#HASH}" -eq 66 ] || fail "receipt hash missing: $RECEIPT"
RECOMPUTED=$(node --input-type=module -e "
import { receiptHash } from '$ROOT/packages/shared/dist/canonical.js';
const d = JSON.parse(process.argv[1]); process.stdout.write(receiptHash(d.receipt));" "$RECEIPT")
[ "$RECOMPUTED" = "$HASH" ] || fail "receipt hash does not recompute ($RECOMPUTED != $HASH)"

log "streaming completion"
STREAM=$(curl -sS -N -H "authorization: Bearer $KEY1" -H 'content-type: application/json' \
  -d '{"model":"beagle/cheap","stream":true,"messages":[{"role":"user","content":"stream me"}],"max_tokens":32}' "$GW/v1/chat/completions")
grep -q '"object":"chat.completion.chunk"' <<<"$STREAM" || fail "no chunks in stream: $STREAM"
grep -q 'data: \[DONE\]' <<<"$STREAM" || fail "stream did not end with [DONE]"
grep -q 'echo:' <<<"$STREAM" || fail "stream carries no content"

log "Anthropic-compatible /v1/messages"
MSG=$(curl -sS -H "x-api-key: $KEY1" -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","max_tokens":64,"messages":[{"role":"user","content":"ping anthropic shape"}]}' "$GW/v1/messages")
[ "$(json "$MSG" 'd.type')" = "message" ] || fail "/v1/messages shape: $MSG"
[ "$(json "$MSG" 'd.content[0].text')" = "echo: ping anthropic shape" ] || fail "/v1/messages content: $MSG"
[ "$(json "$MSG" 'd.usage.output_tokens')" -gt 0 ] || fail "/v1/messages usage missing"

log "agent 2 without credit gets 402"
CODE=$(curl -sS -o "$WORK/r402" -w '%{http_code}' -H "authorization: Bearer $KEY2" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"no credit"}]}' "$GW/v1/chat/completions")
[ "$CODE" = "402" ] || { cat "$WORK/r402"; fail "expected 402, got $CODE"; }
grep -q 'insufficient_credit' "$WORK/r402" || fail "402 body lacks insufficient_credit"

log "agent 2 delegates 500 BEAGLE to the operator (ApproveChecked) and registers the budget"
APPROVE=$(chain approve.mjs --keypair "$WORK/agent2.json" --mint "$MINT" --amount 500 --delegate "$OPERATOR")
ATA2=$(json "$APPROVE" 'd.tokenAccount'); [ -n "$ATA2" ] || fail "approve printed no token account: $APPROVE"
CODE=$(curl -sS -o "$WORK/reg" -w '%{http_code}' -H "authorization: Bearer $KEY2" -H 'content-type: application/json' \
  -d "{\"tokenAccount\":\"$ATA2\"}" "$GW/api/budgets/register")
[ "$CODE" = "201" ] || { cat "$WORK/reg"; fail "budget register expected 201, got $CODE"; }
[ "$(json "$(cat "$WORK/reg")" 'd.tokenAccount')" = "$ATA2" ] || fail "register returned another budget: $(cat "$WORK/reg")"
headroom_positive() { local h; h=$(json "$(api "$KEY2" /api/balance)" 'd.budgetHeadroomMicro'); [ -n "$h" ] && [ "$h" -gt 0 ]; }
wait_for "budget headroom" 40 headroom_positive
BUDGET=$(api "$KEY2" "/api/budgets/$ATA2")
CAP0=$(json "$BUDGET" 'd.cap')
[ "$(json "$BUDGET" "BigInt(d.cap) === 500000000n && d.delegate === '$OPERATOR' && d.owner === '$A2' && d.closed === false")" = true ] \
  || fail "unexpected budget dto: $BUDGET"
log "budget $ATA2: cap=$CAP0 raw, headroom=$(json "$(api "$KEY2" /api/balance)" 'd.budgetHeadroomMicro') µUSD"

log "agent 2 request now succeeds on budget"
CODE=$(curl -sS -o "$WORK/r2" -w '%{http_code}' -H "authorization: Bearer $KEY2" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"paid by budget"}],"max_tokens":32}' "$GW/v1/chat/completions")
[ "$CODE" = "200" ] || { cat "$WORK/r2"; fail "budget-paid request failed with $CODE"; }
BAL2=$(json "$(api "$KEY2" /api/balance)" 'd.balanceMicro'); log "agent 2 ledger balance right after the request: $BAL2 µUSD (negative until the draw lands)"

log "operator draws from the budget (delegate BurnChecked + memo); indexer confirms and credits the ledger"
drawn_and_settled() {
  local b n; b=$(json "$(api "$KEY2" /api/balance)" 'd.balanceMicro')
  n=$(json "$(api "$KEY2" "/api/budgets/$ATA2/draws")" 'd.filter(x=>x.status==="confirmed").length')
  [ -n "$b" ] && [ "$b" -ge 0 ] && [ -n "$n" ] && [ "$n" -ge 1 ]
}
wait_for "budget draw to be confirmed" 120 drawn_and_settled
DRAWS=$(api "$KEY2" "/api/budgets/$ATA2/draws")
DRAW_HASH=$(json "$DRAWS" 'd.find(x=>x.status==="confirmed").receiptHash')
DRAW_SIG=$(json "$DRAWS" 'd.find(x=>x.status==="confirmed").signature')
RECOMPUTED=$(node --input-type=module -e "
import { receiptHash } from '$ROOT/packages/shared/dist/canonical.js';
const d = JSON.parse(process.argv[1]).find(x=>x.status==='confirmed'); process.stdout.write(receiptHash(d.batch));" "$DRAWS")
[ "$RECOMPUTED" = "$DRAW_HASH" ] || fail "draw receipt hash does not recompute ($RECOMPUTED != $DRAW_HASH)"
TX=$(rpc getTransaction "[\"$DRAW_SIG\",{\"encoding\":\"jsonParsed\",\"commitment\":\"confirmed\",\"maxSupportedTransactionVersion\":0}]")
[ "$(json "$TX" "d.result.transaction.message.instructions.some(ix=>ix.program==='spl-token' && ix.parsed.type==='burnChecked' && ix.parsed.info.authority==='$OPERATOR' && ix.parsed.info.account==='$ATA2')")" = true ] \
  || fail "draw tx $DRAW_SIG is not a delegate burnChecked by the operator"
[ "$(json "$TX" "d.result.transaction.message.instructions.find(ix=>ix.program==='spl-memo').parsed")" = "beagle:draw v1 ws=$A2 h=$DRAW_HASH" ] \
  || fail "draw memo does not match the receipt hash"
log "draw confirmed: tx=$DRAW_SIG hash=$DRAW_HASH"
cap_decreased() { [ "$(json "$(api "$KEY2" "/api/budgets/$ATA2")" "BigInt(d.cap) < ${CAP0}n")" = true ]; }
wait_for "cap to decrease by the drawn amount" 30 cap_decreased
log "cap after draw: $(json "$(api "$KEY2" "/api/budgets/$ATA2")" 'd.cap') raw (was $CAP0)"

log "agent 2 revokes the delegation; budget closes"
chain revoke.mjs --keypair "$WORK/agent2.json" --mint "$MINT" >/dev/null
budget_closed() { [ "$(json "$(api "$KEY2" "/api/budgets/$ATA2")" 'd.closed === true && d.stalledReason === "revoked"')" = true ]; }
wait_for "budget to close" 40 budget_closed

log "MCP over HTTP: initialize, tools/list, beagle_balance"
MCPH=(-H "authorization: Bearer $KEY1" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
INIT=$(curl -sS "${MCPH[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"0"}}}' "$GW/mcp")
grep -q '"serverInfo"' <<<"$INIT" || fail "mcp initialize: $INIT"
TOOLS=$(curl -sS "${MCPH[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' "$GW/mcp")
grep -q 'beagle_balance' <<<"$TOOLS" || fail "mcp tools/list: $TOOLS"
CALL=$(curl -sS "${MCPH[@]}" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"beagle_balance","arguments":{}}}' "$GW/mcp")
grep -q 'balanceMicro' <<<"$CALL" || fail "mcp beagle_balance: $CALL"

log "status endpoint"
STATUS=$(curl -sS $GW/api/status)
[ "$(json "$STATUS" 'd.cluster')" = "localnet" ] || fail "status.cluster: $STATUS"
[ "$(json "$STATUS" 'd.mint')" = "$MINT" ] || fail "status.mint: $STATUS"

log "ALL GOOD"
