# Beagle — compute for agents on Robinhood Chain · burn becomes compute

Normative specification. Implementation agents build from this document; where the document is silent,
prefer the simplest behaviour that keeps the stated invariants. `docs/ANALYSIS.md` explains the original
project (Darwin, @darwincompute) that this one replicates on Robinhood Chain.

Conventions: MUST / SHOULD / MAY as in RFC 2119. "Gateway" is the Node service in `gateway/`; "desk" is the
`CreditDesk` contract; "workspace" is the billing account of one wallet address.

## 0. Product summary

- **One API key for every model.** A workspace gets `bgl_…` API keys. The gateway exposes an
  OpenAI-compatible `/v1/chat/completions` (+ `/v1/models`) and an Anthropic-compatible `/v1/messages`,
  routing to Anthropic (official SDK), OpenAI, Google Gemini (OpenAI-compatible endpoint) and the
  project's own **house** model served by vLLM (`gpt-oss-20b`, Pro: `gpt-oss-120b`).
- **Burn becomes compute.** Access is paid by burning the project token (`BEAGLE`) through the
  `CreditDesk` contract on Robinhood Chain. The contract quotes the burn in USD from an on-chain price
  source and emits the USD amount; the gateway indexes the event and credits the workspace **exactly** the
  emitted amount. No e-mail, no card: sign-in is Sign-In-With-Ethereum (SIWE), workspace = wallet.
- **Model router.** `beagle/auto` keeps the best model for hard requests, moves easy requests to cheaper
  models, downgrades as credit or provider limits run down, and falls back to the house model when
  everything else is unavailable. Explicit model ids are honoured with configurable fallback.
- **BYOK.** A workspace may store its own provider keys (encrypted at rest). Requests served through
  them consume no credit.
- **Agents.** An MCP server (stdio binary and `/mcp` HTTP transport) gives agents balance, models,
  quotes, inference, usage, compute purchase and **budgets**: an agent approves tokens and opens an
  on-chain budget; the operator draws from it as usage accrues, never above the cap.
- **Upgrades.** `pro` (30 days: large house model, 128K house context, higher rate limit) and `warm`
  hours (keep the house GPU warm) are bought with credit.

## 1. Units, identifiers, constants

| Term | Definition |
|---|---|
| µUSD | integer micro-dollars; `1 USD = 1_000_000 µUSD`. Solidity `uint256`, TS `bigint`, SQLite `INTEGER`. |
| `priceE18` | USD per **one whole token**, scaled by `1e18`. `$0.0025` → `2_500_000_000_000_000`. |
| token amount | raw token units (`decimals` of the token; `BeagleToken` has 18). Stored off-chain as decimal strings. |
| quote | `usdMicro = floor(amount · priceE18 / 10^(decimals + 12))`. For 18 decimals: `amount · priceE18 / 1e30`. Example: `1000e18 · 2.5e15 / 1e30 = 2_500_000 µUSD = $2.50`. |
| inverse quote | `tokens = ceil(usdMicro · 10^(decimals+12) / priceE18)`. |
| workspace id | the owner wallet address. On-chain `address`; off-chain lowercase `0x…` hex (40 nibbles). UI shows EIP-55. |
| request id | `req_` + UUIDv4. |
| API key | `bgl_` + 43 chars base64url of 32 random bytes. Stored as `sha256(key)` hex; `prefix` = first 12 characters (`bgl_xxxxxxxx`) for display. |
| session | random 32-byte id, 7 days. Cookie `beagle_session` (HttpOnly, SameSite=Lax, Secure when `PUBLIC_URL` is https) or `Authorization: Bearer <session>`. |
| model id | catalog id `provider/model` (e.g. `anthropic/claude-opus-5-5`). Aliases `beagle/auto`, `beagle/best`, `beagle/cheap`, `beagle/house`. Bare upstream ids (e.g. `claude-opus-5-5`) resolve when unique. |
| DEAD | `0x000000000000000000000000000000000000dEaD` |
| chain ids | Robinhood Chain `4663`, testnet `46630`, anvil `31337` (`docs/ROBINHOOD_CHAIN.md`). |

Money math is integer-only everywhere. Per-component model cost = `ceilDiv(tokens · pricePerMillion, 1_000_000)`;
markup = `cost + ceilDiv(cost · bps, 10_000)`.

## 2. Repository layout

```
contracts/        Foundry: BeagleToken, CreditDesk, CreditMath, IPriceSource, ManualPriceSource,
                  ChainlinkPriceSource, mocks, tests, script/Deploy.s.sol, PostPrice.s.sol, GenerateFixtures.s.sol
packages/shared/  @beagle/shared: chains, addresses (+ deployments.generated.ts), abi (generated), credit math,
                  model catalog, routing policy, difficulty heuristic, canonical JSON + receipt hash, API/OpenAI DTOs (zod)
packages/mcp/     @beagle/mcp: MCP tools (library), REST client, stdio binary `beagle-mcp`
gateway/          @beagle/gateway: Hono API, SQLite (node:sqlite), indexer, router, metering, providers, MCP HTTP, CLI
web/              @beagle/web: Vite + React 19 + wagmi 3 + viem + TanStack Query + react-router 7 + Tailwind 4
scripts/          sync-abi.mjs, sync-deployments.mjs, mock-provider.mjs, anvil-e2e.sh
docker/           Dockerfiles + nginx.conf; docker-compose.yml at the root (gateway, web, optional vLLM house)
docs/             ANALYSIS, SPEC, DEPLOY, ROBINHOOD_CHAIN
```

Tooling: Node ≥ 22.13 (`node:sqlite`), pnpm 10, TypeScript 5.9 (strict, `exactOptionalPropertyTypes`),
vitest 5, Foundry stable (solc 0.8.28), OpenZeppelin Contracts v5.x and forge-std as git submodules in
`contracts/lib/`. ESM everywhere (`"type": "module"`), `.js` import specifiers in TS sources.

## 3. Contracts (`contracts/`)

All contracts `pragma solidity 0.8.28;`, MIT. Use OpenZeppelin: `ERC20`, `ERC20Burnable`, `ERC20Permit`,
`Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, `Math.mulDiv`. Custom errors, no revert strings.
`forge fmt` clean. Natspec on every external function.

### 3.1 `CreditMath` (library)

```solidity
library CreditMath {
    /// usdMicro = floor(amount * priceE18 / 10**(decimals + 12))
    function usdMicro(uint256 amount, uint256 priceE18, uint8 decimals) internal pure returns (uint256);
    /// tokens = ceil(usdMicro * 10**(decimals + 12) / priceE18); reverts on priceE18 == 0
    function tokensForUsdMicro(uint256 usdMicro, uint256 priceE18, uint8 decimals) internal pure returns (uint256);
}
```
Uses `Math.mulDiv` (no intermediate overflow). `decimals` MUST be ≤ 36 (checked by callers at construction).

### 3.2 `BeagleToken`

`contract BeagleToken is ERC20, ERC20Burnable, ERC20Permit`. Name `Beagle`, symbol `BEAGLE`, 18 decimals,
`TOTAL_SUPPLY = 1_000_000_000e18` minted to `recipient` in the constructor. No owner, no mint afterwards.
Used on anvil/testnet; on mainnet the token is whatever ERC-20 the project launched (e.g. on Pons).

### 3.3 Price sources

```solidity
interface IPriceSource {
    /// @return priceE18 USD per 1 whole token (18 decimals); 0 = unavailable
    /// @return updatedAt unix time of the observation
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt);
}
```

**`ManualPriceSource is Ownable2Step, IPriceSource`** — operator-posted price with guard rails.

- Storage: `address poster; uint256 priceE18; uint256 updatedAt; uint16 maxStepBps (default 2500); uint32 minInterval (default 60)`.
- `post(uint256 newPriceE18)` — `onlyPoster`. Requires `newPriceE18 > 0`. If a price is already set:
  `|new − old| · 10_000 ≤ old · maxStepBps` else `PriceStepTooLarge(old, new)`, and
  `block.timestamp ≥ updatedAt + minInterval` else `PostTooSoon(nextAllowedAt)`. Sets price and
  `updatedAt = block.timestamp`. Emits `PricePosted(uint256 priceE18, uint256 updatedAt, address poster)`.
- `forcePrice(uint256 priceE18)` — `onlyOwner`, bypasses bounds (bootstrap / emergency). Emits `PriceForced(priceE18, updatedAt)`.
- `setPoster(address)`, `setBounds(uint16 maxStepBps, uint32 minInterval)` — `onlyOwner`; `0 < maxStepBps ≤ 10_000`.
  Events `PosterSet(address)`, `BoundsSet(uint16, uint32)`.
- `latestPrice()` returns the stored pair (zeros before the first post).
- Errors: `NotPoster()`, `ZeroPrice()`, `PriceStepTooLarge(uint256 oldPrice, uint256 newPrice)`, `PostTooSoon(uint256 nextAllowedAt)`, `BadBounds()`.

**`ChainlinkPriceSource is IPriceSource`** — adapter for an `AggregatorV3Interface` feed quoting the token in
USD. Immutable `feed`, `feedDecimals`. `latestPrice()` reads `latestRoundData()`; if `answer ≤ 0` returns
`(0, updatedAt)`; otherwise rescales `answer` to 18 decimals. Define the minimal `AggregatorV3Interface`
locally (`decimals()`, `latestRoundData()`).

### 3.4 `CreditDesk`

`contract CreditDesk is Ownable2Step, Pausable, ReentrancyGuard`.

Immutables: `IERC20 public immutable token; uint8 public immutable tokenDecimals; bool public immutable nativeBurn;`
Constants: `address public constant DEAD = 0x000000000000000000000000000000000000dEaD; uint64 public constant MAX_BUDGET_DURATION = 30 days;`
Storage:
```solidity
IPriceSource public priceSource;
uint32  public maxPriceAge;      // seconds; default 3600
uint256 public minBurn;          // raw token units; default 0
address public operator;         // gateway hot wallet: draws budgets
uint256 public nextReceiptId;    // starts at 1
uint256 public nextBudgetId;     // starts at 1
uint256 public totalBurned;      // raw token units
uint256 public totalUsdMicro;    // credited µUSD
struct Budget { address owner; address workspace; uint128 cap; uint128 drawn; uint64 deadline; bool closed; }
mapping(uint256 => Budget) public budgets;
```
Constructor `(IERC20 token_, bool nativeBurn_, IPriceSource priceSource_, address owner_, address operator_)`:
reads `IERC20Metadata(token_).decimals()` (revert `BadDecimals()` if > 36), sets `maxPriceAge = 3600`,
`nextReceiptId = nextBudgetId = 1`, `Ownable(owner_)`. Zero `token_`/`owner_` → `ZeroAddress()`;
`priceSource_`/`operator_` may be zero (set later).

Pricing:
```solidity
function quote(uint256 amount) public view returns (uint256 usdMicro, uint256 priceE18, uint256 updatedAt);
```
`_price()` reads `priceSource.latestPrice()`; reverts `PriceUnavailable()` if `priceSource == 0` or `priceE18 == 0`;
reverts `PriceStale(updatedAt, maxPriceAge)` if `block.timestamp − updatedAt > maxPriceAge`.
`usdMicro = CreditMath.usdMicro(amount, priceE18, tokenDecimals)`.

Credit purchase:
```solidity
function burnForCredit(address workspace, uint256 amount) external whenNotPaused nonReentrant returns (uint256 receiptId);
function burnForCreditWithPermit(address workspace, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
    external whenNotPaused nonReentrant returns (uint256 receiptId);
```
- `workspace == 0` → `ZeroAddress()`. `amount == 0 || amount < minBurn` → `BurnTooSmall(amount, minBurn)`.
- `(usdMicro, priceE18, ) = quote(amount)`; `usdMicro == 0` → `QuoteTooSmall()`.
- `token.safeTransferFrom(msg.sender, address(this), amount)`; `_burn(amount)`.
- `receiptId = nextReceiptId++`; `totalBurned += amount; totalUsdMicro += usdMicro`.
- `emit CreditPurchased(receiptId, workspace, msg.sender, amount, usdMicro, priceE18)`.
- Permit variant first does `try IERC20Permit(address(token)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}`
  (front-running-safe), then the same path.

Budgets ("authorize a budget from the wallet"):
```solidity
function openBudget(address workspace, uint128 cap, uint64 deadline) external whenNotPaused returns (uint256 budgetId);
function draw(uint256 budgetId, uint256 amount, bytes32 receiptHash) external whenNotPaused nonReentrant returns (uint256 receiptId);
function closeBudget(uint256 budgetId) external;
function budgetRemaining(uint256 budgetId) external view returns (uint256); // 0 when closed/expired; min(cap-drawn, allowance, balance)
```
- `openBudget`: `workspace != 0`; `cap > 0`; `block.timestamp < deadline ≤ block.timestamp + MAX_BUDGET_DURATION` else `BadBudgetParams()`.
  Stores `{owner: msg.sender, workspace, cap, drawn: 0, deadline, closed: false}`. Emits
  `BudgetOpened(budgetId, msg.sender, workspace, cap, deadline)`. The owner separately `approve`s the desk.
- `draw`: `msg.sender == operator` else `NotOperator()`; budget exists (`owner != 0`) else `UnknownBudget()`;
  `!closed` else `BudgetIsClosed()`; `block.timestamp ≤ deadline` else `BudgetExpired()`; `amount > 0`;
  `drawn + amount ≤ cap` else `BudgetExceeded(cap − drawn)`. Quote, `safeTransferFrom(owner, this, amount)`,
  `_burn`, `drawn += amount`, receipt id, totals, `emit BudgetDrawn(budgetId, receiptId, workspace, amount, usdMicro, priceE18, receiptHash)`.
- `closeBudget`: allowed for the budget owner, the operator, or anyone after `deadline`; otherwise `NotBudgetOwner()`.
  Idempotent on an already closed budget is **not** allowed (`BudgetIsClosed()`). Works while paused. Emits `BudgetClosed(budgetId, drawn)`.

Burning: `_burn(amount)`: `nativeBurn ? ERC20Burnable(address(token)).burn(amount) : token.safeTransfer(DEAD, amount)`.

Admin (`onlyOwner`): `setPriceSource(IPriceSource)`, `setMaxPriceAge(uint32 > 0)`, `setMinBurn(uint256)`,
`setOperator(address)`, `pause()`, `unpause()`, `recoverToken(IERC20 t, address to, uint256 amount)` (any token,
including stray credit tokens; the desk never holds tokens between calls). Events: `PriceSourceSet(address)`,
`MaxPriceAgeSet(uint32)`, `MinBurnSet(uint256)`, `OperatorSet(address)`.

Events (exact signatures):
```solidity
event CreditPurchased(uint256 indexed receiptId, address indexed workspace, address indexed payer, uint256 tokenAmount, uint256 usdMicro, uint256 priceE18);
event BudgetOpened(uint256 indexed budgetId, address indexed owner, address indexed workspace, uint128 cap, uint64 deadline);
event BudgetDrawn(uint256 indexed budgetId, uint256 indexed receiptId, address indexed workspace, uint256 tokenAmount, uint256 usdMicro, uint256 priceE18, bytes32 receiptHash);
event BudgetClosed(uint256 indexed budgetId, uint128 drawn);
```
Errors: `ZeroAddress()`, `BadDecimals()`, `BurnTooSmall(uint256 amount, uint256 minBurn)`, `QuoteTooSmall()`,
`PriceUnavailable()`, `PriceStale(uint256 updatedAt, uint32 maxAge)`, `NotOperator()`, `BadBudgetParams()`,
`UnknownBudget()`, `BudgetIsClosed()`, `BudgetExpired()`, `BudgetExceeded(uint256 remaining)`, `NotBudgetOwner()`.

Invariants (write as Foundry invariant tests):
1. `totalBurned == Σ tokenAmount` over all `CreditPurchased` + `BudgetDrawn`; `totalUsdMicro == Σ usdMicro`.
2. `token.balanceOf(desk) == 0` after every call. Native mode: `totalSupply` decreased by `totalBurned`; dead mode: `balanceOf(DEAD) == totalBurned`.
3. For every budget `drawn ≤ cap`; a closed or expired budget never increases `drawn`.
4. Receipt ids are strictly increasing and unique across both purchase paths.

Tests also cover: staleness and unavailable price, pause semantics (burn/open/draw blocked, close allowed),
permit path (valid permit; replayed/invalid permit still succeeds when allowance pre-exists), dead-address
mode with a `MockERC20` lacking `burn`, operator/owner access control, fuzz of `CreditMath` (monotonic in
amount and price, no overflow for `amount ≤ 1e36`, `price ≤ 1e30`, `decimals ≤ 36`; `tokensForUsdMicro`
round-trips within one unit), and `ManualPriceSource` bounds.

### 3.5 Scripts and deployments

`script/Deploy.s.sol` (env):

| Var | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | broadcaster |
| `TOKEN` | existing ERC-20; empty → deploy `BeagleToken` to `TOKEN_RECIPIENT` (default deployer) |
| `NATIVE_BURN` | `true/false`; default `true` when the script deploys the token, else required |
| `OWNER`, `OPERATOR`, `POSTER` | default deployer |
| `INITIAL_PRICE_E18` | if > 0, `forcePrice` right after deploy (bootstrap) |
| `MAX_PRICE_AGE` (3600), `MIN_BURN` (0) | desk params |

Deploys `ManualPriceSource(owner, poster)` then `CreditDesk(token, nativeBurn, priceSource, owner, operator)`.
When `OWNER != deployer`, ownership is transferred with `transferOwnership` (Ownable2Step; the owner accepts
later) — the script logs this. Writes `contracts/deployments/<chainId>.json` via `vm.writeJson`
(`fs_permissions = [{ access = "read-write", path = "./deployments" }, { access = "write", path = "../packages/shared/fixtures" }]`):

```json
{ "chainId": 31337, "token": "0x…", "tokenSymbol": "BEAGLE", "tokenDecimals": 18, "nativeBurn": true,
  "creditDesk": "0x…", "priceSource": "0x…", "priceSourceKind": "manual",
  "deployBlock": 12, "owner": "0x…", "operator": "0x…", "poster": "0x…" }
```

`script/PostPrice.s.sol`: env `PRICE_SOURCE`, `PRICE_E18`, `POSTER_PRIVATE_KEY`; calls `post`.
`script/GenerateFixtures.s.sol`: writes `packages/shared/fixtures/quote.json` — an array of
`{ "amount": "<dec>", "priceE18": "<dec>", "decimals": n, "usdMicro": "<dec>", "tokensBack": "<dec>" }` for ≥ 24
cases (edge: 0, 1 wei, 1e36; decimals 6, 8, 18; prices 1e9 … 1e24) computed by `CreditMath`. CI regenerates
and diffs the file.

`foundry.toml`: `solc = "0.8.28"`, `optimizer = true`, `optimizer_runs = 2000`, `via_ir = false`,
`[profile.ci] fuzz.runs = 2000, invariant.runs = 200, invariant.depth = 40`; `remappings` for
`@openzeppelin/contracts/` and `forge-std/`.

## 4. Shared package (`packages/shared`, `@beagle/shared`)

Pure, browser-safe TypeScript (no `node:` imports; viem is the only runtime dependency besides zod).
Subpath exports: `.`, `./chains`, `./addresses`, `./abi`, `./credit`, `./models`, `./routing`, `./difficulty`,
`./canonical`, `./api`, `./openai`. 100 % of the public functions have vitest coverage.

### 4.1 `chains.ts`, `addresses.ts`

As in `docs/ROBINHOOD_CHAIN.md`: `robinhoodChain` (4663), `robinhoodChainTestnet` (46630), `anvilChain` (31337),
`SUPPORTED_CHAINS`, `chainById`, `toAddEthereumChainParameter` (EIP-3085), explorer URL helpers,
`MULTICALL3_ADDRESS` + `withMulticall3`. `addresses.ts`: Robinhood protocol addresses (WETH9, Uniswap v2/v3/v4,
Permit2, Universal Router), Pons V2 addresses, and `deploymentFor(chainId)` reading `deployments.generated.ts`
(`Record<number, Deployment>` generated by `scripts/sync-deployments.mjs` from `contracts/deployments/*.json`;
committed; anvil entry allowed). `resolveDeployment(chainId, overrides)` applies env overrides where the zero
address counts as unset.

### 4.2 `abi.ts`

`CREDIT_DESK_ABI`, `BEAGLE_TOKEN_ABI` (ERC-20 + permit + burn subset), `MANUAL_PRICE_SOURCE_ABI`,
`ERC20_ABI` — `as const` arrays generated by `scripts/sync-abi.mjs` from `contracts/out/*.json` into
`packages/shared/src/abi.generated.ts` (committed). The script exits non-zero in `--check` mode when the
committed file differs. A test asserts the event signatures of §3.4 are present.

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
| `anthropic/claude-fable-5-1` | frontier | `claude-fable-5-1` | 1,000,000 / 128,000 | 10,000,000 / 50,000,000 (250,000) | all | **no** (explicit only) |
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
header overrides the estimate (gateway).

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
5. **Provider state.** Drop `down` providers. Order within a tier: byok first; then `ok` before `degraded`;
   then by `preference`; then cheaper `inputPerM + outputPerM`. A provider with `quotaRatio < 0.2` counts as
   `degraded` and, for `difficulty < 0.5`, is placed after all cheaper-tier candidates ("limit running down").
6. **Fallback expansion.** `none` → `[primary]` (alias: first candidate of the target tier only).
   `cheaper` → remaining models of the tier, then each cheaper tier in `TIER_ORDER`, ending with `house`.
   `any` → `cheaper` plus higher tiers appended after. Alias requests default to `cheaper`.
   Only `autoEligible` models are added by expansion (an explicit non-eligible primary stays first).
7. **Credit gate.** Remove credit-paid candidates when `available ≤ 0`. Empty list → `insufficient_credit`
   when the only reason was credit, else `no_capable_model`.
Deterministic: same input → same output; no randomness, no clock.

### 4.7 `canonical.ts`

`canonicalJson(value)`: RFC 8785-style — object keys sorted (code point order), no whitespace, `bigint` →
decimal string, `undefined` members omitted, numbers must be finite integers (throw otherwise; monetary
values are bigint). `sha256Hex(string)` via viem `sha256(stringToBytes())`. `receiptHash(obj) = '0x' + sha256Hex(canonicalJson(obj))`.
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

Node 22 ESM, Hono 4 + `@hono/node-server`, `node:sqlite` (`DatabaseSync`, WAL, foreign keys on), viem 2,
`@anthropic-ai/sdk` (official; the only Anthropic client), `@modelcontextprotocol/sdk` (HTTP transport),
zod 4, no other heavy runtime deps. Structure:

```
src/main.ts            boot: config → db.migrate → services → indexer/poster/drawer/warm loops → http
src/cli.ts             create-key | credit | post-price | status | migrate
src/config.ts          zod-validated env (§5.1)
src/db/{sqlite,schema,repos}.ts
src/auth/{siwe,session,apiKeys,crypto}.ts
src/chain/{clients,indexer,drawer,poster,budgets}.ts
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

| Group | Keys (default) |
|---|---|
| chain | `CHAIN_ID` (31337), `RPC_URL`, `CREDIT_DESK_ADDRESS` (override; zero = unset), `START_BLOCK` (deployment block from `deployments` when unset), `CONFIRMATIONS` (0), `POLL_INTERVAL_MS` (2000), `LOG_CHUNK_BLOCKS` (2000) |
| operator | `OPERATOR_PRIVATE_KEY` (`0x`/empty → draws and posts disabled), `DRY_RUN` (true) |
| price poster | `PRICE_POSTER_ENABLED` (false), `PRICE_SOURCE_ADDRESS` (from deployments), `PRICE_FEED_URL` (http JSON `{ "priceUsd": number }`), `PRICE_POST_INTERVAL_MS` (300000) |
| budgets | `DRAW_THRESHOLD_USD` (1), `DRAW_INTERVAL_MS` (30000), `BUDGET_HEADROOM_REFRESH_MS` (15000) |
| server | `PORT` (8787), `HOST` (0.0.0.0), `PUBLIC_URL` (http://localhost:8787; SIWE domain/uri), `PUBLIC_WEB_ORIGIN` (http://localhost:5173; CORS, comma list), `DB_PATH` (./data/gateway.sqlite), `MAX_BODY_BYTES` (2000000), `TRUST_PROXY` (false), `LOG_LEVEL` (info), `LOG_PROMPTS` (false) |
| secrets | `SESSION_SECRET` (required in prod; dev default with a warning), `KEYRING_MASTER_KEY` (32-byte hex; required when BYOK enabled), `ADMIN_TOKEN` (empty = admin routes disabled) |
| providers | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` (https://api.openai.com/v1), `GOOGLE_API_KEY`, `GOOGLE_BASE_URL` (https://generativelanguage.googleapis.com/v1beta/openai), `HOUSE_BASE_URL` (empty = house disabled), `HOUSE_API_KEY`, `HOUSE_MODEL_SMALL` (openai/gpt-oss-20b), `HOUSE_MODEL_LARGE` (openai/gpt-oss-120b), `PROVIDER_TIMEOUT_MS` (120000), `MODEL_CATALOG_FILE` |
| economics | `MARKUP_BPS` (1000), `BYOK_FEE_BPS` (0), `LOW_CREDIT_USD` (1), `VERY_LOW_CREDIT_USD` (0.1), `MIN_RESERVE_USD` (0.01), `MAX_RESERVE_USD` (5), `RESERVATION_TTL_MS` (600000), `PRO_PRICE_USD` (20), `PRO_DAYS` (30), `WARM_HOUR_PRICE_USD` (2), `RATE_LIMIT_RPM` (60), `RATE_LIMIT_RPM_PRO` (300), `WARM_DRIVER` (log \| ollama \| http), `WARM_WEBHOOK_URL`, `WARM_PING_INTERVAL_MS` (240000) |

Platform keys absent → that provider is `down` for credit-paid routing (BYOK still works). `HOUSE_BASE_URL`
empty → house tier absent (router may return `no_capable_model`).

### 5.2 Database (SQLite, migrations in `schema.ts`, versioned `PRAGMA user_version`)

```
workspaces(owner TEXT PK, created_at INTEGER, plan TEXT NOT NULL DEFAULT 'free', plan_until INTEGER, display_name TEXT)
api_keys(id TEXT PK, workspace TEXT REFERENCES workspaces, name TEXT, prefix TEXT, hash TEXT UNIQUE, created_at, revoked_at, last_used_at)
sessions(id TEXT PK, workspace TEXT, created_at, expires_at)
siwe_nonces(nonce TEXT PK, created_at, expires_at)
ledger(id INTEGER PK AUTOINCREMENT, workspace TEXT, kind TEXT CHECK(kind IN ('credit','debit','adjustment','upgrade')),
       amount_micro INTEGER NOT NULL, ref_type TEXT, ref_id TEXT, memo TEXT, created_at)      -- balance = SUM(amount_micro); credit > 0, debit < 0
credit_events(tx_hash TEXT, log_index INTEGER, kind TEXT CHECK(kind IN ('purchase','draw')), receipt_id INTEGER, workspace TEXT, payer TEXT,
       token_amount TEXT, usd_micro INTEGER, price_e18 TEXT, budget_id INTEGER, receipt_hash TEXT, block_number INTEGER, block_hash TEXT,
       block_time INTEGER, created_at, PRIMARY KEY (tx_hash, log_index))
reservations(id TEXT PK, workspace TEXT, amount_micro INTEGER, created_at, expires_at)
usage(id TEXT PK, workspace TEXT, api_key_id TEXT, endpoint TEXT, requested_model TEXT, served_model TEXT, provider TEXT, tier TEXT,
       paid_by TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
       upstream_cost_micro INTEGER, charged_micro INTEGER, status TEXT, http_status INTEGER, error_code TEXT, latency_ms INTEGER,
       route_reasons TEXT, stream INTEGER, difficulty REAL, draw_id INTEGER, created_at)
provider_keys(id TEXT PK, workspace TEXT, provider TEXT, ciphertext BLOB, iv BLOB, tag BLOB, last4 TEXT, base_url TEXT, created_at, UNIQUE(workspace, provider))
budgets(budget_id INTEGER PK, owner TEXT, workspace TEXT, cap TEXT, drawn TEXT, deadline INTEGER, closed INTEGER DEFAULT 0,
       headroom_tokens TEXT, headroom_micro INTEGER, headroom_checked_at INTEGER, stalled_reason TEXT, opened_block INTEGER, updated_at)
budget_draws(id INTEGER PK AUTOINCREMENT, budget_id INTEGER, workspace TEXT, token_amount TEXT, usd_micro INTEGER, receipt_hash TEXT UNIQUE,
       usage_ids TEXT, tx_hash TEXT, status TEXT CHECK(status IN ('pending','sent','confirmed','failed')), error TEXT, created_at, updated_at)
upgrades(id TEXT PK, workspace TEXT, kind TEXT CHECK(kind IN ('pro','warm')), quantity INTEGER, amount_micro INTEGER, starts_at, ends_at, created_at)
provider_health(provider TEXT PK, state TEXT, failures INTEGER, opened_at INTEGER, open_for_ms INTEGER, updated_at)
indexer_state(key TEXT PK, value TEXT)                       -- last_block, last_block_hash
price_posts(id INTEGER PK AUTOINCREMENT, price_e18 TEXT, source TEXT, tx_hash TEXT, status TEXT, created_at)
rate_limits(key_id TEXT PK, window_start INTEGER, count INTEGER)
```
Indices on `ledger(workspace)`, `usage(workspace, created_at)`, `credit_events(workspace)`, `reservations(workspace)`,
`budgets(workspace)`. All repos use prepared statements; monetary columns are 64-bit integers (µUSD) — amounts
above `2^53` are handled as `bigint` via `readBigInts`-safe access (`stmt.setReadBigInts(true)`).

**Balance definitions** (used by every route and by routing):
`balance = Σ ledger.amount_micro`; `reserved = Σ reservations.amount_micro (not expired)`;
`budgetHeadroom = Σ budgets.headroom_micro` over open, unexpired, non-stalled budgets of the workspace;
`available = balance − reserved + budgetHeadroom`.

### 5.3 Authentication

- **SIWE** (`viem/siwe`): `GET /api/auth/nonce` → `{ nonce }` (stored, 10 min). The web signs `domain = host(VITE_GATEWAY_URL || page origin)`,
  `uri = that origin + '/'`, `chainId = VITE_CHAIN_ID`, so `PUBLIC_URL` of the gateway MUST equal the origin the browser talks to
  (dev: `http://localhost:8787` = `VITE_GATEWAY_URL`; prod behind nginx: the site URL). `POST /api/auth/verify { message, signature }`:
  `parseSiweMessage`, check `domain == host(PUBLIC_URL)`, `nonce` known & unused, `chainId ∈ SUPPORTED_CHAINS`,
  `verifySiweMessage` with a public client for the message's chain (EOA; contract wallets via ERC-1271 are supported
  by viem's verify when RPC is available). Creates the workspace if missing, creates a session, sets the cookie,
  returns `{ token, workspace }`. `POST /api/auth/logout`. `GET /api/me`.
- **API keys**: `POST /api/keys { name }` → `{ id, key, prefix, name, createdAt }` (full key returned once).
  `GET /api/keys` → masked list. `DELETE /api/keys/:id` → revoke. Inference and MCP accept
  `Authorization: Bearer bgl_…` or `x-api-key: bgl_…`. Keys are looked up by `sha256`; `last_used_at` updated
  at most once a minute. Revoked → 401 `invalid_api_key`.
- **Session vs key**: `/api/*` dashboard routes accept sessions; routes marked "key OK" (§5.9) also accept API keys.
- **BYOK encryption**: AES-256-GCM, key = `KEYRING_MASTER_KEY`, random 12-byte IV, AAD = `workspace|provider`.
  Decrypt only in the request path; never log. `last4` shown in UI.
- **Admin**: `x-admin-token` header equal to `ADMIN_TOKEN` (constant-time compare). Disabled when unset.

### 5.4 Chain workers

**Indexer** (`chain/indexer.ts`): one `PublicClient` (viem `http(RPC_URL)`, `batch: { multicall: false }`).
Loop every `POLL_INTERVAL_MS`: `head = getBlockNumber() − CONFIRMATIONS`; from `last_block + 1` to `head`
in chunks of `LOG_CHUNK_BLOCKS`: `getLogs({ address: desk, events: [CreditPurchased, BudgetOpened, BudgetDrawn, BudgetClosed] })`.
Apply inside one transaction per chunk, idempotent on `(tx_hash, log_index)`:
- `CreditPurchased` → `credit_events(kind='purchase')`; ensure workspace; `ledger(kind='credit', amount=usd_micro, ref_type='credit_event', ref_id='<tx>:<idx>')`.
- `BudgetOpened` → upsert `budgets` (drawn 0, closed 0); ensure workspace.
- `BudgetDrawn` → `credit_events(kind='draw')`; ledger credit; `budgets.drawn += amount`; `budget_draws` with the same
  `receipt_hash` → `status='confirmed', tx_hash`.
- `BudgetClosed` → `budgets.closed = 1`.
Store `last_block` and `last_block_hash`. **Reorg guard**: before applying, fetch the block at `last_block`; if its
hash ≠ `last_block_hash`, rewind `R = CONFIRMATIONS + 10` blocks: delete `credit_events` with `block_number > last_block − R`
and their ledger rows (`ref_type='credit_event'`), reset `budgets` affected by deleted draws (recompute `drawn` from
remaining events), set `last_block −= R`. `GET /api/status` reports `{ lastBlock, head, lagBlocks, lastEventAt }`.
First run: `last_block = START_BLOCK − 1`.

**Budget headroom refresher** (`chain/budgets.ts`, every `BUDGET_HEADROOM_REFRESH_MS`): for each open, unexpired
budget: `remainingCap = cap − drawn`, `allowance = token.allowance(owner, desk)`, `balance = token.balanceOf(owner)`
(one `multicall` when available, else three reads); `headroom_tokens = min(remainingCap, allowance, balance)`;
`headroom_micro = quoteUsdMicro(headroom_tokens, price)` using the desk's current `quote(1e18)`-derived price
(call `quote(10**decimals)` for `priceE18`); on `PriceStale`/`PriceUnavailable` → `headroom_micro = 0`,
`stalled_reason = 'price'`. `headroom_tokens == 0` with `remainingCap > 0` → `stalled_reason = 'allowance'`.

**Budget drawer** (`chain/drawer.ts`, every `DRAW_INTERVAL_MS`, requires operator key, skipped in `DRY_RUN`):
for each workspace with `balance − reserved < 0` and ≥ 1 open non-stalled budget: `deficit = −(balance − reserved)`;
if `deficit ≥ DRAW_THRESHOLD_USD` **or** the budget expires within 1 h: pick the budget with the largest headroom;
`usageIds` = unsettled usage rows (`draw_id IS NULL`, `paid_by='credit'`, `charged_micro > 0`) oldest first until
their sum ≥ deficit (cap at 500 rows); `amountMicro = Σ charged_micro of those rows` (≤ `headroom_micro`, else
truncate the list); `tokens = tokensForUsdMicro(amountMicro, priceE18)`; `batch: DrawBatch = { v: 1, chainId, desk,
budgetId, workspace, usageIds, amountMicro, priceE18 }`; `receiptHash = receiptHash(batch)`; insert
`budget_draws(status='pending')`, mark the usage rows `draw_id`; send `desk.draw(budgetId, tokens, receiptHash)`;
on send → `status='sent', tx_hash`; wait for the receipt (`waitForTransactionReceipt`, 120 s); reverted/timeout →
`status='failed', error`, un-mark usage rows, `budgets.stalled_reason = 'draw_failed'` (cleared on the next
successful headroom refresh showing allowance/balance). Confirmation and the ledger credit come from the indexer
(`BudgetDrawn` with the same `receipt_hash`), never from the drawer, so the ledger has exactly one source of truth.

**Price poster** (`chain/poster.ts`, optional): fetch `PRICE_FEED_URL` → `priceUsd` → `priceE18`; read
`ManualPriceSource` bounds; clamp the step to `maxStepBps`; skip if within `minInterval` or if the change is
< 0.5 %; `post()` with the operator key; record in `price_posts`. `DRY_RUN` → log only.

Transactions are sent with a small in-process queue (one at a time, nonce from `getTransactionCount('pending')`,
`maxFeePerGas` from `estimateFeesPerGas`), retrying `nonce too low` once.

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
and reset. Non-retryable errors (400) never affect health. BYOK 401 affects only that workspace (the key is
flagged `invalid` in `provider_keys` via `base_url`-independent column `last_error`, shown in the UI) — not global
health. Platform `401/403` → `down` immediately (misconfiguration).

**Execution** (`execute.ts`): given the parsed request and workspace:
1. Build `RoutingInput` (difficulty from `x-beagle-difficulty` or `estimateDifficulty`; `needs` from the body;
   `contextTokens ≈ ceil(chars/4)`; `fallback` from `x-beagle-fallback` (`none|cheaper|any`; default `cheaper`
   for aliases, `cheaper` for explicit too); byok list; health; `available`).
2. `route()`. Errors → HTTP: `unknown_model` 404 `model_not_found`, `plan_required` 403 `plan_required`,
   `no_capable_model` 503 `no_model_available`, `insufficient_credit` 402 `insufficient_credit`.
3. For each candidate in order: credentials (`undefined` → skip with reason); if `paidBy='credit'`:
   estimate (§5.7) and reserve; call adapter with a per-attempt `AbortSignal` (timeout) — on `retryable`
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
  reservation of `min(reserve, max(available, MIN_RESERVE))`. BYOK-paid requests skip reserve/gate.
- **Settle**: `upstreamCost = costMicroUsd(usage, price)`; `charged = paidBy==='credit' ? applyMarkupBps(upstreamCost, MARKUP_BPS) : ceilDiv(upstreamCost · BYOK_FEE_BPS, 10_000)` (BYOK default 0 → free);
  ledger `debit −charged` (`ref_type='usage'`, `ref_id=requestId`) when `charged > 0`; delete the reservation; write
  the `usage` row (always, also on errors: `charged` = cost of tokens actually streamed, else 0). Expired
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
| `GET /api/receipts?limit&before` | `credit_events` of the workspace with explorer links |
| `GET /api/receipts/:requestId` (key OK) | `ReceiptDto = { receipt: UsageReceipt, hash }` (`hash = receiptHash(receipt)`) |
| `GET /api/providers`, `PUT /api/providers/:provider { apiKey, baseUrl? }`, `DELETE /api/providers/:provider`, `POST /api/providers/:provider/test` | BYOK; `provider ∈ anthropic\|openai\|google`; `baseUrl` must be `https:` and not resolve to a private/loopback range (SSRF guard; hostnames checked at save time and again at use time) ; test = minimal completion through the key |
| `GET /api/budgets`, `GET /api/budgets/:id`, `GET /api/budgets/:id/draws` (key OK) | `BudgetDto { budgetId, owner, workspace, cap, drawn, remainingCap, headroomTokens, headroomMicro, deadline, closed, stalledReason, draws }` |
| `GET /api/upgrades`, `GET /api/upgrades/prices`, `POST /api/upgrades { kind, quantity }` (key OK) | §5.11; 402 when `available` is short |
| `GET /api/models` (public) | `ModelDto[]` + aliases, availability per provider health and plan |
| `GET /api/price` (public) | `{ priceE18, updatedAt, stale, usdPerToken, tokensPerUsd, source: 'manual'\|'chainlink'\|'unknown', maxPriceAge }` |
| `GET /api/quote?tokens=<raw>` or `?usdMicro=<n>` (public) | `{ tokens, usdMicro, priceE18, updatedAt }` from `desk.quote` / inverse |
| `GET /api/status` (public) | `{ chainId, creditDesk, token: { address, symbol, decimals, nativeBurn }, indexer: {…}, providers: Record<Provider, { state, configured }>, house: { enabled, warmUntil, largeModel }, operator: { enabled, dryRun }, version }` |
| `GET /api/config` (public) | `{ chainId, creditDesk, token, priceSource, explorer, aliases, markupBps, byokFeeBps, pro: { priceMicro, days }, warmHourPriceMicro }` |
| `POST /api/admin/credit { workspace, amountMicro, memo }`, `POST /api/admin/price { priceE18 }`, `GET /api/admin/workspaces` | `ADMIN_TOKEN` |
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

`migrate`, `create-key --workspace 0x… [--name]` (prints the key), `credit --workspace 0x… --usd 10 [--memo]`
(admin adjustment; refuses when `NODE_ENV=production` unless `--force`), `post-price --usd 0.01`, `status`.

### 5.13 Logging

JSON lines to stdout (`log.ts`): `level, time, msg, requestId?, workspace?`. Prompts/completions are never
logged unless `LOG_PROMPTS=true`. Provider keys, API keys, session ids never appear in logs (redaction test).

## 6. MCP package (`packages/mcp`, `@beagle/mcp`)

### 6.1 Transports

- `bin/beagle-mcp` (stdio): env `BEAGLE_API_URL` (default `https://localhost:8787` → document), `BEAGLE_API_KEY`
  (required), optional `BEAGLE_AGENT_PRIVATE_KEY` (hex) + `BEAGLE_RPC_URL`. With an agent key the wallet tools
  **execute** transactions (approve → burn/openBudget, wait for receipt, then poll `/api/balance` up to 60 s until
  the credit appears); without it they return `{ unsigned: true, chainId, to, data, value: '0', description }` for
  each step so a wallet-capable agent can sign.
- Library: `createBeagleMcpServer(api: BeagleApi, opts: { wallet?: WalletExecutor }) → McpServer` (used by the gateway
  with the HTTP transport).

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
| `beagle_buy_compute` | `{ usd? \| tokens?, workspace? }` | executed: `{ txHash, receiptId?, creditedMicro, balanceMicro }`; else unsigned steps |
| `beagle_open_budget` | `{ usd? \| tokens?, hours (≤ 720), workspace? }` | executed: `{ txHash, budgetId }`; else unsigned steps |
| `beagle_budgets` | — | `BudgetDto[]` |
| `beagle_upgrade` | `{ kind: 'pro'\|'warm', quantity? }` | `UpgradeDto` |
| `beagle_status` | — | `StatusDto` |

Resources: `beagle://models` (markdown table), `beagle://quickstart` (the docs quick start). Errors are returned
as `isError: true` tool results with the gateway error code. Unit tests use an in-memory `BeagleApi` fake and the
SDK's in-memory transport pair.

## 7. Web app (`web/`, `@beagle/web`)

Vite 8, React 19, react-router 7 (data router), wagmi 3 + viem (connectors: injected, WalletConnect when
`VITE_WALLETCONNECT_PROJECT_ID` set), TanStack Query 5, Tailwind 4. Dark theme, monospace accents, English UI.
No chart libraries (CSS bars). Vitest for `lib/` and hooks logic.

Env: `VITE_CHAIN_ID` (31337), `VITE_GATEWAY_URL` (dev proxy target for `/api`, `/v1`, `/mcp`; prod: same origin
when empty), `VITE_CREDIT_DESK_ADDRESS` (override), `VITE_RPC_URL`, `VITE_WALLETCONNECT_PROJECT_ID`, `VITE_MULTICALL`.
Deployment addresses come from `@beagle/shared` `resolveDeployment(chainId, { creditDesk: VITE_CREDIT_DESK_ADDRESS })`
and the token address from `GET /api/config`.

Routes:
- `/` **Landing**: hero ("Compute for agents. Burn becomes compute."), three cards (one key for every model /
  router keeps your best model for hard work / paid by burning BEAGLE, no e-mail, no card), live strip from
  `/api/status` + `/api/price` (token price, indexer height, provider health), code sample (curl), CTA → `/app`.
- `/models` **Models & pricing**: table from `/api/models` (tier, context, price in/out per 1M, availability, Pro).
- `/docs` **Docs**: quick start with the gateway base URL (curl, OpenAI SDK python/node `base_url`, Anthropic SDK
  `baseURL`, MCP config JSON for Claude Desktop / Claude Code with `beagle-mcp`), headers reference, aliases, 402 semantics.
- `/app` **Overview** (signed in): balance card (available / reserved / budget headroom), plan, 24 h usage, latest
  requests, token price, "Buy credit" CTA.
- `/app/credits` **Credits**: amount input (USD or BEAGLE, toggles), live quote via `readContract(desk.quote)`,
  wallet token balance + allowance, steps **Approve → Burn** (`approve(desk, amount)` then
  `burnForCredit(workspace, amount)`; workspace defaults to the signed-in address, editable "credit another
  workspace"), tx progress with explorer links, then poll `/api/balance` until the ledger shows the credit
  (indexer lag notice). Shows `minBurn`, price staleness warnings (disable when `stale`).
- `/app/keys`: create (shows the key once with copy), list, revoke.
- `/app/usage`: summary tiles (window selector), by-model bars, by-day bars, table with request id → `/app/receipts/:id`.
- `/app/receipts/:id`: `UsageReceipt` fields, canonical JSON, hash, "verify locally" snippet.
- `/app/providers`: BYOK add/replace/remove per provider, test button, encrypted-at-rest notice.
- `/app/upgrades`: Pro (price, days, current `planUntil`, buy), Warm hours (hours input, price, buy, current warm window).
- `/app/budgets`: open a budget (cap in USD/BEAGLE, hours; Approve cap → `openBudget`), list with cap/drawn/headroom/
  deadline/stalled reason, draws with tx links, close.
- Global: wallet button, chain guard (switch/add Robinhood Chain via EIP-3085), SIWE sign-in flow
  (`nonce → createSiweMessage → signMessage → verify`), session restore via `GET /api/me`, toasts, error boundary, 404.

`web/src/lib/` holds pure helpers (formatting, step state machines, SIWE message building) with tests; hooks wrap
wagmi/query; components are presentational.

## 8. Dev, e2e, CI, Docker

- Root scripts: `build`, `typecheck`, `test`, `lint`, `dev:gateway`, `dev:web`, `contracts:build`, `contracts:test`,
  `abi:sync`, `deployments:sync`, `anvil:e2e`.
- `scripts/mock-provider.mjs`: OpenAI-compatible server (`/v1/models`, `/v1/chat/completions` JSON + SSE) returning
  deterministic text (`echo:` + last user message, capped) with usage; env `MOCK_FAIL_RATE`, `MOCK_STATUS` for tests.
- `scripts/anvil-e2e.sh`: anvil (`--block-time 1`) → `Deploy.s.sol` (deployer/operator/poster = anvil #0,
  `INITIAL_PRICE_E18 = 1e16` i.e. $0.01, token to #0; #0 transfers 100 000 BEAGLE to #1 and #2) →
  `sync-deployments` → build → mock provider on 9999 → gateway (`HOUSE_BASE_URL=http://127.0.0.1:9999/v1`,
  no platform keys, `DRY_RUN=false`, operator = #0, temp DB, `DRAW_THRESHOLD_USD=0.000001`, `DRAW_INTERVAL_MS=2000`) →
  `create-key` for #1 and #2 → `cast send` #1 `approve` + `burnForCredit(#1, 1000e18)` ($10) → wait for
  `/api/balance ≥ 9_990_000` → `POST /v1/chat/completions {model:'beagle/auto'}` → assert 200,
  `x-beagle-model == house/gpt-oss-20b`, cost > 0, balance decreased, `/api/usage` has the row, `/api/receipts/:id`
  hash recomputes → streaming request asserts SSE frames and `[DONE]` → `/v1/messages` request asserts Anthropic
  shape → #2 (no credit) gets 402 → #2 `approve(cap)` + `openBudget(#2, 500e18, +1h)` → wait for headroom → #2
  request succeeds (balance negative) → drawer draws → indexer credits → `/api/balance` of #2 shows `balance ≥ 0`
  and `/api/budgets` shows `drawn > 0` with a confirmed draw whose `receiptHash` recomputes → MCP HTTP:
  `tools/list` and `beagle_balance` via `curl` JSON-RPC → exit 0. Timeouts fail loudly; cleanup via `trap`.
- CI (`.github/workflows/ci.yml`): job `contracts` (foundry-toolchain stable: `forge fmt --check`, `forge build --sizes`,
  `forge test -vvv`, fixtures diff); job `node` (pnpm 10, Node 22: install, `forge build`, `abi:sync --check`,
  build, typecheck, test, `anvil:e2e`).
- Docker: `docker/gateway.Dockerfile` (node:22-alpine, pnpm, workspace build, `node gateway/dist/main.js`),
  `docker/web.Dockerfile` (build → nginx; `docker/nginx.conf` proxies `/api`, `/v1`, `/mcp`, `/healthz` to
  `gateway:8787` with SSE-friendly `proxy_buffering off`), `docker-compose.yml`: `gateway`, `web`, profile `gpu`:
  `house` (`vllm/vllm-openai`, `--model openai/gpt-oss-20b --served-model-name openai/gpt-oss-20b`, NVIDIA
  device reservation) and `house-large` (`gpt-oss-120b`). `HOUSE_BASE_URL=http://house:8000/v1` in the compose env.

## 9. Security and trust model

- **Burn is final and verifiable.** Credit equals the `usdMicro` in the on-chain event; the price used is the one
  the contract read. Anyone can recompute credits from events; the gateway's ledger is a cache of them plus debits.
- **Operator** (gateway hot wallet) can only (a) post prices within `maxStepBps`/`minInterval` on
  `ManualPriceSource` and (b) `draw` from budgets up to each cap before its deadline, with a receipt hash of the
  usage it settles. It cannot move user tokens otherwise. Owner (multisig on mainnet) controls params and pause.
- **Keys**: API keys hashed; BYOK encrypted (AES-256-GCM) with a server master key; sessions random; SIWE nonces
  single-use; CORS restricted to `PUBLIC_WEB_ORIGIN`; `baseUrl` SSRF guard; body size limits; per-key rate limits.
- **Prompts** are not persisted (only token counts and costs) unless `LOG_PROMPTS=true`.
- **Fallback never silently upgrades price class** beyond the request: `cheaper` is the default; `any` is opt-in.
- **Known gaps**: provider price snapshots must be maintained by the operator; the house model is only as
  available as the GPU behind `HOUSE_BASE_URL`; the Manual price source trusts the poster within bounds —
  use `ChainlinkPriceSource` when a feed exists.

## 10. Addresses

See `docs/ROBINHOOD_CHAIN.md` for chain parameters, Uniswap/Pons/WETH9 addresses, explorers and faucets.
Deployed `CreditDesk`/token/price-source addresses live in `contracts/deployments/<chainId>.json` and
`packages/shared/src/deployments.generated.ts`.
