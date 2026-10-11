# Deploying Beagle

Three moving parts: the contracts (`CreditDesk`, a price source, optionally `BeagleToken`), the gateway
(API + indexer + operator) and the web app. Everything is configured from one `.env` (see `.env.example`).
Network parameters and addresses: `docs/ROBINHOOD_CHAIN.md`.

## 0. Prerequisites

- Node ≥ 22.13, pnpm 10, Foundry (stable), Docker (optional), `git submodule update --init --recursive`.
- Wallets: **deployer** (pays gas), **owner** (multisig with a timelock on mainnet; may equal deployer on
  testnet), **operator** (gateway hot wallet: posts prices and draws budgets), **poster** (usually the operator).
- ETH on Robinhood Chain for gas (testnet faucets in `docs/ROBINHOOD_CHAIN.md`).

## 1. Token

- **Testnet / anvil**: let `Deploy.s.sol` deploy `BeagleToken` (1 000 000 000 BEAGLE to `TOKEN_RECIPIENT`).
- **Mainnet**: launch the token the way the original launched `$DARWIN` on pump.fun — on **Pons**
  (ponsfamily.com, Robinhood Chain's launchpad) — then set `TOKEN=<address>` and `NATIVE_BURN=false`
  (Pons tokens have no `burn()`; the desk burns by transfer to `0x…dEaD`). Any ERC-20 works.

## 2. Contracts

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY=0x…  OWNER=0x…  OPERATOR=0x…  POSTER=0x…
export TOKEN=                     # empty → deploy BeagleToken
export INITIAL_PRICE_E18=10000000000000000   # bootstrap price: $0.01 per token (0 = leave unset)
export MAX_PRICE_AGE=3600 MIN_BURN=0
forge script script/Deploy.s.sol --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" --broadcast --private-key "$DEPLOYER_PRIVATE_KEY" \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api
```

The script writes `contracts/deployments/<chainId>.json`. Then:

```bash
cd .. && node scripts/sync-deployments.mjs && node scripts/sync-abi.mjs && pnpm -r build
```

Commit the deployment JSON and the regenerated `packages/shared/src/*.generated.ts`.

Post-deploy checklist:
- If `OWNER ≠ deployer`, the owner must call `acceptOwnership()` on **both** `CreditDesk` and
  `ManualPriceSource` (Ownable2Step).
- `CreditDesk.operator()` must equal the gateway's `OPERATOR_PRIVATE_KEY` address; `ManualPriceSource.poster()` too.
- Set a real price: `PRICE_SOURCE=0x… PRICE_E18=… POSTER_PRIVATE_KEY=0x… forge script script/PostPrice.s.sol --rpc-url … --broadcast`
  or enable the gateway price poster (`PRICE_POSTER_ENABLED=true`, `PRICE_FEED_URL=…`).
- Verify on Blockscout: `forge verify-contract --verifier blockscout --verifier-url <api> <address> <Contract>`.

## 3. Gateway

```bash
cp .env.example .env         # CHAIN_ID, RPC_URL, OPERATOR_PRIVATE_KEY, DRY_RUN=false, SESSION_SECRET, KEYRING_MASTER_KEY,
                             # ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY, HOUSE_BASE_URL, PUBLIC_URL, PUBLIC_WEB_ORIGIN
pnpm install && pnpm -r build
node gateway/dist/cli.js migrate
node gateway/dist/main.js    # http://0.0.0.0:8787
```

Secrets: `SESSION_SECRET` (≥ 32 random bytes), `KEYRING_MASTER_KEY` (`openssl rand -hex 32`), `ADMIN_TOKEN`
(optional). Keep `OPERATOR_PRIVATE_KEY` funded with a little ETH for draws and price posts; it can only draw
within budget caps and post prices within `maxStepBps`.

House model: run vLLM with an OpenAI-compatible API and set `HOUSE_BASE_URL` (e.g. `http://house:8000/v1`):

```bash
docker compose --profile gpu up -d house          # openai/gpt-oss-20b (one 24 GB+ GPU)
docker compose --profile gpu-large up -d house-large   # openai/gpt-oss-120b (one 80 GB GPU, Pro plan)
```

Without a GPU, leave `HOUSE_BASE_URL` empty (the house tier disappears from routing) or point it at Ollama
(`http://127.0.0.1:11434/v1`, `HOUSE_MODEL_SMALL=gpt-oss:20b`).

## 4. Web

```bash
VITE_CHAIN_ID=4663 VITE_GATEWAY_URL= pnpm --filter @beagle/web build   # same-origin API behind nginx
```

`docker compose up -d gateway web` builds both images; nginx serves the SPA on `:8080` and proxies
`/api`, `/v1`, `/mcp`, `/healthz` to the gateway with buffering disabled (SSE).

## 5. Smoke test

```bash
curl -s https://<host>/api/status | jq
curl -s https://<host>/api/price | jq
# burn on /app/credits, then:
curl https://<host>/v1/chat/completions -H "authorization: Bearer bgl_…" -H 'content-type: application/json' \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"hello"}]}' -i
```

Local full flow without a network: `pnpm anvil:e2e` (`scripts/anvil-e2e.sh`).

## 6. Operations

- **Indexer lag**: `/api/status.indexer.lagBlocks`. Credits appear after `CONFIRMATIONS` blocks.
- **Price**: `/api/price.stale` turns true after `maxPriceAge`; burns then revert with `PriceStale` and the
  Credits page disables the button. Post a price.
- **Budgets**: a stalled budget (`stalledReason = allowance | price | draw_failed`) contributes no headroom;
  the agent must top up allowance/balance.
- **Catalog prices** are snapshots: override with `MODEL_CATALOG_FILE` when providers change prices.
- **Backups**: the SQLite file (`DB_PATH`) is a cache of on-chain credits plus the debit ledger — back it up;
  credits can be rebuilt from events (`indexer_state.last_block = deployBlock − 1` and restart), debits cannot.
