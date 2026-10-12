#!/usr/bin/env bash
# solana/scripts/keypair.sh — keypair helpers that need no ~/.config/solana (docs/SPEC.md §2).
#
#   keypair.sh new <file>                      generate a keypair file (no BIP39 passphrase; overwrites)
#   keypair.sh pubkey <file>                   print the public key (base58)
#   keypair.sh base58 <file>                   print the 64-byte secret key as base58 — the gateway's OPERATOR_SECRET_KEY
#                                              accepts this or the JSON byte array that is the file itself
#   keypair.sh airdrop <file|pubkey> [sol] [rpc]   request SOL (localnet / devnet only; default 1 SOL, http://127.0.0.1:8899)
set -euo pipefail

cmd="${1:-}"; arg="${2:-}"
die() { printf 'keypair.sh: %s\n' "$*" >&2; exit 1; }
case "$cmd" in
  new)
    [ -n "$arg" ] || die "usage: keypair.sh new <file>"
    solana-keygen new --no-bip39-passphrase --silent --force -o "$arg" >/dev/null
    printf '%s\n' "$(solana-keygen pubkey "$arg")"
    ;;
  pubkey)
    [ -f "$arg" ] || die "usage: keypair.sh pubkey <file>"
    solana-keygen pubkey "$arg"
    ;;
  base58)
    [ -f "$arg" ] || die "usage: keypair.sh base58 <file>"
    node -e '
      const bytes = Uint8Array.from(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")));
      if (bytes.length !== 64) throw new Error(`expected a 64-byte secret key, got ${bytes.length} bytes`);
      const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
      let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b);
      let s = ""; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
      for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
      process.stdout.write(s + "\n");' "$arg"
    ;;
  airdrop)
    [ -n "$arg" ] || die "usage: keypair.sh airdrop <file|pubkey> [sol] [rpc-url]"
    sol="${3:-1}"; rpc="${4:-${RPC_URL:-http://127.0.0.1:8899}}"
    if [ -f "$arg" ]; then arg=$(solana-keygen pubkey "$arg"); fi
    solana airdrop "$sol" "$arg" --url "$rpc" --commitment confirmed
    ;;
  *)
    sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac
