#!/usr/bin/env bash
# solana/scripts/setup-cluster.sh <localnet|devnet|mainnet-beta>            (docs/SPEC.md §3.1, §8)
#
# Creates (or records) the BEAGLE mint of a cluster and writes solana/deployments/<cluster>.json, the file
# `node scripts/sync-deployments.mjs` turns into packages/shared/src/deployments.generated.ts.
#
#   localnet      starts NOTHING itself: it expects a running validator at RPC_URL (default http://127.0.0.1:8899,
#                 e.g. `solana-test-validator --reset --quiet --ledger "$(mktemp -d)"`). Uses the committed TEST
#                 keypairs in solana/keys/ (deployer = fee payer + mint authority, operator = the gateway hot wallet,
#                 mint-localnet = fixed mint keypair → deterministic mint address): airdrops SOL to the deployer and
#                 the operator, creates the mint (6 decimals), mints 1e9 whole tokens to the deployer's ATA,
#                 disables further minting (`spl-token authorize <mint> mint --disable`) and writes the file.
#   devnet        the same flow with keys from the environment: DEPLOYER_KEYPAIR (path; fee payer + mint authority),
#   mainnet-beta  OPERATOR_PUBKEY (base58) and either EXISTING_MINT (base58: record an already launched mint, e.g. the
#                 pump.fun token on mainnet — nothing is sent to the chain) or MINT_KEYPAIR (path; a throw-away keypair
#                 is generated when unset). devnet airdrops best-effort (https://faucet.solana.com when rate limited);
#                 mainnet-beta never airdrops.
#
# Other env: RPC_URL (cluster default), TOKEN_2022=1 (create the mint under Token-2022), SUPPLY (whole tokens,
# 1000000000), SYMBOL (BEAGLE), OUT_FILE (solana/deployments/<cluster>.json). Re-running against the same ledger is
# safe: an existing mint is reused, supply is minted only once, minting is disabled only when still enabled.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CLUSTER="${1:-}"
TOKEN_PROGRAM_CLASSIC=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA
TOKEN_PROGRAM_2022=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb
MEMO_PROGRAM=MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
SUPPLY="${SUPPLY:-1000000000}"
SYMBOL="${SYMBOL:-BEAGLE}"
DECIMALS=6

log()  { printf '\033[1;36m[setup-cluster]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[setup-cluster] warning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[setup-cluster] error:\033[0m %s\n' "$*" >&2; exit 1; }
usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

for tool in solana solana-keygen spl-token node curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH (install the Agave release: docs/SOLANA.md)"
done

AIRDROP=none
case "$CLUSTER" in
  localnet)
    RPC_URL="${RPC_URL:-http://127.0.0.1:8899}"
    DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-solana/keys/deployer.json}"
    MINT_KEYPAIR="${MINT_KEYPAIR:-solana/keys/mint-localnet.json}"
    OPERATOR_PUBKEY="${OPERATOR_PUBKEY:-$(solana-keygen pubkey solana/keys/operator.json)}"
    EXISTING_MINT="${EXISTING_MINT:-}"
    AIRDROP=required
    ;;
  devnet)
    RPC_URL="${RPC_URL:-https://api.devnet.solana.com}"
    AIRDROP=best-effort
    ;;
  mainnet-beta)
    RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
    ;;
  -h|--help|'') usage ;;
  *) die "unknown cluster '$CLUSTER' (localnet | devnet | mainnet-beta)" ;;
esac
DEPLOYER_KEYPAIR="${DEPLOYER_KEYPAIR:-}"
MINT_KEYPAIR="${MINT_KEYPAIR:-}"
EXISTING_MINT="${EXISTING_MINT:-}"
OPERATOR_PUBKEY="${OPERATOR_PUBKEY:-}"
OUT_FILE="${OUT_FILE:-solana/deployments/$CLUSTER.json}"
TOKEN_PROGRAM="$TOKEN_PROGRAM_CLASSIC"
if [ "${TOKEN_2022:-}" = "1" ] || [ "${TOKEN_2022:-}" = "true" ]; then TOKEN_PROGRAM="$TOKEN_PROGRAM_2022"; fi

[ -n "$OPERATOR_PUBKEY" ] || die "OPERATOR_PUBKEY is required for $CLUSTER (base58 public key of the gateway operator)"
if [ -z "$EXISTING_MINT" ]; then
  [ -n "$DEPLOYER_KEYPAIR" ] || die "DEPLOYER_KEYPAIR is required for $CLUSTER (path to the fee payer / mint authority keypair)"
  [ -f "$DEPLOYER_KEYPAIR" ] || die "DEPLOYER_KEYPAIR not found: $DEPLOYER_KEYPAIR"
fi

# ---------- helpers ----------
rpc() { # rpc <method> [params-json]  → raw JSON-RPC response (retries transient failures; empty body = fatal)
  local body
  body=$(curl -sS --retry 3 --retry-connrefused --retry-all-errors -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC_URL") || die "RPC $1 failed at $RPC_URL"
  [ -n "$body" ] || die "RPC $1 returned an empty response from $RPC_URL"
  printf '%s' "$body"
}
json() { # json <json-string> <js-expression on d>  → prints the value ("" for null/undefined)
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);const v=eval(process.argv[1]);process.stdout.write(v==null?"":String(v))})' "$2" <<<"$1"
}
FEE_PAYER=()
[ -n "$DEPLOYER_KEYPAIR" ] && FEE_PAYER=(--fee-payer "$DEPLOYER_KEYPAIR")
tok() { # spl-token with the cluster, fee payer and token program pinned (no ~/.config/solana needed)
  local cmd=$1; shift
  spl-token "$cmd" --url "$RPC_URL" --program-id "$TOKEN_PROGRAM" ${FEE_PAYER[@]+"${FEE_PAYER[@]}"} "$@"
}
lamports_of() { json "$(rpc getBalance "[\"$1\"]")" 'd.result.value'; }
account_exists() { # account_exists <pubkey>: true when the account has an owner (an RPC failure aborts, never "missing")
  local resp owner
  resp=$(rpc getAccountInfo "[\"$1\",{\"encoding\":\"base64\"}]")
  owner=$(json "$resp" 'd.error ? (()=>{throw new Error(JSON.stringify(d.error))})() : (d.result && d.result.value && d.result.value.owner)') || die "getAccountInfo $1 failed: $resp"
  [ -n "$owner" ]
}
airdrop() { # airdrop <pubkey> <sol> <min-lamports>: top up when below the minimum
  local who=$1 sol=$2 min=$3 have
  have=$(lamports_of "$who")
  if [ -n "$have" ] && [ "$have" -ge "$min" ]; then log "$who has $have lamports, no airdrop needed"; return 0; fi
  if solana airdrop "$sol" "$who" --url "$RPC_URL" --commitment confirmed >/dev/null 2>&1; then
    log "airdropped $sol SOL to $who"
  elif [ "$AIRDROP" = "required" ]; then
    die "airdrop to $who failed (is the validator at $RPC_URL running?)"
  else
    warn "airdrop to $who failed or rate limited — use https://faucet.solana.com, then re-run"
  fi
}

# ---------- cluster reachable? ----------
VERSION=$(json "$(rpc getVersion 2>/dev/null || echo '{}')" 'd.result && d.result["solana-core"]')
[ -n "$VERSION" ] || die "no Solana RPC at $RPC_URL (localnet: start \`solana-test-validator --reset --quiet --ledger \"\$(mktemp -d)\"\` first)"
log "cluster=$CLUSTER rpc=$RPC_URL (solana-core $VERSION) tokenProgram=$TOKEN_PROGRAM"

DEPLOYER=""
if [ -n "$DEPLOYER_KEYPAIR" ] && [ -f "$DEPLOYER_KEYPAIR" ]; then
  DEPLOYER=$(solana-keygen pubkey "$DEPLOYER_KEYPAIR")
  log "deployer=$DEPLOYER operator=$OPERATOR_PUBKEY"
else
  log "operator=$OPERATOR_PUBKEY (no deployer keypair: record-only mode)"
fi

# ---------- SOL ----------
if [ "$AIRDROP" != "none" ] && [ -n "$DEPLOYER" ]; then
  airdrop "$DEPLOYER" 10 5000000000
  airdrop "$OPERATOR_PUBKEY" 10 5000000000     # the operator pays the fees of budget draws
fi

CREATED_SLOT=""
if [ -n "$EXISTING_MINT" ]; then
  # ---------- record an existing mint (pump.fun launch on mainnet, or any mint created elsewhere) ----------
  MINT="$EXISTING_MINT"
  ACCT=$(rpc getAccountInfo "[\"$MINT\",{\"encoding\":\"base64\"}]")
  TOKEN_PROGRAM=$(json "$ACCT" 'd.result && d.result.value && d.result.value.owner')
  [ -n "$TOKEN_PROGRAM" ] || die "EXISTING_MINT $MINT does not exist on $CLUSTER"
  case "$TOKEN_PROGRAM" in
    "$TOKEN_PROGRAM_CLASSIC"|"$TOKEN_PROGRAM_2022") ;;
    *) die "EXISTING_MINT $MINT is owned by $TOKEN_PROGRAM, not an SPL Token program" ;;
  esac
  INFO=$(tok display --output json "$MINT")
  DECIMALS=$(json "$INFO" 'd.decimals')
  AUTH=$(json "$INFO" 'd.mintAuthority')
  log "existing mint $MINT: decimals=$DECIMALS supply=$(json "$INFO" 'd.supply') mintAuthority=${AUTH:-none}"
  [ -z "$AUTH" ] || warn "mint authority is still set ($AUTH): the supply is not fixed"
  CREATED_SLOT="${EXISTING_MINT_CREATED_SLOT:-}"
else
  # ---------- create the mint ----------
  if [ -z "$MINT_KEYPAIR" ]; then
    MINT_KEYPAIR="$(mktemp -d)/mint-$CLUSTER.json"
    solana-keygen new --no-bip39-passphrase --silent --force -o "$MINT_KEYPAIR" >/dev/null
    log "generated a throw-away mint keypair at $MINT_KEYPAIR (useless once minting is disabled)"
  fi
  [ -f "$MINT_KEYPAIR" ] || die "MINT_KEYPAIR not found: $MINT_KEYPAIR"
  MINT=$(solana-keygen pubkey "$MINT_KEYPAIR")

  if account_exists "$MINT"; then
    log "mint $MINT already exists on $CLUSTER, reusing it"
    INFO=$(tok display --output json "$MINT")
    [ "$(json "$INFO" 'd.programId')" = "$TOKEN_PROGRAM" ] || die "mint $MINT is owned by $(json "$INFO" 'd.programId'), expected $TOKEN_PROGRAM"
    DECIMALS=$(json "$INFO" 'd.decimals')
    # keep the slot recorded by the run that created it, when the previous file describes the same mint
    if [ -f "$OUT_FILE" ]; then
      PREV=$(cat "$OUT_FILE")
      [ "$(json "$PREV" 'd.mint')" = "$MINT" ] && CREATED_SLOT=$(json "$PREV" 'd.createdSlot')
    fi
  else
    SLOT_BEFORE=$(json "$(rpc getSlot)" 'd.result')
    log "creating mint $MINT ($DECIMALS decimals, mint authority $DEPLOYER)"
    CREATE_ARGS=()
    [ "$TOKEN_PROGRAM" = "$TOKEN_PROGRAM_2022" ] && CREATE_ARGS+=(--program-2022)
    OUT=$(spl-token create-token --url "$RPC_URL" --fee-payer "$DEPLOYER_KEYPAIR" --mint-authority "$DEPLOYER" \
      --decimals "$DECIMALS" --output json ${CREATE_ARGS[@]+"${CREATE_ARGS[@]}"} "$MINT_KEYPAIR")
    SIG=$(json "$OUT" 'd.commandOutput.transactionData.signature')
    [ -n "$SIG" ] || die "create-token printed no signature: $OUT"
    # the slot the mint was created in (getTransaction may lag the CLI's confirmation by a moment)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      CREATED_SLOT=$(json "$(rpc getTransaction "[\"$SIG\",{\"encoding\":\"json\",\"commitment\":\"confirmed\",\"maxSupportedTransactionVersion\":0}]")" 'd.result && d.result.slot')
      [ -n "$CREATED_SLOT" ] && break
      sleep 1
    done
    [ -n "$CREATED_SLOT" ] || { warn "could not read the creation slot of $SIG, using the slot before creation"; CREATED_SLOT="$SLOT_BEFORE"; }
    log "mint created in slot $CREATED_SLOT (tx $SIG)"
  fi

  # ---------- supply ----------
  INFO=$(tok display --output json "$MINT")
  if [ "$(json "$INFO" 'd.supply')" = "0" ]; then
    [ -n "$(json "$INFO" 'd.mintAuthority')" ] || die "mint $MINT has no supply and minting is already disabled"
    ATA=$(json "$(tok address --verbose --owner "$DEPLOYER" --token "$MINT" --output json)" 'd.associatedTokenAddress')
    [ -n "$ATA" ] || die "could not derive the deployer's associated token account"
    if ! account_exists "$ATA"; then
      tok create-account --owner "$DEPLOYER" --output json "$MINT" >/dev/null
      log "created the deployer's token account $ATA"
    fi
    tok mint --mint-authority "$DEPLOYER_KEYPAIR" --recipient-owner "$DEPLOYER" --output json "$MINT" "$SUPPLY" >/dev/null
    log "minted $SUPPLY $SYMBOL to $ATA"
    INFO=$(tok display --output json "$MINT")
  else
    log "supply already minted ($(json "$INFO" 'd.supply') raw units), skipping"
  fi

  # ---------- fix the supply ----------
  if [ -n "$(json "$INFO" 'd.mintAuthority')" ]; then
    tok authorize --authority "$DEPLOYER_KEYPAIR" --disable --output json "$MINT" mint >/dev/null
    log "mint authority disabled: the supply is final"
  else
    log "mint authority already disabled"
  fi
fi

# ---------- deployment record (§3.1) ----------
mkdir -p "$(dirname "$OUT_FILE")"
node -e '
const [cluster, mint, decimals, symbol, tokenProgram, operator, memoProgram, createdSlot] = process.argv.slice(1);
const d = { cluster, mint, decimals: Number(decimals), symbol, tokenProgram, operator, memoProgram };
if (createdSlot !== "") d.createdSlot = Number(createdSlot);
process.stdout.write(JSON.stringify(d, null, 2) + "\n");
' "$CLUSTER" "$MINT" "$DECIMALS" "$SYMBOL" "$TOKEN_PROGRAM" "$OPERATOR_PUBKEY" "$MEMO_PROGRAM" "$CREATED_SLOT" >"$OUT_FILE"
log "wrote $OUT_FILE"
cat "$OUT_FILE" >&2
log "next: node scripts/sync-deployments.mjs  (regenerates packages/shared/src/deployments.generated.ts)"
