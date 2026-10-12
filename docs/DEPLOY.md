# Deploying Beagle (Solana)

Three moving parts: the token (an SPL mint — nothing to deploy on-chain beyond it), the gateway (API + indexer +
operator keypair + price service) and the web app. Everything is configured from one `.env` (see
`.env.example`). Clusters, RPC endpoints, explorers and faucets: `docs/SOLANA.md`.

## 0. Prerequisites

- Node ≥ 22.13, pnpm 10, Solana CLI 3.x (`solana`, `solana-keygen`, `spl-token`, `solana-test-validator` for local
  work), Docker (optional).
- Keypairs: **deployer** (creates the mint on devnet; pays fees), **operator** (the gateway's hot wallet: it signs
  delegate burns for agent budgets and needs a little SOL), the web and agents bring their own wallets.
- SOL for fees (devnet faucet in `docs/SOLANA.md`).

## 1. Token

- **Localnet / devnet**: `bash solana/scripts/setup-cluster.sh <cluster>` creates a 6-decimal mint, mints the supply
  to the deployer, disables further minting and writes `solana/deployments/<cluster>.json`. Localnet uses the
  committed test keypairs in `solana/keys/` (never fund them anywhere else).
- **Mainnet**: launch the token the way the original launched `$DARWIN` — on **pump.fun** — then write
  `solana/deployments/mainnet-beta.json` by hand (`mint`, `decimals: 6`, `symbol`, `tokenProgram`, `operator`).
  The gateway only needs the mint address; nothing is deployed.

Then `node scripts/sync-deployments.mjs && pnpm -r build` and commit the deployment JSON plus
`packages/shared/src/deployments.generated.ts`.

## 2. Gateway

```bash
cp .env.example .env     # CLUSTER, RPC_URL, OPERATOR_SECRET_KEY, DRY_RUN=false, PRICE_SOURCE, SESSION_SECRET, KEYRING_MASTER_KEY,
                         # ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY, HOUSE_BASE_URL, PUBLIC_URL, PUBLIC_WEB_ORIGIN
pnpm install && pnpm -r build
node --env-file=.env gateway/dist/cli.js migrate
node --env-file=.env gateway/dist/cli.js set-price --usd 0.01      # PRICE_SOURCE=manual: first price point
NODE_ENV=production node --env-file=.env gateway/dist/main.js      # http://0.0.0.0:8787
```

The gateway reads `process.env` only: pass the file with `--env-file`, export it in the shell, or use `env_file`
in compose. Secrets: `SESSION_SECRET` (≥ 32 random bytes), `KEYRING_MASTER_KEY` (`openssl rand -hex 32`),
`ADMIN_TOKEN` (optional), `OPERATOR_SECRET_KEY` (base58 or the JSON byte array of `solana-keygen`; keep it funded
with ~0.1 SOL; it can only burn what agents delegated to it).

Price: `PRICE_SOURCE=jupiter` on mainnet (Jupiter Price API by mint), `feed` for your own endpoint
(`{ "priceUsd": … }`), `manual` for devnet/local (`set-price`, `POST /api/admin/price`). Changes are published as
price points (`/api/price/history`) and every credit event pins the point it used.

Indexing: the first start indexes the newest `INDEX_PAGE_LIMIT` burns of the mint; set `INDEX_FROM_SIGNATURE` to
start from a known transaction instead. Rebuilding from scratch = delete the DB rows of `credit_events`/`ledger`
credits and restart with the cursor cleared (or point at a fresh `DB_PATH`); debits cannot be rebuilt — back up
the SQLite file.

House model: run vLLM with an OpenAI-compatible API and set `HOUSE_BASE_URL` (e.g. `http://house:8000/v1`):

```bash
docker compose --profile gpu up -d house                 # openai/gpt-oss-20b (one 24 GB+ GPU)
docker compose --profile gpu-large up -d house-large     # openai/gpt-oss-120b (one 80 GB GPU, Pro plan)
```

The gateway has a single house endpoint: to serve both models put an OpenAI-compatible router in front of the
two services, or drop the other model from the catalog (`MODEL_CATALOG_FILE`). Without a GPU leave
`HOUSE_BASE_URL` empty or point it at Ollama (`http://127.0.0.1:11434/v1`, `HOUSE_MODEL_SMALL=gpt-oss:20b`).

## 3. Web

```bash
VITE_CLUSTER=mainnet-beta VITE_GATEWAY_URL= pnpm --filter @beagle/web build   # same-origin API behind nginx
```

`docker compose up -d gateway web` builds both images; nginx serves the SPA on `:8080` and proxies `/api`, `/v1`,
`/mcp`, `/healthz` to the gateway with buffering disabled (SSE). `PUBLIC_URL` of the gateway must equal the
origin the browser talks to (SIWS domain): dev `http://localhost:8787` = `VITE_GATEWAY_URL`; prod the site URL.

## 4. Smoke test

```bash
curl -s https://<host>/api/status | jq
curl -s https://<host>/api/price | jq
# burn on /app/credits (or spl-token burn <ata> 1000 from the CLI), then:
curl https://<host>/v1/chat/completions -H "authorization: Bearer bgl_…" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"hello"}]}' -i
```

Local full flow without a network: `pnpm solana:e2e` (`scripts/solana-e2e.sh`, needs `solana-test-validator`).

## 5. Operations

- **Indexer lag**: `/api/status.indexer.lagSlots`. Credits appear once the burn is `confirmed` (seconds); the
  finality sweep reverts a credit whose transaction disappears before `finalized` (rare).
- **Price**: `/api/price.stale` turns true after `PRICE_MAX_AGE_S`; burns are still credited at the last point
  (`CREDIT_WHEN_STALE`), the Credits page disables burning. Fix the source or `set-price`.
- **Budgets**: a budget stalls when the agent revoked the delegation, emptied the token account, or a draw
  failed; agents re-approve (`ApproveChecked`) — a new approval replaces the cap.
- **Operator SOL**: `/api/status.operator.solBalance`; top up before it runs dry (draws stop otherwise).
- **Catalog prices** are snapshots: override with `MODEL_CATALOG_FILE` when providers change prices.
- **Backups**: the SQLite file (`DB_PATH`) holds the ledger (credits rebuildable from the chain + price history,
  debits not) — back it up.
