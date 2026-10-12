# Solana — reference for Beagle

Beagle has no on-chain program (docs/SPEC.md §3): credit is bought with a plain SPL `Burn`/`BurnChecked` of the
`BEAGLE` mint (optional SPL Memo `beagle:v1 ws=<base58>`), budgets are SPL delegations (`ApproveChecked` to the
operator, `Revoke` to close), the price is published off-chain by the gateway. Everything below is what an operator
or a contributor needs to talk to the chain.

## Clusters

| Cluster | JSON-RPC | WebSocket | Faucet |
|---|---|---|---|
| `mainnet-beta` | `https://api.mainnet-beta.solana.com` | `wss://api.mainnet-beta.solana.com` | — |
| `devnet` | `https://api.devnet.solana.com` | `wss://api.devnet.solana.com` | `solana airdrop 1 <pubkey> -u devnet` (rate-limited), https://faucet.solana.com |
| `localnet` | `http://127.0.0.1:8899` | `ws://127.0.0.1:8900` | `solana airdrop 10 <pubkey> -u localhost` (the validator's faucet on :9900) |

The public endpoints are rate-limited (≈ 100 req / 10 s per IP on mainnet, no `getProgramAccounts` on some methods)
and meant for development. Run the gateway on mainnet with a private RPC provider (Helius, Triton, QuickNode,
Alchemy, Ankr, …) — the indexer polls `getSignaturesForAddress(mint)` + `getTransaction` every `POLL_INTERVAL_MS` and the
budget scanner uses `getProgramAccounts` with memcmp filters (`RPC_URL`, optional `RPC_WS_URL` in `.env`). CAIP-2
ids used by Sign-In-With-Solana: `solana:mainnet`, `solana:devnet`, `solana:localnet`.

`solana-test-validator` (localnet) ships the SPL programs Beagle uses: Token, Token-2022, Associated Token, Memo
(`MemoSq4…` v3 and `Memo1Uh…` v1). It does **not** ship the Memo v4 program (`Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`)
that `@solana/spl-memo` 0.3.x exports as `MEMO_PROGRAM_ID` — build memo instructions with `MEMO_PROGRAM_ID` from
`@beagle/shared/addresses` (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`), as `scripts/e2e/burn.mjs` does.

## Explorers

| Explorer | Transaction | Address / token | Cluster parameter |
|---|---|---|---|
| Solana Explorer | `https://explorer.solana.com/tx/<signature>` | `https://explorer.solana.com/address/<pubkey>` | mainnet: none · devnet: `?cluster=devnet` · localnet: `?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899` |
| Solscan | `https://solscan.io/tx/<signature>` | `https://solscan.io/account/<pubkey>`, `https://solscan.io/token/<mint>` | devnet: `?cluster=devnet` (no localnet) |
| SolanaFM | `https://solana.fm/tx/<signature>` | `https://solana.fm/address/<pubkey>` | `?cluster=devnet-solana` |

`@beagle/shared/clusters` (`explorerTxUrl`, `explorerAddressUrl`, `explorerTokenUrl`) builds these links; the web and
the MCP tools use them.

## Program ids (SPEC §1)

| Program | Id |
|---|---|
| Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Associated Token | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| Memo (v3) | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` |

Deployed mints and the operator key per cluster: `solana/deployments/<cluster>.json` → `pnpm deployments:sync` →
`packages/shared/src/deployments.generated.ts` (SPEC §3.1, §4.2).

## CLI cheat sheet (Agave 3.x: `solana`, `solana-keygen`, `solana-test-validator`, `spl-token` 5.x)

Install the release the CI uses (Linux x86_64; macOS: `aarch64-apple-darwin`):

```sh
curl -sSfL https://github.com/anza-xyz/agave/releases/download/v3.0.9/solana-release-x86_64-unknown-linux-gnu.tar.bz2 \
  | tar -xj -C "$HOME/.local/share" && export PATH="$HOME/.local/share/solana-release/bin:$PATH"
# or: sh -c "$(curl -sSfL https://release.anza.xyz/v3.0.9/install)"
```

Keys and SOL (every command below also accepts `-u localhost|devnet|mainnet-beta` or `--url <rpc>`). Keep keypair
files **outside the checkout** (`~/.config/solana/…` below): nothing in `.gitignore` covers a `*.json` key dropped
into the repo, and `git add -A` for the deployment record (docs/DEPLOY.md §1) would commit it — only the committed
TEST keys live in `solana/keys/`:

```sh
K=~/.config/solana; mkdir -p "$K"
solana-keygen new --no-bip39-passphrase -o "$K/wallet.json"    # bash solana/scripts/keypair.sh new "$K/wallet.json"
solana-keygen pubkey "$K/wallet.json"
bash solana/scripts/keypair.sh base58 "$K/operator.json"      # secret key as base58 → OPERATOR_SECRET_KEY
solana balance <pubkey> -u devnet
solana airdrop 1 <pubkey> -u devnet
solana config set -u devnet -k "$K/wallet.json"               # optional: default signer / cluster for the CLIs
```

Below, `wallet.json`, `deployer.json`, `sender.json` stand for such files.

Mint (what `solana/scripts/setup-cluster.sh` does, with `--fee-payer` / `--mint-authority` so no default signer is needed):

```sh
spl-token create-token --decimals 6 --mint-authority <deployer> --fee-payer deployer.json mint.json   # fixed address
spl-token create-account <mint> --owner <deployer> --fee-payer deployer.json                           # the ATA
spl-token mint <mint> 1000000000 --mint-authority deployer.json --recipient-owner <deployer> --fee-payer deployer.json
spl-token authorize <mint> mint --disable --authority deployer.json --fee-payer deployer.json          # supply is final
spl-token display <mint> --output json                        # programId, mintAuthority, supply, decimals
spl-token address --verbose --owner <pubkey> --token <mint>   # associated token account of a wallet
spl-token balance <mint> --owner <pubkey>
spl-token transfer <mint> 100000 <recipient-wallet> --owner sender.json --fee-payer sender.json \
  --fund-recipient --allow-unfunded-recipient                 # creates the recipient's ATA
```

Burn (= buy credit; the gateway credits the token account **owner**, or the workspace named in the memo):

```sh
spl-token burn <token-account> 1000 --owner wallet.json --fee-payer wallet.json --with-memo "beagle:v1 ws=<base58>"
node scripts/e2e/burn.mjs --keypair wallet.json --mint <mint> --amount 1000 --memo "beagle:v1 ws=<base58>" --rpc <url>
```

Budgets (= SPL delegation to the operator; a new approve replaces the cap, revoke closes the budget):

```sh
spl-token approve <token-account> 500 <operator-pubkey> --owner wallet.json --fee-payer wallet.json
spl-token revoke <token-account> --owner wallet.json --fee-payer wallet.json
spl-token display <token-account>                             # delegate, delegated amount, balance (also: spl-token account-info <mint> <owner-pubkey>)
node scripts/e2e/approve.mjs --keypair wallet.json --mint <mint> --amount 500 --delegate <operator> --rpc <url>
node scripts/e2e/revoke.mjs  --keypair wallet.json --mint <mint> --rpc <url>
```

Inspect what the indexer sees:

```sh
solana confirm -v <signature> -u <cluster>
curl -s -X POST -H 'content-type: application/json' <rpc> -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction",
  "params":["<signature>",{"encoding":"jsonParsed","commitment":"confirmed","maxSupportedTransactionVersion":0}]}'
#  → instructions[].program == "spl-token", parsed.type == "burnChecked", parsed.info.{account,authority,mint,tokenAmount}
#  → instructions[].program == "spl-memo", parsed == "beagle:v1 ws=…"; meta.preTokenBalances[].owner = the credited owner
curl -s -X POST -H 'content-type: application/json' <rpc> -d '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress",
  "params":["<mint>",{"limit":10,"commitment":"confirmed"}]}'   # every burn mentions the mint (SPEC §3.2)
```

Local validator:

```sh
solana-test-validator --reset --quiet --ledger "$(mktemp -d)"   # RPC :8899, WS :8900, faucet :9900
pnpm cluster:setup && pnpm deployments:sync                      # localnet mint from the committed test keys
pnpm solana:e2e                                                  # the whole flow on a temporary validator
```

## pump.fun launch (mainnet-beta)

The mainnet `BEAGLE` is launched on pump.fun, not by this repository. What the launchpad produces and what Beagle
needs from it:

- A classic Token-program mint with **6 decimals** and a 1 000 000 000 supply, Metaplex metadata, **mint authority
  and freeze authority revoked** by the launchpad (`spl-token display <mint>` → `mintAuthority: null`,
  `freezeAuthority: null`). Nothing can be minted or frozen afterwards — the burn-only economics of SPEC §3.2 hold.
- **The gateway needs only the mint address** (and the operator keypair it already owns). No deploy, no token
  handover, no treasury wallet:
  ```sh
  EXISTING_MINT=<mint> OPERATOR_PUBKEY=<operator pubkey> bash solana/scripts/setup-cluster.sh mainnet-beta
  pnpm deployments:sync          # commits solana/deployments/mainnet-beta.json + the generated TS
  ```
  The script reads decimals and the owning token program from the chain and warns if the mint authority is still set.
- Gateway `.env` for mainnet: `CLUSTER=mainnet-beta`, `RPC_URL=<private provider>`, `OPERATOR_SECRET_KEY=<hot wallet>`
  funded with SOL for draw fees, `DRY_RUN=false`, `PRICE_SOURCE=jupiter` (Jupiter Price API by mint; `feed` or
  `manual` as fallbacks), `INDEX_FROM_SIGNATURE=<a recent signature>` so the first run does not page through the
  launch history. Burns before that signature are not credited.
- Indexing cost: `getSignaturesForAddress(mint)` returns every transaction that mentions the mint account, i.e. also
  every `transferChecked` / pump.fun trade that references it read-only. The indexer fetches each with
  `getTransaction` and keeps only `burn`/`burnChecked`; on a busy token budget the RPC accordingly
  (`INDEX_PAGE_LIMIT`, `TX_FETCH_CONCURRENCY`, `POLL_INTERVAL_MS`).
- Wallet UX: Phantom/Solflare show a plain "Burn 1000 BEAGLE" + memo in the confirmation; no program approval,
  no token account creation is needed (the user already holds the token). Budgets show as "Approve delegate".

## Operator wallet

The operator (`OPERATOR_SECRET_KEY`) is a hot wallet whose only transactions are budget draws:
`[ComputeBudget?, BurnChecked(tokenAccount, mint, authority = operator), Memo("beagle:draw v1 ws=… h=0x…")]`.
It can never transfer tokens — SPL delegation lets a delegate burn or transfer only up to `delegatedAmount`, and the
gateway signs burns only — so the blast radius of a leaked key is the SOL it holds plus burning delegated budgets
early. Keep ~0.1–1 SOL on it, monitor `/api/status.operator.solBalance`, rotate by publishing a new
`solana/deployments/<cluster>.json` (`operator`) and asking agents to re-approve the new key.
