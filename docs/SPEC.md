# Beagle — compute for agents on Solana · burn becomes compute

Normative specification. Implementation agents build from this document; where the document is silent,
prefer the simplest behaviour that keeps the stated invariants. `docs/ANALYSIS.md` explains the original
project (Darwin, @darwincompute) that this one replicates.

Conventions: MUST / SHOULD / MAY as in RFC 2119. "Gateway" is the Node service in `gateway/`; "workspace" is
the billing account of one wallet (a Solana public key); "operator" is the gateway's hot wallet keypair;
"mint" is the SPL token (`BEAGLE`) whose burns buy credit.

## 0. Product summary

- **One API key for every model.** A workspace gets `bgl_…` API keys. The gateway exposes an
  OpenAI-compatible `/v1/chat/completions` (+ `/v1/models`) and an Anthropic-compatible `/v1/messages`,
  routing to Anthropic (official SDK), OpenAI, Google Gemini (OpenAI-compatible endpoint) and the
  project's own **house** model served by vLLM (`gpt-oss-20b`, Pro: `gpt-oss-120b`).
- **Burn becomes compute.** Access is paid by burning the project token (`BEAGLE`, an SPL mint on Solana —
  on mainnet the pump.fun-launched token) **from the user's own wallet with a plain SPL `Burn`**; an optional
  SPL Memo names another workspace to credit. There is no custom on-chain program: the gateway indexes burns
  of the mint, prices them with its **published price point** at observation time and credits the workspace.
  No e-mail, no card: sign-in is Sign-In-With-Solana (a signed message), workspace = wallet.
- **Model router.** `beagle/auto` keeps the best model for hard requests, moves easy requests to cheaper
  models, downgrades as credit or provider limits run down, and falls back to the house model when
  everything else is unavailable. Explicit model ids are honoured with configurable fallback.
- **BYOK.** A workspace may store its own provider keys (encrypted at rest). Requests served through
  them consume no credit.
- **Agents.** An MCP server (stdio binary and `/mcp` HTTP transport) gives agents balance, models,
  quotes, inference, usage, compute purchase and **budgets**: an agent **delegates** a token allowance to the
  operator with SPL `Approve` (cap = delegated amount); the operator burns from it as usage accrues, never
  above the cap, with a receipt hash in the burn's memo; the agent revokes at any time.
- **Upgrades.** `pro` (30 days: large house model, 128K house context, higher rate limit) and `warm`
  hours (keep the house GPU warm) are bought with credit.

## 1. Units, identifiers, constants

| Term | Definition |
|---|---|
| µUSD | integer micro-dollars; `1 USD = 1_000_000 µUSD`. TS `bigint`, SQLite `INTEGER`. |
| `priceE18` | USD per **one whole token**, scaled by `1e18`. `$0.0025` → `2_500_000_000_000_000`. |
| token amount | raw units of the mint (`decimals` from the mint account; pump.fun-style mints and the local mint use **6**). Stored off-chain as decimal strings. |
| quote | `usdMicro = floor(amount · priceE18 / 10^(decimals + 12))`. For 6 decimals: `amount · priceE18 / 1e18`. Example: `1000 BEAGLE = 1_000_000_000 raw`, `priceE18 = 1e16` ($0.01) → `10_000_000 µUSD = $10`. |
| inverse quote | `tokens = ceil(usdMicro · 10^(decimals+12) / priceE18)`. |
| workspace id | the wallet public key, **base58** (case-sensitive, 32–44 chars). On-chain: the owner of the burned token account; off-chain: stored verbatim. UI shows `Abcd…wxyz`. |
| cluster | `mainnet-beta`, `devnet`, `localnet` (`solana-test-validator`, `http://127.0.0.1:8899`). |
| tx reference | transaction `signature` (base58, 87–88 chars), `slot`, `blockTime` (unix seconds). Credit event id = `<signature>:<ixIndex>`. |
| price point | a row `{ id, priceE18, source, observedAt }` of the gateway's published price history; every credit event references the point it was priced with. |
| request id | `req_` + UUIDv4. |
| API key | `bgl_` + 43 chars base64url of 32 random bytes. Stored as `sha256(key)` hex; `prefix` = first 12 characters (`bgl_xxxxxxxx`) for display. |
| session | random 32-byte id, 7 days. Cookie `beagle_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https) or `Authorization: Bearer <session>`. |
| model id | catalog id `provider/model` (e.g. `anthropic/claude-opus-5-5`). Aliases `beagle/auto`, `beagle/best`, `beagle/cheap`, `beagle/house`. Bare upstream ids (e.g. `claude-opus-5-5`) resolve when unique. |
| program ids | Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`, Associated Token `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`, Memo `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`. |
| memo | `beagle:v1 ws=<base58>` (credit another workspace) · `beagle:draw v1 ws=<base58> h=<0x…sha256>` (operator budget draw). UTF-8, ≤ 256 bytes. |

Money math is integer-only everywhere. Per-component model cost = `ceilDiv(tokens · pricePerMillion, 1_000_000)`;
markup = `cost + ceilDiv(cost · bps, 10_000)`.

## 2. Repository layout

```
solana/           scripts/setup-cluster.sh (airdrop, create the mint, mint supply, write deployments/<cluster>.json),
                  scripts/keypair.sh helpers, deployments/<cluster>.json (committed: localnet reference, devnet, mainnet-beta)
packages/shared/  @beagle/shared: clusters, addresses (program ids + deployments.generated.ts), memo, siws, solana (layouts/schemas),
                  credit math, model catalog, routing policy, difficulty heuristic, canonical JSON + receipt hash, API/OpenAI DTOs (zod)
packages/mcp/     @beagle/mcp: MCP tools (library), REST client, Keypair wallet executor, stdio binary `beagle-mcp`
gateway/          @beagle/gateway: Hono API, SQLite (node:sqlite), Solana indexer / budget scanner / drawer / price service,
                  router, metering, providers, MCP HTTP, CLI
web/              @beagle/web: Vite + React 19 + Solana wallet-adapter + TanStack Query + react-router 7 + Tailwind 4
scripts/          sync-deployments.mjs, mock-provider.mjs, solana-e2e.sh
docker/           Dockerfiles + nginx.conf; docker-compose.yml at the root (gateway, web, optional vLLM house)
docs/             ANALYSIS, SPEC, DEPLOY, SOLANA
```

Tooling: Node ≥ 22.13 (`node:sqlite`), pnpm 10, TypeScript 5.9 (strict, `exactOptionalPropertyTypes`),
vitest 5, Agave/Solana CLI 3.x (`solana`, `solana-test-validator`, `solana-keygen`, `spl-token` 5.x) for local
clusters and the e2e. On-chain code: **none** (SPL Token + Memo programs only). Node libraries:
`@solana/web3.js` 1.x, `@solana/spl-token` 0.4.x, `@solana/spl-memo`, `tweetnacl`, `bs58`; web:
`@solana/wallet-adapter-react`, `@solana/wallet-adapter-react-ui`, `@solana/wallet-adapter-base`
(wallet-standard discovery covers Phantom, Solflare, Backpack and others). ESM everywhere (`"type": "module"`),
`.js` import specifiers in TS sources.

## 3. On-chain layer (Solana, no custom program)

### 3.1 Token

An SPL mint under the Token program (Token-2022 supported through `tokenProgram` in the deployment record;
the indexer and the clients read it from `ConfigDto`). Mainnet: the pump.fun-launched `BEAGLE` (6 decimals,
mint authority revoked by the launchpad). Devnet / localnet: `solana/scripts/setup-cluster.sh <cluster>`
creates a 6-decimal mint with the deployer keypair as mint authority, mints `1_000_000_000` whole tokens to the
deployer, disables further minting (`spl-token authorize <mint> mint --disable`) and writes
`solana/deployments/<cluster>.json`:

```json
{ "cluster": "localnet", "mint": "<base58>", "decimals": 6, "symbol": "BEAGLE", "tokenProgram": "<base58>",
  "operator": "<base58>", "memoProgram": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "createdSlot": 123 }
```

`scripts/sync-deployments.mjs` collects these files into `packages/shared/src/deployments.generated.ts`
(`--check` mode for CI). Unknown keys are ignored.

### 3.2 Credit purchase = burn

A purchase is any **successful** transaction that contains an SPL `Burn` or `BurnChecked` instruction on the
mint (top-level or inner), executed by a token account **owner** (authority = owner; a delegate burn by the
operator is a draw, §3.4; a delegate burn by anyone else still credits the token account owner).

- Workspace credited = the token account owner, unless the transaction carries an SPL Memo instruction
  `beagle:v1 ws=<base58>` (then that key). One memo per transaction is honoured (the first `beagle:` memo);
  malformed memos are ignored (credit goes to the owner).
- Credit = `quoteUsdMicro(amount, priceE18)` with the gateway's **current price point at observation**
  (§3.3); the event stores `price_point_id` and `price_e18`. Multiple burns in one transaction are separate
  events (`<signature>:<ixIndex>`).
- A burn is final: the token supply decreases and nothing is refundable. Clients show the current price and
  the sentence "credit is computed from the published price when the gateway observes the burn".
- Minimum: burns quoting below `MIN_CREDIT_USD` (default $0.001) are recorded with `usd_micro = 0` and no
  ledger credit (dust guard); the UI enforces a minimum amount.

Purchases MUST be discoverable by `getSignaturesForAddress(mint)`: the mint is a writable account of every
`Burn`, so every burn transaction mentions it. The gateway never relies on clients notifying it.

### 3.3 Price (off-chain, published)

The token price is **not** on-chain (as in the original: "rates follow the $DARWIN price"). The gateway's
`PriceService` keeps a price history (`price_points`) and exposes it publicly:

- Sources (`PRICE_SOURCE`): `manual` (admin API / CLI set the price; `INITIAL_PRICE_USD` bootstraps it),
  `feed` (HTTP JSON `{ "priceUsd": number }` at `PRICE_FEED_URL`), `jupiter` (Jupiter Price API
  `GET {JUPITER_PRICE_URL}?ids=<mint>` → `data[mint].usdPrice`, mainnet only). Refresh every `PRICE_REFRESH_MS`.
- A new point is appended only when the price changes by ≥ `PRICE_MIN_CHANGE_BPS` (default 50) **or** the
  last point is older than `PRICE_MAX_AGE_S / 2` (keep-alive); a jump above `PRICE_MAX_STEP_BPS` (default
  2500) relative to the last point is rejected and logged (`price_rejected`), the previous point stays.
- Staleness: `stale = now − lastPoint.observedAt > PRICE_MAX_AGE_S` (default 3600). Burns observed while
  stale are still credited at the last point when `CREDIT_WHEN_STALE=true` (default) and flagged
  (`credit_events.price_stale = 1`); the web disables the burn button and the MCP tool warns while stale.
- `GET /api/price` → current point + `stale`; `GET /api/price/history?limit` → points; every credit event and
  `/api/receipts` row shows the point used. Anyone can recompute credits from the burn amount and the history.

### 3.4 Budgets = SPL delegation

"Authorize a budget from the wallet": the agent runs `ApproveChecked(tokenAccount, delegate = operator,
amount = cap)` on its token account of the mint (SPL semantics: one delegate per account; a new approve
replaces the previous cap; `Revoke` clears it; every delegate burn decrements `delegatedAmount`).

- Budget id = the token account address (the owner's ATA in the normal case). `owner` = account owner,
  `workspace` = owner (a registration may name another workspace to fund, §5.9).
- Headroom (tokens) = `min(delegatedAmount, amount)` while `delegate == operator`; in µUSD at the current
  price. No deadline on-chain: the budget lives until revoked or exhausted (the UI shows "until revoked").
- Draw = operator transaction `[ComputeBudget(priority fee, optional), BurnChecked(tokenAccount, mint,
  authority = operator, amount, decimals), Memo("beagle:draw v1 ws=<workspace> h=<receiptHash>")]`. The
  indexer confirms the draw by the memo hash (§5.4). The operator cannot move tokens anywhere else: `Burn` is
  the only instruction it signs, bounded by `delegatedAmount`.
- Who funds whom: a delegation funds its token account owner's workspace by default; the owner (a key or session of
  the owner's workspace) may register it for another workspace. Clients therefore refuse to open a cross-workspace
  budget unless the signer is the owner and the registering key belongs to the owner (MCP: explicit `fundOtherWorkspace`).
- Discovery: (a) `POST /api/budgets/register { tokenAccount }` right after approving (web and MCP do this),
  (b) a periodic scan `getProgramAccounts(tokenProgram, { filters: [{ dataSize: 165 }, { memcmp: { offset: 0,
  bytes: mint } }, { memcmp: { offset: 76, bytes: operator } }] })` every `BUDGET_SCAN_INTERVAL_MS` (classic
  Token program accounts are 165 bytes: mint 0–32, owner 32–64, amount 64–72, delegate option 72–76 +
  pubkey 76–108, …, delegatedAmount 121–129). Token-2022 accounts vary in size: for them only (a) and
  per-workspace `getTokenAccountsByOwner` refreshes apply.
- Close = `Revoke` by the owner (or approve 0); the scanner marks the budget `closed` (`stalledReason: 'revoked'`).

### 3.5 Trust summary

No program to audit. The user's only on-chain actions are `Burn` (final) and `Approve`/`Revoke` (bounded,
revocable). The operator's only action is a delegate `Burn` up to the cap. The price is off-chain but
published point by point and pinned on every credit event; the ledger is a cache of chain events plus
debits and can be rebuilt by replaying the mint's signatures.

## 4. Shared package (`packages/shared`, `@beagle/shared`)

Pure, browser-safe TypeScript (no `node:` imports; runtime dependencies: zod, `bs58`, `@noble/hashes` for sha256 — no
`@solana/web3.js` here so the web bundle stays small).
Subpath exports: `.`, `./clusters`, `./addresses`, `./memo`, `./siws`, `./solana`, `./credit`, `./models`, `./routing`,
`./difficulty`, `./canonical`, `./api`, `./openai`. 100 % of the public functions have vitest coverage.

### 4.1 `clusters.ts`, `addresses.ts`, `memo.ts`, `siws.ts`, `solana.ts`

`clusters.ts`: `Cluster = 'mainnet-beta' | 'devnet' | 'localnet'`, `CLUSTERS` (`rpcUrl`, `wsUrl`, `explorer`:
`https://explorer.solana.com` with `?cluster=devnet` / `?cluster=custom&customUrl=<rpc>` for localnet, `solscan`
`https://solscan.io` with `?cluster=devnet`), `isCluster(s)`, `explorerTxUrl(cluster, signature)`,
`explorerAddressUrl(cluster, address)`, `explorerTokenUrl(cluster, mint)`, `clusterCaip(cluster)` →
`solana:mainnet | solana:devnet | solana:localnet` (SIWS `chainId`).

`addresses.ts`: `TOKEN_PROGRAM_ID`, `TOKEN_2022_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, `MEMO_PROGRAM_ID`
(base58 strings), `Deployment` (the §3.1 JSON shape), `DEPLOYMENTS` (from `deployments.generated.ts`),
`deploymentFor(cluster)`, `resolveDeployment(cluster, overrides?: { mint?, operator?, rpcUrl? })` (empty string
counts as unset; invalid base58 throws), `isUnsetAddress`.

`memo.ts`: `encodePurchaseMemo({ workspace })` → `beagle:v1 ws=<base58>`; `encodeDrawMemo({ workspace,
receiptHash })` → `beagle:draw v1 ws=<base58> h=0x<64 hex>`; `parseMemo(text)` →
`{ kind: 'purchase', workspace } | { kind: 'draw', workspace, receiptHash } | undefined` (strict grammar,
whitespace-tolerant, ≤ 256 bytes, unknown versions → undefined); `MEMO_MAX_BYTES`.

`siws.ts`: Sign-In-With-Solana message text (the wallet-standard `signIn` layout):
```
<domain> wants you to sign in with your Solana account:
<address>

<statement>

URI: <uri>
Version: 1
Chain ID: <solana:mainnet|solana:devnet|solana:localnet>
Nonce: <nonce>
Issued At: <ISO8601>
Expiration Time: <ISO8601>
```
`createSiwsMessage(fields)`, `parseSiwsMessage(text)` (returns fields or throws `SiwsParseError`),
`validateSiwsFields(fields, { domain, uri, chainId, now, nonceOk })` → list of problems (empty = ok). No
signature verification here (browser-safe); the gateway verifies with tweetnacl.

`solana.ts`: `Base58PubkeySchema` (zod; 32-byte decode check), `SignatureSchema`, `isBase58Pubkey`,
`TOKEN_ACCOUNT_SIZE = 165`, `TOKEN_ACCOUNT_DELEGATE_OFFSET = 76`, `TOKEN_ACCOUNT_MINT_OFFSET = 0`,
`BURN_INSTRUCTION_TYPES = ['burn', 'burnChecked']`, `DEFAULT_DECIMALS = 6`, `shortAddress(s)`.

### 4.2 Deployments

`deployments.generated.ts` (generated by `scripts/sync-deployments.mjs` from `solana/deployments/*.json`,
committed; header comment `// Generated by scripts/sync-deployments.mjs … — do not edit by hand.`):
`export const DEPLOYMENTS: Readonly<Record<Cluster, Deployment>>` (partial: only clusters with a file). The
localnet entry is the reference produced by `setup-cluster.sh` with the e2e deployer keypair
(`solana/keys/deployer.json`, committed — **test key only**, never fund it on mainnet) so the mint address is
deterministic across runs (`spl-token create-token` with a fixed mint keypair `solana/keys/mint-localnet.json`).

### 4.3 `credit.ts`

`MICRO_USD = 1_000_000n`, `PRICE_SCALE = 10n ** 18n`, `quoteUsdMicro(amount, priceE18, decimals = 18)`,
`tokensForUsdMicro(usdMicro, priceE18, decimals = 18)` (ceil), `costMicroUsd(usage, price)` (per-component
`ceilDiv`), `applyMarkupBps(cost, bps)`, `ceilDiv`, `formatUsdMicro(x, { maxFractionDigits = 4 })` →
`"$2.50"`, `parseUsdToMicro("2.5")`, `formatTokenAmount(raw, decimals, maxFractionDigits)`,
`parseTokenAmount(str, decimals)`. Fixture test against `fixtures/quote.json`.

### 4.4 `models.ts` — catalog

```ts
export type Provider = 'anthropic' | 'openai' | 'google' | 'house';
export type Tier = 'frontier' | 'efficient' | 'budget' | 'house';
export interface ModelPrice { inputPerM: number; outputPerM: number; cacheReadPerM?: number; cacheWritePerM?: number } // µUSD per 1M tokens
export interface ModelSpec {
  id: string; provider: Provider; upstreamId: string; displayName: string; tier: Tier;
  contextWindow: number; maxOutput: number; price: ModelPrice;
  capabilities: { tools: boolean; vision: boolean; json: boolean; reasoning: boolean };
  autoEligible: boolean;          // may the router pick it for aliases?
  requiresPlan?: 'pro';
  notes?: string;
}
```
Default catalog (prices are µUSD per 1M tokens; snapshot 2026-10, operator-overridable via `MODEL_CATALOG_FILE`):

| id | tier | upstream | ctx / maxOut | in / out (cache read) | caps | auto |
|---|---|---|---|---|---|---|
| `anthropic/claude-opus-5-5` | frontier | `claude-opus-5-5` | 1,000,000 / 128,000 | 4,000,000 / 20,000,000 (200,000; write 5,000,000) | tools, vision, json, reasoning | yes |
| `anthropic/claude-sonnet-5-5` | efficient | `claude-sonnet-5-5` | 1,000,000 / 128,000 | 2,000,000 / 10,000,000 (200,000; write 2,500,000) | all | yes |
| `anthropic/claude-haiku-5-5` | budget | `claude-haiku-5-5` | 1,000,000 / 128,000 | 100,000 / 500,000 (10,000; write 125,000) | all | yes |
| `anthropic/claude-fable-5-1` | frontier | `claude-fable-5-1` | 1,000,000 / 128,000 | 10,000,000 / 50,000,000 (250,000; write 12,500,000) | all | **no** (explicit only) |
| `openai/gpt-5.5` | frontier | `gpt-5.5` | 400,000 / 128,000 | 5,000,000 / 30,000,000 (500,000) | all | yes |
| `openai/gpt-5.4-mini` | efficient | `gpt-5.4-mini` | 400,000 / 128,000 | 750,000 / 4,500,000 (75,000) | all | yes |
| `openai/gpt-5.4-nano` | budget | `gpt-5.4-nano` | 400,000 / 128,000 | 200,000 / 1,200,000 (20,000) | tools, json, vision | yes |
| `google/gemini-3.1-pro` | frontier | `gemini-3.1-pro` | 1,000,000 / 65,536 | 2,000,000 / 12,000,000 (200,000) | all | yes |
| `google/gemini-3-flash` | efficient | `gemini-3-flash` | 1,000,000 / 65,536 | 500,000 / 3,000,000 (50,000) | all | yes |
| `google/gemini-3.1-flash-lite` | budget | `gemini-3.1-flash-lite` | 1,000,000 / 65,536 | 250,000 / 1,500,000 (25,000) | tools, json, vision | yes |
| `house/gpt-oss-20b` | house | `openai/gpt-oss-20b` | 131,072 / 32,768 | 50,000 / 200,000 | tools, json, reasoning | yes |
| `house/gpt-oss-120b` | house | `openai/gpt-oss-120b` | 131,072 / 32,768 | 100,000 / 500,000 | tools, json, reasoning | yes, `requiresPlan: 'pro'` |

Helpers: `DEFAULT_CATALOG`, `ALIASES = ['beagle/auto','beagle/best','beagle/cheap','beagle/house']`,
`isAlias(id)`, `resolveModel(id, catalog)` (catalog id, alias, or unique upstream id), `modelsByTier`,
`TIER_ORDER = ['frontier','efficient','budget','house']`, `cheaperTier(tier)`, `mergeCatalog(defaults, overrides)`
(override by id; `remove: true` deletes). The OpenAI/Google prices are third-party snapshots and MUST be marked
`notes: 'price snapshot 2026-10; verify'`.

### 4.5 `difficulty.ts`

`estimateDifficulty(req: DifficultyInput): number` in `[0, 1]`, deterministic:
```
base 0.25
+ min(0.30, totalInputChars / 40_000 · 0.30)
+ 0.15 if any code fence ``` or /\b(function|class|def |import |SELECT |#include)\b/ in user content
+ 0.15 if tools are present
+ 0.10 if system prompt > 2_000 chars
+ 0.10 if more than 8 messages
+ 0.10 if /\b(prove|analy[sz]e|architect|refactor|debug|optimi[sz]e|step[- ]by[- ]step|plan|design|audit)\b/i
+ 0.30 if reasoningEffort === 'high' | 'xhigh' | 'max';  − 0.20 if 'low' | 'minimal'
clamp to [0, 1]
```
Input: `{ messages: {role, textLength?, text?}[], systemLength, toolCount, reasoningEffort? }`. `x-beagle-difficulty: <0..1>`
header overrides the estimate (gateway). Reading: the code/keyword checks run on user content only; the size term counts
all messages (the system prompt has its own term); `#include` is matched at line start (`#include\b`); the result is
rounded to 4 decimals.

### 4.6 `routing.ts` — pure policy

```ts
export interface ProviderState { state: 'ok' | 'degraded' | 'down'; quotaRatio?: number }  // quotaRatio: remaining share of a known limit
export interface RoutingInput {
  requested: string; difficulty: number;
  needs: { tools: boolean; vision: boolean; json: boolean; contextTokens: number; maxOutputTokens: number };
  workspace: { availableMicroUsd: bigint; plan: 'free' | 'pro'; byok: Provider[] };
  providers: Record<Provider, ProviderState>;
  fallback: 'none' | 'cheaper' | 'any';
  catalog: ModelSpec[];
  preference?: Provider[];                      // default ['anthropic', 'openai', 'google', 'house']
  limits?: { lowCreditMicroUsd?: bigint; veryLowCreditMicroUsd?: bigint }; // defaults $1.00 / $0.10
}
export interface Candidate { model: ModelSpec; paidBy: 'credit' | 'byok' }
export interface RoutingDecision { kind: 'ok'; tier: Tier; candidates: Candidate[]; reasons: string[] }
                             | { kind: 'error'; code: 'unknown_model' | 'plan_required' | 'no_capable_model' | 'insufficient_credit'; message: string; reasons: string[] }
export function route(input: RoutingInput): RoutingDecision;
```
Algorithm (each step appends a reason string):
1. **Resolve.** Explicit id → `primary = resolveModel`; unknown → `unknown_model`; `requiresPlan` unmet → `plan_required`.
   Alias → target tier: `best → frontier`, `cheap → budget`, `house → house`, `auto → difficulty ≥ 0.66 ? frontier : ≥ 0.33 ? efficient : budget`.
2. **Capability filter** (applied to every candidate): drop models lacking a needed capability or whose
   `contextWindow < contextTokens + maxOutputTokens`. Drop `requiresPlan` models the plan does not meet.
3. **paidBy** = `'byok'` when `workspace.byok` contains the model's provider, else `'credit'`.
4. **Credit runway** (alias requests only; applies to credit-paid candidates): `available < veryLow` → tier
   becomes `house`; else `available < low` → one tier cheaper. Explicit requests keep their model.
5. **Provider state.** Drop credit-paid candidates of `down` providers (BYOK candidates are kept: a platform
   outage or spend limit does not affect the workspace's own key; they sort by their raw state). Order within a
   tier: byok first; then `ok` before `degraded`; then by `preference`; then cheaper `inputPerM + outputPerM`. A
   provider with `quotaRatio < 0.2` counts as `degraded` and, for `difficulty < 0.5`, its credit-paid candidates
   are placed after all cheaper-tier candidates ("limit running down") — an explicitly requested primary is never
   moved.
6. **Fallback expansion.** `none` → `[primary]` (alias: first candidate of the target tier only).
   `cheaper` → remaining models of the tier, then each cheaper tier in `TIER_ORDER`, ending with `house`.
   `any` → `cheaper` plus higher tiers appended after. Alias requests default to `cheaper`.
   Only `autoEligible` models are added by expansion (an explicit non-eligible primary stays first).
7. **Credit gate.** Remove credit-paid candidates when `available ≤ 0`. Empty list → `insufficient_credit`
   when credit was the reason (including capable credit-paid models that only the step-4 runway narrowing
   excluded), else `no_capable_model`.
Deterministic: same input → same output; no randomness, no clock.

### 4.7 `canonical.ts`

`canonicalJson(value)`: RFC 8785-style — object keys sorted (code point order), no whitespace, `bigint` →
decimal string, `undefined` members omitted, numbers must be finite integers (throw otherwise; monetary
values are bigint). `sha256Hex(string)` via `@noble/hashes` (`sha256` over UTF-8 bytes). `receiptHash(obj) = '0x' + sha256Hex(canonicalJson(obj))`.
Receipt objects: see §5.7 (`UsageReceipt`) and §5.4 (`DrawBatch`).

### 4.8 `api.ts`, `openai.ts` (zod v4)

`api.ts`: schemas + inferred types for every `/api/*` response in §5.9 (`BalanceDto`, `MeDto`, `ApiKeyDto`,
`UsageRowDto`, `UsageSummaryDto`, `LedgerRowDto`, `CreditEventDto`, `ProviderKeyDto`, `BudgetDto`,
`UpgradeDto`, `PriceDto`, `QuoteDto`, `StatusDto`, `ConfigDto`, `ModelDto`, `ErrorDto`). Monetary fields are
decimal strings in JSON (`"amountMicro": "2500000"`); zod transforms to bigint on parse.
`openai.ts`: `ChatCompletionRequestSchema` (loose: known fields typed, unknown passthrough), message content
parts (text, image_url), tools / tool_choice, `response_format`, `stream`, `stream_options`,
`reasoning_effort`; `ChatCompletion` and `ChatCompletionChunk` builders; OpenAI error envelope
`{ error: { message, type, code, param } }`.

## 5. Gateway (`gateway/`, `@beagle/gateway`)

Node 22 ESM, Hono 4 + `@hono/node-server`, `node:sqlite` (`DatabaseSync`, WAL, foreign keys on),
`@solana/web3.js` 1.x + `@solana/spl-token` (chain), `tweetnacl` + `bs58` (SIWS), `@anthropic-ai/sdk` (official; the
only Anthropic client), `@modelcontextprotocol/sdk` (HTTP transport), zod 4, no other heavy runtime deps. Structure:

```
src/main.ts            boot: config → db.migrate → services → indexer/poster/drawer/warm loops → http
src/cli.ts             migrate | create-key | credit | set-price | register-budget | status   (§5.12)
src/config.ts          zod-validated env (§5.1)
src/db/{sqlite,schema,repos}.ts
src/auth/{siws,session,apiKeys,crypto}.ts
src/chain/{rpc,indexer,budgets,drawer,price}.ts
src/providers/{types,anthropic,openaiCompat,registry}.ts
src/translate/{internal,fromOpenAI,toOpenAI,fromAnthropic,toAnthropic}.ts
src/router/{health,execute}.ts
src/metering/{estimate,ledger,reserve,settle,receipts}.ts
src/api/{server,inference,dashboard,admin,mcp,errors,ratelimit}.ts
src/upgrades/{plans,warm}.ts
src/log.ts
test/…                 vitest; in-memory SQLite; mock providers via injected fetch; no network
```

### 5.1 Configuration (env; `.env.example` at the repo root documents every key)

The gateway reads `process.env` only (no `.env` loader of its own): bare-metal runs pass the file with
`node --env-file=.env …` or export it in the shell, docker compose injects it through `env_file`, Vite reads
the `VITE_*` keys from the repo-root file itself.

| Group | Keys (default) |
|---|---|
| runtime | `NODE_ENV` (development; `production` → `SESSION_SECRET` required and CLI `credit` needs `--force`; set by the Docker image) |
| cluster | `CLUSTER` (localnet), `RPC_URL` (cluster default), `RPC_WS_URL` (optional), `MINT_ADDRESS` (override of the deployment mint), `TOKEN_PROGRAM` (override), `COMMITMENT` (confirmed \| finalized), `INDEX_FROM_SIGNATURE` (optional start cursor: index only burns after it; default = everything the RPC returns, newest 1000 signatures per page), `INDEX_PAGE_LIMIT` (1000), `POLL_INTERVAL_MS` (2000), `TX_FETCH_CONCURRENCY` (4) |
| operator | `OPERATOR_SECRET_KEY` (base58 or JSON byte array; empty → draws disabled), `DRY_RUN` (true), `PRIORITY_FEE_MICROLAMPORTS` (0) |
| price | `PRICE_SOURCE` (manual \| feed \| jupiter), `INITIAL_PRICE_USD` (manual bootstrap, e.g. 0.01), `PRICE_FEED_URL`, `JUPITER_PRICE_URL` (https://lite-api.jup.ag/price/v3), `PRICE_REFRESH_MS` (60000), `PRICE_MIN_CHANGE_BPS` (50), `PRICE_MAX_STEP_BPS` (2500), `PRICE_MAX_AGE_S` (3600), `CREDIT_WHEN_STALE` (true), `MIN_CREDIT_USD` (0.001) |
| budgets | `BUDGET_SCAN_INTERVAL_MS` (30000), `BUDGET_HEADROOM_REFRESH_MS` (15000), `DRAW_THRESHOLD_USD` (1), `DRAW_INTERVAL_MS` (30000), `DRAW_CONFIRM_TIMEOUT_MS` (90000) |
| server | `PORT` (8787), `HOST` (0.0.0.0), `PUBLIC_URL` (http://localhost:8787; SIWS domain/uri), `PUBLIC_WEB_ORIGIN` (http://localhost:5173; CORS, comma list), `DB_PATH` (./data/gateway.sqlite), `MAX_BODY_BYTES` (2000000), `TRUST_PROXY` (false), `LOG_LEVEL` (info), `LOG_PROMPTS` (false) |
| secrets | `SESSION_SECRET` (required in prod; dev default with a warning), `KEYRING_MASTER_KEY` (32-byte hex; required when BYOK enabled), `ADMIN_TOKEN` (empty = admin routes disabled) |
| providers | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (https://api.openai.com/v1), `GOOGLE_API_KEY`, `GOOGLE_BASE_URL` (https://generativelanguage.googleapis.com/v1beta/openai), `HOUSE_BASE_URL` (empty = house disabled), `HOUSE_API_KEY`, `HOUSE_MODEL_SMALL` (openai/gpt-oss-20b), `HOUSE_MODEL_LARGE` (openai/gpt-oss-120b), `PROVIDER_TIMEOUT_MS` (120000; whole call for JSON, first byte + idle for streams), `MODEL_CATALOG_FILE` |
| economics | `MARKUP_BPS` (1000), `BYOK_FEE_BPS` (0), `LOW_CREDIT_USD` (1), `VERY_LOW_CREDIT_USD` (0.1), `MIN_RESERVE_USD` (0.01), `MAX_RESERVE_USD` (5), `RESERVATION_TTL_MS` (600000), `PRO_PRICE_USD` (20), `PRO_DAYS` (30), `WARM_HOUR_PRICE_USD` (2), `RATE_LIMIT_RPM` (60), `RATE_LIMIT_RPM_PRO` (300), `WARM_DRIVER` (log \| ollama \| http), `WARM_WEBHOOK_URL`, `WARM_PING_INTERVAL_MS` (240000) |

Platform keys absent → that provider is `down` for credit-paid routing (BYOK still works). `HOUSE_BASE_URL`
empty → house tier absent (router may return `no_capable_model`).

### 5.2 Database (SQLite, migrations in `schema.ts`, versioned `PRAGMA user_version`)

```
workspaces(owner TEXT PK /* base58 */, created_at INTEGER, plan TEXT NOT NULL DEFAULT 'free', plan_until INTEGER, display_name TEXT)
api_keys(id TEXT PK, workspace TEXT REFERENCES workspaces, name TEXT, prefix TEXT, hash TEXT UNIQUE, created_at, revoked_at, last_used_at)
sessions(id TEXT PK, workspace TEXT, created_at, expires_at)
siws_nonces(nonce TEXT PK, created_at, expires_at)
ledger(id INTEGER PK AUTOINCREMENT, workspace TEXT, kind TEXT CHECK(kind IN ('credit','debit','adjustment','upgrade')),
       amount_micro INTEGER NOT NULL, ref_type TEXT, ref_id TEXT, memo TEXT, created_at)      -- balance = SUM(amount_micro); UNIQUE(ref_type, ref_id) partial index
credit_events(signature TEXT, ix_index INTEGER, kind TEXT CHECK(kind IN ('purchase','draw')), workspace TEXT, payer TEXT /* token account owner */,
       token_account TEXT, authority TEXT, token_amount TEXT, usd_micro INTEGER, price_e18 TEXT, price_point_id INTEGER, price_stale INTEGER DEFAULT 0,
       memo TEXT, receipt_hash TEXT, slot INTEGER, block_time INTEGER, created_at, PRIMARY KEY (signature, ix_index))
price_points(id INTEGER PK AUTOINCREMENT, price_e18 TEXT NOT NULL, source TEXT, observed_at INTEGER, created_at)
reservations(id TEXT PK, workspace TEXT, amount_micro INTEGER, created_at, expires_at)
usage(id TEXT PK, workspace TEXT, api_key_id TEXT, endpoint TEXT, requested_model TEXT, served_model TEXT, provider TEXT, tier TEXT,
       paid_by TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
       upstream_cost_micro INTEGER, charged_micro INTEGER, price_json TEXT, markup_bps INTEGER, status TEXT, http_status INTEGER, error_code TEXT,
       latency_ms INTEGER, route_reasons TEXT, stream INTEGER, difficulty REAL, draw_id INTEGER, created_at)
provider_keys(id TEXT PK, workspace TEXT, provider TEXT, ciphertext BLOB, iv BLOB, tag BLOB, last4 TEXT, base_url TEXT, last_error TEXT, created_at, UNIQUE(workspace, provider))
budgets(token_account TEXT PK, owner TEXT, workspace TEXT, delegate TEXT, cap TEXT /* delegatedAmount */, balance TEXT /* account amount */,
       headroom_tokens TEXT, headroom_micro INTEGER, headroom_checked_at INTEGER, stalled_reason TEXT, closed INTEGER DEFAULT 0,
       registered_at INTEGER, last_seen_slot INTEGER, updated_at)
budget_draws(id INTEGER PK AUTOINCREMENT, token_account TEXT, workspace TEXT, token_amount TEXT, usd_micro INTEGER, receipt_hash TEXT UNIQUE,
       usage_ids TEXT, batch_json TEXT, signature TEXT, last_valid_block_height INTEGER, status TEXT CHECK(status IN ('pending','sent','confirmed','failed')),
       error TEXT, created_at, updated_at)
upgrades(id TEXT PK, workspace TEXT, kind TEXT CHECK(kind IN ('pro','warm')), quantity INTEGER, amount_micro INTEGER, starts_at, ends_at, created_at)
provider_health(provider TEXT PK, state TEXT, failures INTEGER, opened_at INTEGER, open_for_ms INTEGER, updated_at)
indexer_state(key TEXT PK, value TEXT)                       -- last_signature, last_slot, head_slot, last_event_at
settings(key TEXT PK, value TEXT)                            -- warm window, manual price, …
rate_limits(key_id TEXT PK, window_start INTEGER, count INTEGER)
```
Indices on `ledger(workspace)`, `usage(workspace, created_at)`, `credit_events(workspace)`, `credit_events(slot)`,
`reservations(workspace)`, `budgets(workspace)`, `budgets(owner)`. All repos use prepared statements; monetary
columns are 64-bit integers (µUSD) read as `bigint` (`setReadBigInts(true)`); token amounts are decimal strings.

**Balance definitions** (used by every route and by routing):
`balance = Σ ledger.amount_micro`; `reserved = Σ reservations.amount_micro (not expired)`;
`budgetHeadroom = Σ budgets.headroom_micro` over open, non-stalled budgets of the workspace (one SPL token
account has exactly one delegate and one delegated amount, so headroom is never double-counted; a workspace
funded by several token accounts simply sums them);
`available = balance − reserved + budgetHeadroom`.

### 5.3 Authentication

- **SIWS** (Sign-In-With-Solana): `GET /api/auth/nonce` → `{ nonce }` (stored, 10 min). The web builds the
  message with `createSiwsMessage` from `@beagle/shared/siws` using `domain = host(VITE_GATEWAY_URL || page
  origin)`, `uri = that origin + '/'`, `chainId = clusterCaip(VITE_CLUSTER)`, `expirationTime = issuedAt + 10 min`,
  and signs it with the wallet's `signMessage` (UTF-8 bytes; wallets that expose the wallet-standard `signIn`
  feature may be used too, the server accepts the same text). `POST /api/auth/verify { message, signature, publicKey }`
  (signature base58 or base64; publicKey base58): `parseSiwsMessage`, `validateSiwsFields` (domain == host(`PUBLIC_URL`),
  uri origin == `PUBLIC_URL` origin, chainId == `clusterCaip(CLUSTER)`, nonce known and unused, `issuedAt ≤ now + 5 min`,
  not expired), `address == publicKey`, then `nacl.sign.detached.verify(utf8(message), signature, pubkey)`.
  Creates the workspace if missing, creates a session, sets the cookie, returns `{ token, workspace }`.
  `POST /api/auth/logout`. `GET /api/me`.
- **API keys**: `POST /api/keys { name }` → `{ id, key, prefix, name, createdAt }` (full key returned once; ≤ 50
  active keys). `GET /api/keys` → masked list. `DELETE /api/keys/:id` → revoke. Inference and MCP accept
  `Authorization: Bearer bgl_…` or `x-api-key: bgl_…`. Keys are looked up by `sha256`; `last_used_at` updated
  at most once a minute. Revoked → 401 `invalid_api_key`.
- **Session vs key**: `/api/*` dashboard routes accept sessions; routes marked "key OK" (§5.9) also accept API keys.
- **BYOK encryption**: AES-256-GCM, key = `KEYRING_MASTER_KEY`, random 12-byte IV, AAD = `workspace|provider`.
  Decrypt only in the request path; never log. `last4` shown in UI.
- **Admin**: `x-admin-token` header equal to `ADMIN_TOKEN` (constant-time compare). Disabled when unset.

### 5.4 Chain workers (Solana)

All RPC access goes through a `ChainReader` / `ChainWriter` pair (`chain/rpc.ts`, `@solana/web3.js`
`Connection` with `commitment = COMMITMENT`; both injectable so tests use a fake). Transactions are legacy
`Transaction`s with a fresh blockhash, `feePayer = operator`, signed with the operator keypair; sending uses
`sendRawTransaction({ skipPreflight: false, maxRetries: 3 })` and `confirmTransaction({ signature, blockhash,
lastValidBlockHeight })`.

**Indexer** (`chain/indexer.ts`): every `POLL_INTERVAL_MS`: `getSignaturesForAddress(mint, { until:
last_signature, limit: INDEX_PAGE_LIMIT, commitment })`, paging backwards with `before` until the page is
exhausted or `until` is reached; the collected signatures are processed **oldest first** (skip entries with
`err`), `TX_FETCH_CONCURRENCY` at a time: `getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0,
encoding: 'jsonParsed' })`. For each parsed instruction (top-level and `meta.innerInstructions`) with
`program ∈ { 'spl-token', 'spl-token-2022' }` and `parsed.type ∈ { 'burn', 'burnChecked' }` and
`parsed.info.mint == mint`:
- `amount` = `info.amount` (burn) or `info.tokenAmount.amount` (burnChecked); `tokenAccount = info.account`;
  `authority = info.authority ?? info.multisigAuthority`; `owner` = the `meta.preTokenBalances` entry whose
  `accountIndex` resolves to `tokenAccount` (fallback `getAccountInfo` jsonParsed); `memo` = the first
  `spl-memo` instruction's parsed string in the transaction (if any).
- Classification: `parseMemo(memo)?.kind === 'draw'` **and** `authority == operator` → `kind='draw'`
  (match `budget_draws.receipt_hash`; unknown hash → recorded as a draw with no batch, logged `orphan_draw`);
  otherwise `kind='purchase'`, `workspace = parseMemo(memo)?.workspace ?? owner`.
- Pricing: `price = priceService.current()`; `usd_micro = quoteUsdMicro(amount, price.priceE18, decimals)`;
  `price_stale = price.stale`; below `MIN_CREDIT_USD` → `usd_micro = 0`.
- Apply in one transaction per signature, idempotent on `(signature, ix_index)`: insert `credit_events`,
  ensure the workspace, ledger credit (`ref_type='credit_event'`, `ref_id='<sig>:<ix>'`); draws also set
  `budget_draws.status='confirmed'`, `signature`, and `usage.claimDrawId` for the batch rows.
- Cursor: after a full page set is applied, `last_signature` = the newest processed signature, `last_slot`;
  `head_slot = getSlot()`; `lagSlots = head_slot − last_slot`. The first run with no cursor processes the
  newest `INDEX_PAGE_LIMIT` signatures only unless `INDEX_FROM_SIGNATURE` is set (then everything after it).
  Commitment `confirmed` may in rare cases drop a transaction later; an event whose signature is no longer
  found at `finalized` after 2 minutes is reverted (`credit_events` row deleted, ledger row deleted) — a
  finality sweep over the last 300 slots runs every minute.

**Budget scanner** (`chain/budgets.ts`): every `BUDGET_SCAN_INTERVAL_MS` the gPA scan of §3.4 (classic
Token program) upserts budgets for every token account of the mint delegated to the operator; every
`BUDGET_HEADROOM_REFRESH_MS` all open budgets are refreshed with `getMultipleAccountsInfo` (jsonParsed):
`delegate`, `delegatedAmount`, `amount`, `owner`; `headroom_tokens = delegate == operator ? min(delegatedAmount,
amount) : 0`; `headroom_micro = quoteUsdMicro(headroom_tokens, currentPrice)` (stale price → `headroom_micro = 0`,
`stalled_reason='price'`); `delegate != operator` → `closed = 1`, `stalled_reason = 'revoked'`;
`headroom_tokens == 0` with a delegate → `stalled_reason = 'exhausted'`. `POST /api/budgets/register` inserts
the row immediately (validating that the account belongs to the mint and is delegated to the operator).

**Budget drawer** (`chain/drawer.ts`, every `DRAW_INTERVAL_MS`, requires the operator key, skipped in `DRY_RUN`):
reconcile first (`pending` without signature older than 10 min → `failed`; `sent` → `getSignatureStatuses`:
confirmed/finalized → leave for the indexer, error → `failed`, unknown and `getBlockHeight() > last_valid_block_height`
→ `failed` (the transaction can no longer land — Solana's blockhash expiry makes this deterministic), else keep).
Then for each workspace with `balance − reserved < 0` and an open non-stalled budget: `deficit = −(balance − reserved)`;
if `deficit ≥ DRAW_THRESHOLD_USD`: pick the budget with the largest headroom; `usageIds` = unsettled usage rows
(`draw_id IS NULL`, `paid_by='credit'`, `charged_micro > 0`) oldest first, skipping rows that do not fit, until
their sum ≥ deficit (≤ 500 rows); `amountMicro = Σ charged_micro`; `tokens = tokensForUsdMicro(amountMicro,
priceE18, decimals)` capped at `headroom_tokens`; `batch: DrawBatch = { v: 1, cluster, mint, tokenAccount,
workspace, usageIds, amountMicro, priceE18, pricePointId }`; `receiptHash = receiptHash(batch)`; insert
`budget_draws(status='pending')`, mark rows; build and send the draw transaction of §3.4; on send →
`status='sent', signature, last_valid_block_height`. Confirmation and the ledger credit come **only** from
the indexer (memo hash match). A `failed` draw un-marks its usage rows (`usage.clearDrawId`) and sets
`stalled_reason='draw_failed'` on the budget until the next successful refresh.

**Price service** (`chain/price.ts`): §3.3. `current()` returns `{ id, priceE18, observedAt, stale, source }`
from an in-memory cache of the last `price_points` row; refresh loop per source; `set(priceE18, source='manual')`
for the admin API / CLI (bypasses the step bound, logged).

### 5.5 Providers and translation

Internal request/response (`translate/internal.ts`):
```ts
interface InternalMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: Part[]; name?: string; toolCallId?: string }
type Part = { type: 'text'; text: string } | { type: 'image'; url?: string; base64?: string; mediaType?: string }
          | { type: 'tool_call'; id: string; name: string; arguments: string /* JSON */ }
          | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };
interface InternalRequest { upstreamModel: string; messages: InternalMessage[]; tools?: ToolDef[]; toolChoice?: 'auto'|'none'|'required'|{ name: string };
  maxTokens: number; temperature?: number; topP?: number; stop?: string[]; responseFormat?: { type: 'json_object' } | { type: 'json_schema'; schema: unknown; name?: string };
  reasoningEffort?: 'low'|'medium'|'high'; stream: boolean; metadata: { requestId: string; workspace: string } }
interface Usage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
interface InternalResponse { id: string; model: string; message: InternalMessage; finishReason: 'stop'|'length'|'tool_calls'|'content_filter'; usage: Usage }
type InternalChunk = { type: 'text'; delta: string } | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta: string }
                   | { type: 'finish'; finishReason: InternalResponse['finishReason']; usage: Usage } | { type: 'error'; error: ProviderError };
interface ProviderAdapter { provider: Provider; complete(req, creds, signal): Promise<InternalResponse>; stream(req, creds, signal): AsyncIterable<InternalChunk> }
class ProviderError extends Error { status: number; code: string; retryable: boolean; provider: Provider }
```
`fromOpenAI` (OpenAI chat request → internal), `toOpenAI` (internal response/chunks → `chat.completion` /
`chat.completion.chunk`), `fromAnthropic` (`/v1/messages` body → internal), `toAnthropic` (internal → Anthropic
message / SSE events `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`). All four
have round-trip unit tests including tool calls and images.

**Anthropic adapter** — `new Anthropic({ apiKey, maxRetries: 0, timeout: PROVIDER_TIMEOUT_MS })` per credential
(cache clients by key hash). Non-stream: `client.messages.create({...})`; stream: `client.messages.stream({...})`
iterating events (`content_block_delta` → text / `input_json_delta`; `message_delta` → stop reason + output
usage; `message_start` → input usage incl. `cache_read_input_tokens`, `cache_creation_input_tokens`). Mapping:
system parts → top-level `system`; tool results → `tool_result` blocks in a user turn; `tools` → Anthropic tool
schema (`input_schema`); `toolChoice` `'required'`/`{name}` → `tool_choice: { type: 'auto' }` plus a system line
naming the tool (forced tool use is rejected by current models; do **not** send `any`/`tool`); `responseFormat
json_schema` → `output_config: { format: { type: 'json_schema', schema } }`, `json_object` → system instruction;
`reasoningEffort` → `output_config.effort` (`low|medium|high`); never send `thinking` (adaptive by default);
`max_tokens` = `min(req.maxTokens, model.maxOutput)`. Stop reasons: `end_turn`/`stop_sequence` → `stop`,
`max_tokens` → `length`, `tool_use` → `tool_calls`, `refusal` → `content_filter`. Error mapping (most specific
first): `Anthropic.RateLimitError` → 429 retryable; `Anthropic.AuthenticationError`/`PermissionDeniedError` →
401/403 non-retryable for BYOK, provider-`down` + retryable for platform keys; `BadRequestError` → 400
non-retryable (message passed through); `APIConnectionError` and status ≥ 500 (incl. 529 overloaded) → retryable.
Read `@anthropic-ai/sdk` types instead of redefining them.

**OpenAI-compatible adapter** (`openaiCompat.ts`, `fetch`-based) serves `openai`, `google`, `house`:
`POST {baseUrl}/chat/completions`, `Authorization: Bearer`, body built from the internal request
(`stream_options: { include_usage: true }` when streaming; `reasoning_effort` passed when the provider is
`openai`; `response_format` passed through). SSE parser handles `data:` lines, `[DONE]`, multi-line events and
partial frames. Usage from `usage` (OpenAI: `prompt_tokens_details.cached_tokens` → cacheRead). Errors: 429 →
retryable; 401/403 → as above; 400/404/422 → non-retryable; ≥ 500 / network / timeout → retryable. House models
use `HOUSE_API_KEY` (may be empty → no header).

**Registry** (`providers/registry.ts`): `resolveCredentials(provider, workspace)` → `{ kind: 'byok', key, baseUrl }`
| `{ kind: 'platform', key, baseUrl }` | `undefined`.

### 5.6 Router runtime (`router/`)

**Health** (`health.ts`, persisted in `provider_health`, cached in memory): per provider a sliding window of
failures (60 s). `≥ 3` retryable failures → `down` for `open_for_ms` (30 s, doubling to a 300 s max on
consecutive openings); after the window → `degraded` (half-open; the first request is a trial); a success → `ok`
and reset. Non-retryable errors (400) never affect health. **Client disconnects/aborts and any failure of a workspace's own
BYOK credentials never affect global health** (a BYOK user cannot take a provider down for credit-paid workspaces).
Providers without a platform key are `down` in `route()` for credit-paid candidates. BYOK 401 affects only that workspace (the key is
flagged `invalid` in `provider_keys` via `base_url`-independent column `last_error`, shown in the UI) — not global
health. Platform `401/403` → `down` immediately (misconfiguration).

**Execution** (`execute.ts`): given the parsed request and workspace:
1. Build `RoutingInput` (difficulty from `x-beagle-difficulty` or `estimateDifficulty`; `needs` from the body;
   `contextTokens ≈ ceil(chars/4)`; `fallback` from `x-beagle-fallback` (`none|cheaper|any`; default `cheaper`
   for aliases, `cheaper` for explicit too); byok list; health; `available`).
2. `route()`. Errors → HTTP: `unknown_model` 404 `model_not_found`, `plan_required` 403 `plan_required`,
   `no_capable_model` 503 `no_model_available`, `insufficient_credit` 402 `insufficient_credit`.
3. For each candidate in order: credentials (`undefined` → skip with reason); if `paidBy='credit'`:
   estimate (§5.7) and reserve; call adapter with a per-attempt `AbortSignal` (`PROVIDER_TIMEOUT_MS` = time to
   first byte, then an idle timeout reset on every streamed chunk; the whole non-stream call for JSON) — on `retryable`
   `ProviderError`: record health failure, release the reservation, continue; on non-retryable: release, map to the
   client error format and stop. Success → settle. All candidates failed → 502 `upstream_error` with the last
   error's message; a 429 from the last candidate maps to 429 `upstream_rate_limited` with `Retry-After` when known.
4. Streaming: the candidate may change only until the first chunk has been written to the client. After that an
   upstream error ends the stream with an error frame (`toOpenAI` error chunk or Anthropic `error` event) and the
   usage row records `status='error'` with the tokens already streamed charged.
5. The `model` field in responses is the **catalog id** of the served model; `id` is the request id.

### 5.7 Metering

- **Estimate**: `inputTokens = ceil(totalChars / 4) + 50·toolCount`; `outputTokens = min(req.maxTokens ?? 4096, model.maxOutput)`;
  `estimate = applyMarkupBps(costMicroUsd({inputTokens, outputTokens}, price), MARKUP_BPS)`;
  `reserve = clamp(estimate, MIN_RESERVE, MAX_RESERVE)`.
- **Gate**: credit-paid request requires `available ≥ MIN_RESERVE` else 402 (see error body below); then insert a
  reservation of `min(reserve, max(available, MIN_RESERVE))`. **Credit bound**: `max_tokens` is clamped so that
  `applyMarkupBps(cost(inputTokens, maxTokens), MARKUP_BPS) ≤ max(available, MAX_RESERVE)`; when the prompt alone
  exceeds the bound the request is a 402. BYOK-paid requests skip reserve/gate.
- **Settle**: an upstream answer whose usage is missing or all zero is billed by the estimate (`ceil(chars/4)`
  input, streamed/returned output tokens estimated the same way) and logged; `upstreamCost = costMicroUsd(usage, price)`; `charged = paidBy==='credit' ? applyMarkupBps(upstreamCost, MARKUP_BPS) : ceilDiv(upstreamCost · BYOK_FEE_BPS, 10_000)` (BYOK default 0 → free);
  ledger `debit −charged` (`ref_type='usage'`, `ref_id=requestId`) when `charged > 0`; delete the reservation; write
  the `usage` row (always, also on errors: `charged` = cost of tokens actually streamed, else 0; a client abort is
  recorded as `error_code='client_aborted'`, `http_status=499`, and is not an upstream failure). Expired
  reservations are purged every minute.
- **Negative balances** are allowed only through budget headroom; `available` already accounts for it.
- **402 body** (OpenAI envelope; `/v1/messages` uses the Anthropic envelope `{ type: 'error', error: { type, message } }`):
  `{ "error": { "message": "Insufficient credit: burn BEAGLE on the Credits page or open a budget.", "type": "insufficient_credit", "code": "insufficient_credit", "param": null } }`
  with headers `x-beagle-balance-micro`, `x-beagle-credits-url: <PUBLIC_WEB_ORIGIN>/app/credits`.
- **Receipt** (`GET /api/receipts/:requestId` → `{ receipt, hash }`): `UsageReceipt = { v: 1, requestId, workspace, createdAt, endpoint,
  requestedModel, servedModel, provider, paidBy, usage: {…}, price: {inputPerM,…}, upstreamCostMicro, markupBps,
  chargedMicro, routeReasons, price, markupBps }` and `hash = receiptHash(receipt)`. The receipt embeds the price table
  and markup used at the time, so the hash stays stable when the catalog changes. Anyone with the key or session of
  that workspace can recompute it from `@beagle/shared`. BYOK-paid requests are charged `ceilDiv(upstreamCost · BYOK_FEE_BPS, 10 000)`
  (0 by default): BYOK consumes no credit.
- **Rate limit**: fixed window per API key: `RATE_LIMIT_RPM` (`_PRO` on the pro plan); 429 `rate_limited` with `Retry-After`.

### 5.8 Inference API

Common response headers: `x-beagle-request-id`, `x-beagle-model` (catalog id), `x-beagle-provider`,
`x-beagle-paid-by`, `x-beagle-cost-micro`, `x-beagle-balance-micro` (after settle; streaming: trailer-less, so
sent as the final SSE comment line `: beagle cost=<micro> balance=<micro>` and included in the usage row),
`x-beagle-route` (reasons joined by `; `, ≤ 512 chars). Request headers: `x-beagle-difficulty`, `x-beagle-fallback`.

- `POST /v1/chat/completions` — OpenAI Chat Completions, JSON or SSE (`stream: true`). Supports `messages`
  (text and `image_url` parts), `tools`, `tool_choice`, `response_format`, `max_tokens` / `max_completion_tokens`,
  `temperature`, `top_p`, `stop`, `reasoning_effort`, `stream_options`, `user` (ignored), `n` (must be 1 → 400 otherwise).
  Unknown fields are ignored. Body limit `MAX_BODY_BYTES` → 413. Validation errors → 400 `invalid_request_error`.
- `GET /v1/models` — OpenAI list: catalog models the key may use plus the four aliases (`owned_by: 'beagle'`), with
  `beagle` extension fields (`tier`, `price`, `available`, `requiresPlan`).
- `GET /v1/models/:id`.
- `POST /v1/messages` — Anthropic Messages API subset: `model`, `system`, `messages` (text, image, tool_use,
  tool_result blocks), `tools`, `tool_choice` (`auto|none`, `any|tool` → 400 like upstream), `max_tokens`
  (required), `temperature`, `stop_sequences`, `stream`, `metadata`. Responses in Anthropic format; `usage` includes
  `cache_read_input_tokens`. Header `anthropic-version` accepted and ignored. Errors use the Anthropic envelope;
  status codes as above (402 `insufficient_credit` type is `invalid_request_error` with `message` starting
  `insufficient_credit:` to stay schema-compatible).
- Errors in the OpenAI envelope: `invalid_request_error` (400), `invalid_api_key` (401), `plan_required` (403),
  `insufficient_credit` (402), `model_not_found` (404), `rate_limited` (429), `upstream_rate_limited` (429),
  `upstream_error` (502), `no_model_available` (503).

### 5.9 Dashboard API (`/api`, JSON, session auth unless noted; CORS for `PUBLIC_WEB_ORIGIN`)

| Route | Notes |
|---|---|
| `GET /api/auth/nonce`, `POST /api/auth/verify`, `POST /api/auth/logout` | §5.3 |
| `GET /api/me` | `{ workspace, plan, planUntil, balanceMicro, reservedMicro, budgetHeadroomMicro, availableMicro, createdAt }` |
| `GET /api/balance` (key OK) | `{ balanceMicro, reservedMicro, budgetHeadroomMicro, availableMicro, plan, planUntil, price: PriceDto }` |
| `GET /api/keys`, `POST /api/keys`, `DELETE /api/keys/:id` | §5.3 |
| `GET /api/usage?limit=50&before=<createdAt>&model=&status=` (key OK) | newest first, cursor pagination |
| `GET /api/usage/summary?window=24h\|7d\|30d` (key OK) | `{ window, requests, chargedMicro, upstreamCostMicro, inputTokens, outputTokens, byModel: [{ model, requests, chargedMicro }], byDay: [{ day, requests, chargedMicro }] }` |
| `GET /api/ledger?limit&before` | ledger rows |
| `GET /api/receipts?limit&before` (key OK) | `credit_events` of the workspace: `CreditEventDto { signature, ixIndex, slot, blockTime, kind, workspace, payer, tokenAccount, tokenAmount, usdMicro, priceE18, pricePointId, priceStale, memo, receiptHash, explorerUrl }` |
| `GET /api/receipts/:requestId` (key OK) | `ReceiptDto = { receipt: UsageReceipt, hash }` (`hash = receiptHash(receipt)`) |
| `GET /api/providers`, `PUT /api/providers/:provider { apiKey, baseUrl? }`, `DELETE /api/providers/:provider`, `POST /api/providers/:provider/test` | BYOK; `provider ∈ anthropic\|openai\|google`; `baseUrl` must be `https:` and not resolve to a private/loopback range (SSRF guard; hostnames checked at save time and again at use time) ; test = minimal completion through the key |
| `GET /api/budgets`, `GET /api/budgets/:tokenAccount`, `GET /api/budgets/:tokenAccount/draws`, `POST /api/budgets/register { tokenAccount, workspace? }` (all key OK) | `BudgetDto { tokenAccount, owner, workspace, delegate, cap, balance, headroomTokens, headroomMicro, closed, stalledReason, registeredAt, lastSeenSlot, draws }`; register validates the account (mint, delegate = operator) and returns the dto (201) or 400 `not_delegated`; any principal may register a delegation (it then funds the account **owner's** workspace), but naming another `workspace` is allowed only when the principal is the owner, else 403 `not_owner` (a registered budget's workspace is never changed by a non-owner) |
| `GET /api/upgrades`, `GET /api/upgrades/prices`, `POST /api/upgrades { kind, quantity }` (key OK) | §5.11; 402 when `available` is short |
| `GET /api/models` (public) | `ModelDto[]` + aliases, availability per provider health and plan |
| `GET /api/price` (public), `GET /api/price/history?limit=100` (public) | `PriceDto { pricePointId, priceE18, observedAt, stale, source: 'manual'\|'feed'\|'jupiter', maxAgeS, usdPerToken, tokensPerUsd }`; history = `PriceDto[]` newest first |
| `GET /api/quote?tokens=<raw>` or `?usdMicro=<n>` (public) | `{ tokens, usdMicro, priceE18, pricePointId, stale }` from the current price point |
| `GET /api/status` (public) | `{ cluster, mint, token: { mint, symbol, decimals, tokenProgram }, indexer: { lastSignature, lastSlot, headSlot, lagSlots, lastEventAt }, price: PriceDto, providers: Record<Provider, { state, configured }>, house: { enabled, warmUntil, largeModel }, operator: { address, enabled, dryRun, solBalance? }, version }` |
| `GET /api/config` (public) | `ConfigDto { cluster, rpcUrl, mint, decimals, symbol, tokenProgram, memoProgram, operator, explorer, aliases, markupBps, byokFeeBps, minCreditMicro, pro: { priceMicro, days }, warmHourPriceMicro }` |
| `POST /api/admin/credit { workspace, amountMicro, memo }`, `POST /api/admin/price { priceE18 }` (manual price point), `GET /api/admin/workspaces` | `ADMIN_TOKEN` |
| `GET /healthz` | `{ ok: true }` |

All monetary values are decimal strings. List routes without pagination (`/api/keys`, `/api/providers`, `/api/budgets`,
`/api/budgets/:id/draws`, `/api/upgrades`) return a **bare JSON array**; paginated routes (`/api/usage`, `/api/ledger`,
`/api/receipts`) return `{ rows, nextBefore }`. Errors: `{ error: { code, message } }` with the status.

### 5.10 MCP over HTTP

`/mcp` mounts the `@beagle/mcp` server (§6) on the MCP **Streamable HTTP** transport (`@modelcontextprotocol/sdk`,
stateless mode: a new server + transport per request, `enableJsonResponse: true`, no session ids). Auth: API key
(header). The gateway passes an in-process `BeagleApi` implementation (§6.2) bound to the workspace of the key.
Tools that need a wallet (`beagle_buy_compute`, `beagle_open_budget`) return **unsigned transaction requests**
here (no agent key on the server).

### 5.11 Upgrades (`upgrades/`)

- Prices: `pro` = `PRO_PRICE_USD` per `PRO_DAYS`; `warm` = `WARM_HOUR_PRICE_USD` per hour (quantity = hours, 1–168).
- `POST /api/upgrades` charges `ledger(kind='upgrade')` (402 if `available < amount`), inserts `upgrades`,
  and: `pro` → `plan='pro'`, `plan_until = max(now, plan_until) + days`; `warm` → window `[max(now, currentWarmUntil), + hours]`,
  then `WarmDriver.ensureWarm(until)`.
- Plan effects: `requiresPlan: 'pro'` models unlock; `RATE_LIMIT_RPM_PRO`; house context limit for `free` is
  32,768 tokens (`contextTokens + maxOutputTokens` above → the router skips house for free plans, reason `house_context_pro`).
  Plan expiry is checked lazily on read (`plan_until < now` → `free`).
- `WarmDriver`: `log` (records only), `ollama` (every `WARM_PING_INTERVAL_MS` while warm: `POST {HOUSE_BASE_URL}/chat/completions`
  with `max_tokens: 1` and `keep_alive: '10m'` passthrough), `http` (`POST WARM_WEBHOOK_URL { until }`). Status in `/api/status.house.warmUntil`.

### 5.12 CLI (`gateway/src/cli.ts`, `pnpm --filter @beagle/gateway cli -- <cmd>`)

`migrate`, `create-key --workspace <base58> [--name]` (prints the key on stdout), `credit --workspace <base58>
--usd 10 [--memo]` (admin adjustment; refuses when `NODE_ENV=production` unless `--force`), `set-price --usd 0.01`
(manual price point), `register-budget --token-account <base58> [--workspace <base58>]`, `status`
(indexer cursor, head slot, price, operator balance in SOL).

### 5.13 Logging

JSON lines to stdout (`log.ts`): `level, time, msg, requestId?, workspace?`. Prompts/completions are never
logged unless `LOG_PROMPTS=true`. Provider keys, API keys, session ids never appear in logs (redaction test).

## 6. MCP package (`packages/mcp`, `@beagle/mcp`)

### 6.1 Transports

- `bin/beagle-mcp` (stdio): env `BEAGLE_API_URL` (default `http://localhost:8787`), `BEAGLE_API_KEY`
  (required), optional `BEAGLE_AGENT_SECRET_KEY` (base58 or JSON byte array of a Solana keypair) +
  `BEAGLE_RPC_URL` (defaults to the cluster RPC from `GET /api/config`), optional `BEAGLE_WORKSPACE`. With
  an agent key the wallet tools **execute** transactions (burn + memo, approve, revoke; wait for confirmation,
  then poll `/api/balance` / `/api/receipts` up to 60 s until the credit appears when `waitForCredit`); without
  it they return `{ unsigned: true, cluster, transactions: [{ base64, description }] }` — unsigned legacy
  transactions with `feePayer = workspace` and a fresh blockhash — so a wallet-capable agent can sign and send
  each one. The package is not published to npm: docs reference the local build
  (`node packages/mcp/dist/bin.js`) or the gateway's HTTP transport.
- Library: `createBeagleMcpServer(api: BeagleApi, opts: { wallet?: WalletExecutor; workspace?; waitForCredit?; … }) → McpServer`
  (used by the gateway with the HTTP transport).

`WalletExecutor` (`src/wallet.ts`): `address`, `buyCompute({ workspace, tokens }) → { signature, slot? }`
(`BurnChecked` from the agent's token account of the mint — the ATA, or the largest account when the ATA is
empty — plus `Memo(beagle:v1 ws=…)` when `workspace ≠ agent`), `openBudget({ cap }) → { signature, tokenAccount }`
(`ApproveChecked(ata, operator, cap)` then `POST /api/budgets/register`), `closeBudget({ tokenAccount }) → { signature }`
(`Revoke`); `createKeypairWalletExecutor({ secretKey, rpcUrl, deployment })`; `buildUnsignedTransactions(...)` for
the same three actions. Errors surface as `WalletError` codes (`insufficient_tokens`, `insufficient_sol`,
`blockhash_expired`, `tx_failed`, `chain_mismatch`, `chain_unavailable`, `ambiguous_token_account`), never the secret key.
A 32-byte base58 secret is refused (it is a public key or a bare seed; the 64-byte secret key is required).

### 6.2 `BeagleApi` interface and REST client

```ts
interface BeagleApi {
  balance(): Promise<BalanceDto>; models(): Promise<ModelDto[]>; quote(q: { tokens?: bigint; usdMicro?: bigint }): Promise<QuoteDto>;
  complete(req: ChatCompletionRequest): Promise<ChatCompletion>; usage(q: { limit?: number; window?: '24h'|'7d'|'30d' }): Promise<{ rows: UsageRowDto[]; summary: UsageSummaryDto }>;
  budgets(): Promise<BudgetDto[]>; upgrade(kind: 'pro'|'warm', quantity: number): Promise<UpgradeDto>; status(): Promise<StatusDto>; config(): Promise<ConfigDto>;
}
```
`createRestBeagleApi({ baseUrl, apiKey, fetch? })` implements it over the gateway routes. The gateway's in-process
implementation calls its services directly.

### 6.3 Tools (zod input schemas; concise descriptions written for an agent)

| Tool | Input | Output (JSON text + structured content) |
|---|---|---|
| `beagle_balance` | — | `BalanceDto` + human summary (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`) |
| `beagle_models` | `{ tier? }` | catalog with prices, availability, plan gating, aliases |
| `beagle_quote` | `{ usd? \| tokens? }` | `QuoteDto` |
| `beagle_complete` | `{ prompt? , messages?, system?, model? ('beagle/auto'), max_tokens?, difficulty? }` | `{ text, model, provider, paidBy, costMicro, balanceMicro, finishReason }` |
| `beagle_usage` | `{ limit?, window? }` | rows + summary |
| `beagle_buy_compute` | `{ usd? \| tokens?, workspace? }` | burn + memo; executed: `{ signature, creditedMicro, balanceMicro, pricePointId, priceStale }`; else unsigned transactions. The description says credit is computed from the published price when the burn is observed and warns when the price is stale |
| `beagle_open_budget` | `{ usd? \| tokens?, workspace?, fundOtherWorkspace? }` | `ApproveChecked` of the cap to the operator + register; refuses a cross-workspace budget (funded workspace ≠ signer) unless `fundOtherWorkspace: true`, and explains the owner-key registration rule (§3.4); executed: `{ signature, tokenAccount, cap, registered, fundsWorkspace }`; else unsigned transactions. Notes that a new approval replaces the previous cap |
| `beagle_close_budget` | `{ tokenAccount? }` | `Revoke`; executed: `{ signature }`; else unsigned |
| `beagle_budgets` | — | `BudgetDto[]` |
| `beagle_upgrade` | `{ kind: 'pro'\|'warm', quantity? }` | `UpgradeDto` |
| `beagle_status` | — | `StatusDto` |

Resources: `beagle://models` (markdown table), `beagle://quickstart` (the docs quick start). Errors are returned
as `isError: true` tool results with the gateway error code. Unit tests use an in-memory `BeagleApi` fake and the
SDK's in-memory transport pair.

## 7. Web app (`web/`, `@beagle/web`)

Vite 8, React 19, react-router 7 (data router), `@solana/wallet-adapter-react` + `-react-ui` (modal) with
wallet-standard auto-discovery (Phantom, Solflare, Backpack, …; no hard-coded adapters required),
`@solana/web3.js` + `@solana/spl-token` for transactions, TanStack Query 5, Tailwind 4. Dark theme,
monospace accents, English UI. No chart libraries (CSS bars). Vitest for `lib/` and hooks logic.

Env: `VITE_CLUSTER` (localnet), `VITE_RPC_URL` (override), `VITE_GATEWAY_URL` (dev proxy target for `/api`,
`/v1`, `/mcp` and the SIWS domain; prod: same origin when empty), `VITE_MINT_ADDRESS` (override). The mint,
decimals, symbol, token program and operator come from `GET /api/config` (reconciled with the committed
deployment: a disagreement disables burning and shows why).

Routes:
- `/` **Landing**: hero ("Compute for agents. Burn becomes compute."), three cards (one key for every model /
  router keeps your best model for hard work / paid by burning BEAGLE from your Solana wallet, no e-mail, no card),
  live strip from `/api/status` + `/api/price` (token price + source + freshness, indexer head slot and lag,
  provider health), code sample (curl), CTA → `/app`.
- `/models` **Models & pricing**: table from `/api/models` (tier, context, price in/out per 1M, availability, Pro).
- `/docs` **Docs**: quick start with the gateway base URL (curl, OpenAI SDK python/node `base_url`, Anthropic SDK
  `baseURL`, MCP config JSON for Claude Desktop / Claude Code with the local `beagle-mcp` build), headers
  reference, aliases, 402 semantics, "how credit is computed" (burn amount × published price at observation),
  budgets as SPL delegation, receipt verification snippet.
- `/app` **Overview** (signed in): balance card (available / reserved / budget headroom), plan, 24 h usage, latest
  requests, token price, "Buy credit" CTA.
- `/app/credits` **Credits**: amount input (USD or BEAGLE, toggles), live conversion at the published price
  (`/api/price`; refreshed every 15 s; disabled when `stale` with an explanation), wallet token balance
  (`getTokenAccountBalance` of the ATA; "no token account" state), **one wallet confirmation**: a transaction
  `[BurnChecked(ata, mint, owner, amount, decimals), Memo(beagle:v1 ws=<workspace>) when crediting another
  workspace]` sent with `sendTransaction` from the wallet adapter and confirmed with the blockhash/height
  pair; then poll `/api/receipts` until the purchase row with that signature appears (indexer lag notice,
  ~2–10 s), then `/api/balance`. The target workspace defaults to the signed-in workspace; "credit another
  workspace" validates base58. Shows the price point that will apply ("computed when observed") and the
  minimum amount (`MIN_CREDIT_USD`).
- `/app/keys`: create (shows the key once with copy), list, revoke.
- `/app/usage`: summary tiles (window selector), by-model bars, by-day bars, table with request id → `/app/receipts/:id`.
- `/app/receipts/:id`: `UsageReceipt` fields, canonical JSON, hash, "verify locally" snippet.
- `/app/providers`: BYOK add/replace/remove per provider, test button, encrypted-at-rest notice.
- `/app/upgrades`: Pro (price, days, current `planUntil`, buy), Warm hours (hours input, price, buy, current warm window).
- `/app/budgets`: open a budget (cap in USD/BEAGLE; `ApproveChecked(ata, operator, cap)` in one wallet
  confirmation, then `POST /api/budgets/register`), list with cap/balance/headroom/stalled reason, draws with
  explorer links, close (`Revoke`). Explains that a new approval replaces the previous cap and that the
  operator can only burn, never transfer.
- Global: wallet modal button, cluster badge (mismatch warning when the wallet is on another cluster is not
  detectable from the page — the page states the cluster it talks to), SIWS sign-in flow
  (`nonce → createSiwsMessage → signMessage → verify`), session restore via `GET /api/me`, toasts, error boundary, 404.

`web/src/lib/` holds pure helpers (formatting, transaction builders returning `TransactionInstruction[]`, SIWS
message building, step state machines, explorer links) with tests; hooks wrap wallet-adapter/query; components
are presentational.

## 8. Dev, e2e, CI, Docker

- Root scripts: `build`, `typecheck`, `test`, `lint`, `dev:gateway`, `dev:web`, `deployments:sync`,
  `cluster:setup` (`bash solana/scripts/setup-cluster.sh localnet`), `solana:e2e`.
- `scripts/mock-provider.mjs`: OpenAI-compatible server (`/v1/models`, `/v1/chat/completions` JSON + SSE) returning
  deterministic text (`echo:` + last user message, capped) with usage; env `MOCK_FAIL_RATE`, `MOCK_STATUS` for tests.
- `solana/scripts/setup-cluster.sh <cluster>`: for `localnet` uses the committed test keypairs
  (`solana/keys/deployer.json`, `solana/keys/mint-localnet.json`, `solana/keys/operator.json`), airdrops SOL,
  creates the mint (6 decimals, fixed mint keypair → deterministic address), mints 1e9 tokens to the deployer,
  disables minting, writes `solana/deployments/localnet.json`; for `devnet`/`mainnet-beta` takes
  `DEPLOYER_KEYPAIR`, `OPERATOR_PUBKEY`, optional `MINT_KEYPAIR`/`EXISTING_MINT` from env. Re-runs are idempotent:
  the mint of `MINT_KEYPAIR`, `EXISTING_MINT` or, with neither, the one the output file already records is reused
  (never replaced by a new throw-away mint); supply and the authority change are applied only when still needed;
  chain reads use `confirmed` like the writes.
- `scripts/solana-e2e.sh`: `solana-test-validator --reset --quiet --ledger <tmp>` (port 8899) → setup-cluster
  localnet → `sync-deployments` → build → mock provider on 9999 → gateway (`CLUSTER=localnet`,
  `OPERATOR_SECRET_KEY` = operator keypair, `DRY_RUN=false`, `PRICE_SOURCE=manual`, `INITIAL_PRICE_USD=0.01`,
  `MIN_CREDIT_USD=0.000001`, `DRAW_THRESHOLD_USD=0.000001`, `DRAW_INTERVAL_MS=2000`, `BUDGET_SCAN_INTERVAL_MS=2000`,
  `BUDGET_HEADROOM_REFRESH_MS=2000`, temp DB) → two agent keypairs (generated into the temp dir), airdrop, ATAs
  funded with 100 000 BEAGLE each (`spl-token transfer --fund-recipient --allow-unfunded-recipient`) → `create-key`
  for both → agent 1 burns 1000 BEAGLE (`node scripts/e2e/burn.mjs` using `@solana/spl-token` `createBurnCheckedInstruction`
  + memo; or `spl-token burn` when it supports a memo) → wait for `/api/balance ≥ 9_990_000` and assert exactly
  `10_000_000` → `POST /v1/chat/completions {model:'beagle/auto'}` → 200, `x-beagle-model == house/gpt-oss-20b`,
  cost > 0, balance decreased, `/api/usage` row, `/api/receipts/:id` hash recomputes → streaming request asserts
  SSE frames and `[DONE]` → `/v1/messages` Anthropic shape → agent 2 (no credit) gets 402 → agent 2 approves the
  operator for 500 BEAGLE (`spl-token approve <ata> 500 <operator>`) and registers (`POST /api/budgets/register`)
  → headroom appears → agent 2 request succeeds (balance negative) → drawer burns as delegate → indexer confirms
  → `/api/balance ≥ 0`, `/api/budgets` shows the draw confirmed with a recomputable receipt hash and
  `cap` decreased by the drawn amount → agent 2 revokes → budget `closed` → MCP HTTP `initialize`, `tools/list`,
  `beagle_balance` → MCP stdio binary (`scripts/e2e/mcp-call.mjs` drives `packages/mcp/dist/bin.js` as an MCP
  client with `BEAGLE_AGENT_SECRET_KEY` = agent 1's keypair, i.e. the real Keypair executor): `beagle_buy_compute`
  100 BEAGLE with `workspace` = agent 2 under agent 2's key → memo `beagle:v1 ws=<agent 2>`, `credited`, agent 2's
  balance +1_000_000 µUSD, receipt and on-chain `burnChecked` + `spl-memo` asserted; `beagle_open_budget` 250 BEAGLE
  under agent 1's key → `ApproveChecked`, `registered`, headroom; `beagle_close_budget` → `Revoke`, budget `closed`
  → `/api/status.cluster == 'localnet'` → ALL GOOD. Timeouts fail loudly; cleanup via `trap` (validator killed,
  ledger dir removed). The committed `localnet.json`/generated file are never written: the fixed mint keypair keeps
  them valid, and a mismatch (keys changed without the record) fails the run — `E2E_UPDATE_DEPLOYMENT=1` rewrites
  both for committing.
- CI (`.github/workflows/ci.yml`): one job: install the Agave release tarball (cached), pnpm 10 from
  `packageManager`, Node 22, `pnpm install --frozen-lockfile`, `sync-deployments --check`, build, typecheck,
  test, web lint, `solana:e2e`.
- Docker: `docker/gateway.Dockerfile` (node:22-alpine, pnpm, workspace build, `NODE_ENV=production`,
  `node gateway/dist/main.js`), `docker/web.Dockerfile` (build → nginx; `docker/nginx.conf` proxies `/api`,
  `/v1`, `/mcp`, `/healthz` to `gateway:8787` with SSE-friendly `proxy_buffering off`), root `.dockerignore`,
  `docker-compose.yml`: `gateway` (`env_file: .env`), `web`, profile `gpu`: `house` (`vllm/vllm-openai`), profile
  `gpu-large`: `house-large`. `HOUSE_BASE_URL=http://house:8000/v1` in the compose env; the gateway has a single
  house endpoint, so serving both house models needs an OpenAI-compatible router in front (DEPLOY §3).

## 9. Security and trust model

- **Burn is final.** Credit is derived from the burn amount and the **published** price point in force when the
  gateway observed the burn; both are recorded on the credit event and can be recomputed by anyone from the mint's
  transaction history plus `/api/price/history`. The gateway's ledger is a cache of chain events plus debits.
- **No custom program.** Users only sign SPL `Burn` (final), `Approve` and `Revoke` (bounded, revocable). The
  operator keypair only signs delegate `Burn`s up to each delegated amount; it cannot transfer user tokens.
  Keep it funded with a little SOL for fees; rotate by changing `operator` in the deployment and asking agents to
  re-approve.
- **Price risk.** The price is set off-chain (manual / feed / Jupiter) with a step bound and a staleness flag;
  changes are published before they apply (new point appended, visible in `/api/price/history`). A malicious or
  broken feed can only over- or under-credit future burns within `PRICE_MAX_STEP_BPS` per refresh; the operator
  should alert on `price_rejected` logs.
- **Keys**: API keys hashed; BYOK encrypted (AES-256-GCM) with a server master key; sessions random; SIWS nonces
  single-use with expiry; CORS restricted to `PUBLIC_WEB_ORIGIN`; `baseUrl` SSRF guard (no redirects); body size
  limits; per-key rate limits.
- **Prompts** are not persisted (only token counts and costs) unless `LOG_PROMPTS=true`.
- **Fallback never silently upgrades price class** beyond the request: `cheaper` is the default; `any` is opt-in.
- **Known gaps**: provider price snapshots must be maintained by the operator; the house model is only as
  available as the GPU behind `HOUSE_BASE_URL`; `confirmed` commitment can in rare cases be rolled back
  (finality sweep reverts such credits); budgets are approvals, not escrow — the owner can revoke before a draw,
  so the gateway settles often (`DRAW_THRESHOLD_USD`) and caps the post-paid gap by the reserve rules.

## 10. Addresses

Program ids are in `@beagle/shared/addresses` (§1). Deployed mints and the operator key per cluster live in
`solana/deployments/<cluster>.json` and `packages/shared/src/deployments.generated.ts`; `docs/SOLANA.md` lists
RPC endpoints, explorers, faucets and the pump.fun launch notes for mainnet.
