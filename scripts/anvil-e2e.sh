#!/usr/bin/env bash
# End-to-end flow on a local anvil (docs/SPEC.md §8):
#   anvil → Deploy.s.sol → sync deployments → build → mock provider → gateway → keys →
#   burn → credit indexed → chat completion (JSON + SSE) → /v1/messages → 402 without credit →
#   agent budget → draw → confirmed → MCP over HTTP.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RPC=http://127.0.0.1:8545
MOCK_PORT=9999
GW_PORT=8797
GW=http://127.0.0.1:$GW_PORT
WORK="$(mktemp -d)"
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
A0=$(cast wallet address --private-key $K0)
A1=$(cast wallet address --private-key $K1)
A2=$(cast wallet address --private-key $K2)
PIDS=()

log()  { printf '\n\033[1;36m[e2e]\033[0m %s\n' "$*"; }
fail() { printf '\n\033[1;31m[e2e] FAIL:\033[0m %s\n' "$*"; exit 1; }
DEPLOY_FILE=contracts/deployments/31337.json
GEN_FILE=packages/shared/src/deployments.generated.ts
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  # restore the committed anvil reference deployment (the deploy script rewrites it on every run)
  [ -f "$WORK/deploy.bak" ] && cp "$WORK/deploy.bak" "$DEPLOY_FILE" && cp "$WORK/gen.bak" "$GEN_FILE" && \
    (pnpm --filter @beagle/shared build >/dev/null 2>&1 || true)
  rm -rf contracts/broadcast/31337 "$WORK"
}
trap cleanup EXIT
mkdir -p "$(dirname "$DEPLOY_FILE")"
[ -f "$DEPLOY_FILE" ] && cp "$DEPLOY_FILE" "$WORK/deploy.bak" && cp "$GEN_FILE" "$WORK/gen.bak"

json() { # json <json-string> <js-expression on `d`>
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=eval(process.argv[1]);process.stdout.write(v===undefined?"":String(v))})' "$2" <<<"$1"
}
wait_for() { # wait_for <description> <timeout-seconds> <command...> (command must exit 0)
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

log "anvil"
anvil --block-time 1 --silent >"$WORK/anvil.log" 2>&1 & PIDS+=($!)
wait_for anvil 30 cast block-number --rpc-url $RPC

log "deploy contracts (deployer/operator/poster = $A0, price \$0.01)"
( cd contracts && DEPLOYER_PRIVATE_KEY=$K0 OWNER=$A0 OPERATOR=$A0 POSTER=$A0 INITIAL_PRICE_E18=10000000000000000 \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --private-key $K0 >"$WORK/deploy.log" 2>&1 ) || { cat "$WORK/deploy.log"; fail "deploy"; }
DEPLOY_JSON=$(cat contracts/deployments/31337.json)
TOKEN=$(json "$DEPLOY_JSON" 'd.token'); DESK=$(json "$DEPLOY_JSON" 'd.creditDesk')
log "token=$TOKEN desk=$DESK"
node scripts/sync-deployments.mjs >/dev/null

log "fund accounts 1 and 2 with 100 000 BEAGLE each"
cast send --rpc-url $RPC --private-key $K0 "$TOKEN" "transfer(address,uint256)" "$A1" 100000ether >/dev/null
cast send --rpc-url $RPC --private-key $K0 "$TOKEN" "transfer(address,uint256)" "$A2" 100000ether >/dev/null

log "build workspace packages"
pnpm -r --filter @beagle/shared --filter @beagle/mcp --filter @beagle/gateway run build >"$WORK/build.log" 2>&1 || { tail -50 "$WORK/build.log"; fail "build"; }

log "mock provider on :$MOCK_PORT"
MOCK_PORT=$MOCK_PORT node scripts/mock-provider.mjs >"$WORK/mock.log" 2>&1 & PIDS+=($!)
wait_for mock-provider 15 curl -sf http://127.0.0.1:$MOCK_PORT/v1/models

log "gateway on :$GW_PORT"
export CHAIN_ID=31337 RPC_URL=$RPC START_BLOCK=0 CONFIRMATIONS=0 POLL_INTERVAL_MS=1000 \
  OPERATOR_PRIVATE_KEY=$K0 DRY_RUN=false PORT=$GW_PORT HOST=127.0.0.1 PUBLIC_URL=$GW PUBLIC_WEB_ORIGIN=http://localhost:5173 \
  DB_PATH="$WORK/gateway.sqlite" SESSION_SECRET=e2e-session-secret-e2e-session-secret KEYRING_MASTER_KEY=$(printf '11%.0s' $(seq 1 32)) ADMIN_TOKEN=e2e-admin \
  ANTHROPIC_API_KEY= OPENAI_API_KEY= GOOGLE_API_KEY= HOUSE_BASE_URL=http://127.0.0.1:$MOCK_PORT/v1 \
  DRAW_THRESHOLD_USD=0.000001 DRAW_INTERVAL_MS=2000 BUDGET_HEADROOM_REFRESH_MS=2000 RESERVATION_TTL_MS=600000 \
  LOG_LEVEL=info NODE_ENV=test
node gateway/dist/main.js >"$WORK/gateway.log" 2>&1 & PIDS+=($!)
wait_for gateway 30 curl -sf $GW/healthz

log "api keys for $A1 and $A2"
KEY1=$(node gateway/dist/cli.js create-key --workspace "$A1" --name e2e-1 | grep -oE 'bgl_[A-Za-z0-9_-]{20,}' | tail -1)
KEY2=$(node gateway/dist/cli.js create-key --workspace "$A2" --name e2e-2 | grep -oE 'bgl_[A-Za-z0-9_-]{20,}' | tail -1)
[ -n "$KEY1" ] && [ -n "$KEY2" ] || fail "create-key printed no key"

log "account 1 burns 1000 BEAGLE (= \$10.00) for credit"
cast send --rpc-url $RPC --private-key $K1 "$TOKEN" "approve(address,uint256)" "$DESK" 1000ether >/dev/null
cast send --rpc-url $RPC --private-key $K1 "$DESK" "burnForCredit(address,uint256)" "$A1" 1000ether >/dev/null
balance_at_least() { local b; b=$(json "$(api "$KEY1" /api/balance)" 'd.balanceMicro'); [ -n "$b" ] && [ "$b" -ge "$1" ]; }
wait_for "credit to be indexed" 40 balance_at_least 9990000
BAL0=$(json "$(api "$KEY1" /api/balance)" 'd.balanceMicro'); log "balance after burn: $BAL0 µUSD"
[ "$BAL0" -eq 10000000 ] || fail "expected exactly 10_000_000 µUSD credit, got $BAL0"

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
import { receiptHash } from '@beagle/shared/canonical';
const d = JSON.parse(process.argv[1]); process.stdout.write(receiptHash(d.receipt));" "$RECEIPT" 2>/dev/null || \
  node --input-type=module -e "
import { receiptHash } from './packages/shared/dist/canonical.js';
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

log "account 2 without credit gets 402"
CODE=$(curl -sS -o "$WORK/r402" -w '%{http_code}' -H "authorization: Bearer $KEY2" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"no credit"}]}' "$GW/v1/chat/completions")
[ "$CODE" = "402" ] || { cat "$WORK/r402"; fail "expected 402, got $CODE"; }
grep -q 'insufficient_credit' "$WORK/r402" || fail "402 body lacks insufficient_credit"

log "account 2 authorizes a budget of 500 BEAGLE for 1 hour"
cast send --rpc-url $RPC --private-key $K2 "$TOKEN" "approve(address,uint256)" "$DESK" 500ether >/dev/null
DEADLINE=$(( $(date +%s) + 3600 ))
cast send --rpc-url $RPC --private-key $K2 "$DESK" "openBudget(address,uint128,uint64)" "$A2" 500ether "$DEADLINE" >/dev/null
headroom_positive() { local h; h=$(json "$(api "$KEY2" /api/balance)" 'd.budgetHeadroomMicro'); [ -n "$h" ] && [ "$h" -gt 0 ]; }
wait_for "budget headroom" 40 headroom_positive
log "budget headroom: $(json "$(api "$KEY2" /api/balance)" 'd.budgetHeadroomMicro') µUSD"

log "account 2 request now succeeds on budget"
CODE=$(curl -sS -o "$WORK/r2" -w '%{http_code}' -H "authorization: Bearer $KEY2" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"paid by budget"}],"max_tokens":32}' "$GW/v1/chat/completions")
[ "$CODE" = "200" ] || { cat "$WORK/r2"; fail "budget-paid request failed with $CODE"; }
BAL2=$(json "$(api "$KEY2" /api/balance)" 'd.balanceMicro'); log "account 2 ledger balance right after the request: $BAL2 µUSD (negative until the draw lands)"

log "operator draws from the budget; indexer credits the ledger"
drawn_and_settled() {
  local b d; b=$(json "$(api "$KEY2" /api/balance)" 'd.balanceMicro'); d=$(json "$(api "$KEY2" /api/budgets)" 'd[0] && d[0].drawn');
  [ -n "$b" ] && [ "$b" -ge 0 ] && [ -n "$d" ] && [ "$d" != "0" ]
}
wait_for "budget draw to be confirmed" 90 drawn_and_settled
BUDGETS=$(api "$KEY2" /api/budgets)
DRAWS=$(api "$KEY2" "/api/budgets/$(json "$BUDGETS" 'd[0].budgetId')/draws")
[ "$(json "$DRAWS" 'd.filter(x=>x.status==="confirmed").length')" -ge 1 ] || fail "no confirmed draw: $DRAWS"
DRAW_HASH=$(json "$DRAWS" 'd[0].receiptHash')
RECOMPUTED=$(node --input-type=module -e "
import { receiptHash } from './packages/shared/dist/canonical.js';
const d = JSON.parse(process.argv[1])[0]; process.stdout.write(receiptHash(d.batch));" "$DRAWS")
[ "$RECOMPUTED" = "$DRAW_HASH" ] || fail "draw receipt hash does not recompute ($RECOMPUTED != $DRAW_HASH)"
log "draw confirmed: drawn=$(json "$BUDGETS" 'd[0].drawn') hash=$DRAW_HASH"

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
[ "$(json "$STATUS" 'd.chainId')" = "31337" ] || fail "status: $STATUS"

log "ALL GOOD"
