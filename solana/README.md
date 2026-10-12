# solana/

No on-chain program: Beagle uses the SPL Token and Memo programs only (docs/SPEC.md §3). This directory holds the
cluster setup script, the test keypairs and the per-cluster deployment records.

```
keys/deployer.json        TEST key: fee payer + mint authority of the localnet mint
keys/operator.json        TEST key: the gateway operator on localnet (signs budget draws)
keys/mint-localnet.json   TEST key: fixed mint keypair → the localnet mint address is deterministic
scripts/setup-cluster.sh  <localnet|devnet|mainnet-beta>: airdrop, create the mint (6 decimals), mint 1e9 tokens,
                          disable minting, write deployments/<cluster>.json
scripts/keypair.sh        new | pubkey | base58 | airdrop helpers (no ~/.config/solana needed)
deployments/<cluster>.json  { cluster, mint, decimals, symbol, tokenProgram, operator, memoProgram, createdSlot? }
```

**The keys in `keys/` are committed test keys: anyone can read them. Never fund them on mainnet-beta or devnet,
never reuse them anywhere.** Real deployments pass `DEPLOYER_KEYPAIR` / `OPERATOR_PUBKEY` / `EXISTING_MINT` from the
environment (see `.env.example`, docs/SOLANA.md).

## Localnet

```sh
solana-test-validator --reset --quiet --ledger "$(mktemp -d)"   # terminal 1 (RPC http://127.0.0.1:8899)
pnpm cluster:setup                                              # = bash solana/scripts/setup-cluster.sh localnet
pnpm deployments:sync                                           # regenerates packages/shared/src/deployments.generated.ts
```

`deployments/localnet.json` is committed and stable across runs (fixed mint keypair); `createdSlot` is the slot of
the committed reference run. `scripts/solana-e2e.sh` runs the whole flow on a temporary validator (`pnpm solana:e2e`).

## Devnet / mainnet-beta

```sh
DEPLOYER_KEYPAIR=~/.config/solana/deployer.json OPERATOR_PUBKEY=<base58> bash solana/scripts/setup-cluster.sh devnet
EXISTING_MINT=<pump.fun mint> OPERATOR_PUBKEY=<base58> bash solana/scripts/setup-cluster.sh mainnet-beta
pnpm deployments:sync
```

Re-running is safe (e.g. after the devnet faucet rate-limited the airdrop): the mint `deployments/<cluster>.json`
already records is reused, never replaced by a new one — set `EXISTING_MINT` / `MINT_KEYPAIR` or remove the file to
switch mints. Files named `deployments/*.local.json` are ignored by git and by `sync-deployments`.
