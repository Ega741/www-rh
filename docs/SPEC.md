# www-rh — technical specification

**Product:** "worldwideweb on Robinhood Chain" — a pump.fun-style launchpad where every coin has a
*mind*: an LLM (Claude) driving a real headless browser, reading the web on its own, remembering what
it finds, and sustaining itself from the coin's trading fees. Port of worldwideweb.stream
(`@www_stream`, Solana/pump.fun) to **Robinhood Chain** (Arbitrum Orbit L2, chain id 4663 mainnet /
46630 testnet, gas in ETH). See `docs/ANALYSIS.md` (RU) for the product analysis and
`docs/ROBINHOOD_CHAIN.md` for chain details and addresses.

This document is the contract between packages. Names, signatures, events, JSON shapes and
formulas here are normative; implementers must not rename them without updating this file.

---

## 0. Repository layout and toolchain

```
www-rh/
  contracts/          Foundry project (Solidity ^0.8.37, OpenZeppelin 5.6.1 in lib/, forge-std in lib/)
  packages/shared/    @www-rh/shared  — chains, ABIs (human-readable, viem parseAbi), curve math,
                      model catalog, API DTO types. Pure TS, no runtime deps except viem.
  runner/             @www-rh/runner  — indexer, scheduler, mind loop, browser, memory, API+WS.
  web/                @www-rh/web     — Vite + React 19 + wagmi 3 + viem + TanStack Query + Tailwind v4.
  docs/               ANALYSIS.md, SPEC.md, DEPLOY.md, ROBINHOOD_CHAIN.md
  pnpm-workspace.yaml, package.json (root scripts), .env.example, docker-compose.yml, .github/workflows/ci.yml
```

Toolchain (pinned): Node 22 (ESM, `"type": "module"`), pnpm 10, TypeScript (strict), vitest,
`@anthropic-ai/sdk` ^0.131, `viem` ^2.57, `wagmi` ^3.7, `playwright` **1.56.1** (must match the
preinstalled Chromium build in CI/sandbox: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`), `zod` ^4, `hono` ^4 + `@hono/node-server`, `ws` ^8,
`node:sqlite` (built-in; no native modules). Foundry 1.6 (`forge`, `anvil`), solc 0.8.37.

Sandbox constraints for implementers: no access to any Robinhood RPC/explorer, no
`binaries.soliditylang.org`; run forge with `FOUNDRY_SOLC=/usr/local/bin/solc` and
`PATH=/root/.foundry/bin:$PATH`; npm registry and GitHub (git + release assets) are reachable.

---

## 1. Economics (normative constants)

All token amounts are 18-decimals; ETH amounts are wei.

| Name | Value | Meaning |
|---|---|---|
| `TOTAL_SUPPLY` | `1_000_000_000e18` | minted once to the launchpad at creation |
| `CURVE_SUPPLY` | `800_000_000e18` | sold on the bonding curve |
| `LP_SUPPLY` | `200_000_000e18` | reserved; goes to the DEX at graduation |
| `VIRTUAL_ETH` | `1.365 ether` | virtual ETH reserve (x₀) |
| `VIRTUAL_TOKENS` | `1_073_000_000e18` | virtual token reserve (y₀) |
| `tradeFeeBps` | `100` (1 %) | fee on every curve buy/sell; owner-settable, max 500 |
| `mindShareBps` | `7000` (70 %) | share of every fee that goes to the coin's **mind vault**; rest → protocol; max 10000 |
| `graduationFeeBps` | `250` (2.5 %) | taken from the real ETH reserve at graduation, split by `mindShareBps`; max 1000 |
| `creationFee` | `0` | flat fee to create; owner-settable |
| `maxDrawPerEpoch` / `drawEpoch` | `0.25 ether` / `1 day` | per-mind cap on operator compute draws |
| `maxGraduationPriceDeviationBps` | `2000` | graduator refuses to add liquidity if an existing pool's price deviates more than this from the curve's final price |

Curve: constant product with virtual reserves. Let `x = VIRTUAL_ETH + realEthReserve`,
`y = VIRTUAL_TOKENS - tokensSold`, `k = x·y`. Rounding always favours the contract.

- **quoteBuy(ethIn)** → `(tokensOut, ethUsed, fee)`:
  `fee = ethIn·tradeFeeBps/10000`, `net = ethIn - fee`,
  `tokensOut = y - ceilDiv(k, x + net)`.
  If `tokensOut > CURVE_SUPPLY - tokensSold` (curve would overflow): `tokensOut = CURVE_SUPPLY - tokensSold`,
  `net' = ceilDiv(k, y - tokensOut) - x`, `fee' = ceilDiv(net'·tradeFeeBps, 10000 - tradeFeeBps)`,
  `ethUsed = net' + fee'` and the remainder `ethIn - ethUsed` is refunded to the buyer. Otherwise `ethUsed = ethIn`.
  State after: `realEthReserve += net`, `tokensSold += tokensOut`. If `tokensSold == CURVE_SUPPLY` → phase `Complete`.
- **quoteSell(tokensIn)** → `(ethOut, fee)`: require `tokensIn <= tokensSold`.
  `ethGross = x - ceilDiv(k, y + tokensIn)`, `fee = ethGross·tradeFeeBps/10000`, `ethOut = ethGross - fee`.
  State after: `realEthReserve -= ethGross`, `tokensSold -= tokensIn`.
- **currentPrice** (wei per 1e18 tokens) `= x·1e18 / y`. Market cap (display) `= price·TOTAL_SUPPLY/1e18`.
- Trades only while phase == `Bonding`. Completion: ~`4.0 ETH` collected (`1.365·800/273`).
- **Graduation**: `gradFee = realEthReserve·graduationFeeBps/10000` (split mind/protocol),
  `ethLiquidity = realEthReserve - gradFee`, `tokenLiquidity = LP_SUPPLY`. Final curve price
  `≈ 1.965e-8 ETH`, LP price `≈ 1.95e-8 ETH` (slightly below, as on pump.fun).

The TypeScript mirror (`@www-rh/shared/curve`) must reproduce these bigint formulas exactly; a
shared JSON fixture (`packages/shared/fixtures/curve.json`, generated by a Foundry script/test) is
checked in and used by both `forge test` and `vitest` to prove equivalence.

---

## 2. Contracts (`contracts/`)

Solidity `^0.8.37` (pragma `^0.8.24` is acceptable), OpenZeppelin 5.6.1 (`Ownable2Step`,
`Pausable`, `ReentrancyGuard`, `ERC20`, `ERC20Permit`, `SafeERC20`, `Math`), custom errors only,
NatSpec on all externals, `evm_version = "cancun"`, optimizer 200 runs (set `via_ir` only if needed).

### 2.1 `MindToken` — `src/MindToken.sol`

`ERC20 + ERC20Permit`. Constructor `(string name, string symbol, address launchpad, address creator)`
mints `TOTAL_SUPPLY` to `launchpad`. Immutables `launchpad`, `creator`. No other logic, no
transfer restrictions, no owner. Deployed with `new` (CREATE) by the launchpad.

### 2.2 `IGraduator` — `src/interfaces/IGraduator.sol`

```solidity
interface IGraduator {
    /// @notice Deploys liquidity for `token`. Caller (launchpad) has already transferred
    /// `tokenAmount` of `token` to this contract and sends ETH as msg.value.
    /// @param targetPriceWei  curve's final price, wei per 1e18 tokens (used for pool init / deviation check)
    function graduate(address token, uint256 tokenAmount, uint256 targetPriceWei)
        external payable returns (address pool, uint256 positionId);
    /// @notice Collects DEX fees for `token`; ETH is forwarded to launchpad.creditMind{value}(token),
    /// collected tokens are burned (sent to 0x000000000000000000000000000000000000dEaD).
    function harvest(address token) external returns (uint256 ethOut, uint256 tokensBurned);
}
```

### 2.3 `MindLaunchpad` — `src/MindLaunchpad.sol`

Single core contract: factory + bonding curve + fee router + mind vault + mind registry.
`Ownable2Step, Pausable, ReentrancyGuard`. Constructor `(address owner, address treasury, address operator, address graduator)`.

```solidity
enum CurvePhase { Bonding, Complete, Graduated }
enum MindStatus { Alive, Dormant, Retired }

struct MindInfo {
    address creator;
    bytes32 modelId;      // keccak256(modelString), see §4 model catalog
    bytes32 personaHash;  // keccak256(persona prompt text); full text lives in metadata JSON
    string  metadataURI;  // JSON: {name, symbol, description, image, persona, model, links}
    uint64  createdAt;
    MindStatus status;
}
struct CurveState {
    uint128 realEthReserve;
    uint128 tokensSold;
    CurvePhase phase;
    address pool;         // after graduation
    uint256 positionId;   // after graduation (0 for MockGraduator)
}
struct FeeParams { uint16 tradeFeeBps; uint16 mindShareBps; uint16 graduationFeeBps; }

// --- user ---
function createMind(string calldata name, string calldata symbol, string calldata metadataURI,
    bytes32 modelId, bytes32 personaHash, uint256 minTokensOut) external payable returns (address token);
    // msg.value >= creationFee; the remainder (msg.value - creationFee) is an initial buy for msg.sender
    // (skipped when 0). Token is appended to the registry. Emits MindCreated (+ Trade if initial buy).
function buy(address token, uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut);
function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline) external returns (uint256 ethOut);
    // sell pulls tokens with transferFrom (user approves launchpad); ETH is sent with call{value}.
function graduate(address token) external;         // permissionless; requires phase == Complete
function harvest(address token) external;          // permissionless; requires phase == Graduated; calls graduator.harvest
function fundMind(address token) external payable; // anyone; adds to mindBalance; emits MindFunded
function creditMind(address token) external payable; // only graduator; adds to mindBalance; emits MindFunded(from=graduator)

// --- views ---
function quoteBuy(address token, uint256 ethIn) external view returns (uint256 tokensOut, uint256 ethUsed, uint256 fee);
function quoteSell(address token, uint256 tokensIn) external view returns (uint256 ethOut, uint256 fee);
function currentPrice(address token) external view returns (uint256 weiPer1e18Tokens);
function getMind(address token) external view returns (MindInfo memory);
function getCurve(address token) external view returns (CurveState memory);
function mindBalance(address token) external view returns (uint256);
function protocolBalance() external view returns (uint256);
function mindsLength() external view returns (uint256);
function mindAt(uint256 index) external view returns (address);
function isMind(address token) external view returns (bool);
function feeParams() external view returns (FeeParams memory);
function creationFee() external view returns (uint256);
function drawLimit() external view returns (uint256 maxPerEpoch, uint32 epochSeconds);
function drawnInEpoch(address token) external view returns (uint256 drawn, uint64 epochStart);
function operator() external view returns (address);
function treasury() external view returns (address);
function graduator() external view returns (address);
function VIRTUAL_ETH() / VIRTUAL_TOKENS() / CURVE_SUPPLY() / LP_SUPPLY() / TOTAL_SUPPLY() external view returns (uint256);

// --- creator ---
function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string calldata metadataURI) external;
function retireMind(address token) external;        // status = Retired; cannot be undone; vault stays claimable by operator for final draw? NO: retired minds can no longer be drawn from; creator may withdraw remaining vault via withdrawRetiredMind
function withdrawRetiredMind(address token, address to) external; // creator, only when Retired; sends mindBalance to `to`

// --- operator (runner hot wallet) ---
function drawCompute(address token, uint256 amount, address to, bytes32 receiptHash) external;
    // require status != Retired, amount <= mindBalance, epoch cap; emits ComputeDrawn
function anchorMemory(address token, uint64 seq, bytes32 contentHash, string calldata uri) external; // event only
function setMindStatus(address token, MindStatus status) external; // only Alive <-> Dormant; cannot set Retired
function graduateFor(address token) external;        // alias of graduate (kept permissionless); optional

// --- owner ---
function setOperator(address) / setTreasury(address) / setGraduator(address) external;
function setFeeParams(FeeParams calldata) external;  // bounds: trade<=500, mindShare<=10000, graduation<=1000
function setCreationFee(uint256) external;
function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds) external;
function pause() / unpause() external;              // pauses createMind and buy only; sell/graduate/harvest/draw stay enabled
function withdrawProtocolFees(address to) external;  // sends protocolBalance

// --- events (indexed as shown) ---
event MindCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash);
event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEthReserve, uint256 tokensSold);
    // ethAmount = ethUsed (buy) or ethOut (sell), both net of refund; fee = total fee
event CurveCompleted(address indexed token, uint256 realEthReserve);
event Graduated(address indexed token, address pool, uint256 positionId, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 graduationFee);
event MindFunded(address indexed token, address indexed from, uint256 amount);          // fundMind, creditMind and fee shares all emit this (from = trader for fee shares? NO: fee shares emit FeeAccrued)
event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount);
event ComputeDrawn(address indexed token, uint256 amount, address indexed to, bytes32 receiptHash);
event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri);
event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI);
event MindStatusChanged(address indexed token, MindStatus status);
event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned);
event ProtocolFeesWithdrawn(address indexed to, uint256 amount);
event RetiredMindWithdrawn(address indexed token, address indexed to, uint256 amount);
event OperatorUpdated(address); event TreasuryUpdated(address); event GraduatorUpdated(address);
event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps);
event CreationFeeUpdated(uint256); event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds);

// --- errors ---
error NotAMind(); error WrongPhase(); error Slippage(); error Expired(); error ZeroAmount();
error NotCreator(); error NotOperator(); error NotGraduator(); error Retired(); error InvalidStatus();
error DrawLimitExceeded(); error InsufficientMindBalance(); error FeeTooHigh(); error InsufficientCreationFee();
error ZeroAddress(); error EthTransferFailed();
```

Rules:
- `buy`/`sell` revert with `Expired()` when `block.timestamp > deadline`, `WrongPhase()` unless `Bonding`,
  `Slippage()` on min-out, `ZeroAmount()` on 0 input. Refund excess ETH on the completing buy.
- Fees: every trade splits `fee` into `mindBalance[token] += fee·mindShareBps/10000` and
  `protocolBalance += fee - mindShare`; emits `FeeAccrued`.
- `graduate`: phase `Complete` → compute `gradFee`, split it (FeeAccrued), transfer `LP_SUPPLY` tokens
  to graduator, call `graduator.graduate{value: ethLiquidity}(token, LP_SUPPLY, finalPrice)`, store
  `pool`/`positionId`, set `Graduated`, `realEthReserve = 0`, emit `Graduated`. Reentrancy-guarded.
- `drawCompute`: epoch accounting `drawnInEpoch` resets when `block.timestamp >= epochStart + epochSeconds`.
- ETH transfers via `call`; never `transfer`. All ETH-sending externals are `nonReentrant`.
- `receive()` reverts (only `fundMind`/`creditMind`/payable functions accept ETH) — except the
  contract must accept refunds from the graduator: graduator returns leftovers via `creditMind{value}`.
- Registry: `address[] private _minds` + `mapping(address => MindInfo)` + `mapping(address => CurveState)`.
- `createMind` deploys `new MindToken(name, symbol, address(this), msg.sender)`; name/symbol length 1..64 / 1..16.

### 2.4 `UniswapV3Graduator` — `src/UniswapV3Graduator.sol`

`Ownable2Step`. Constructor `(address owner, address launchpad, address positionManager, address factory, address weth9, uint24 feeTier /*10000*/)`.
Minimal local interfaces in `src/interfaces/uniswap/` (`IWETH9`, `IUniswapV3Factory`, `IUniswapV3Pool` (slot0), `INonfungiblePositionManager` (createAndInitializePoolIfNecessary, mint, collect, positions)). Do not import the Uniswap npm packages.

`graduate(token, tokenAmount, targetPriceWei)` (only launchpad):
1. Wrap `msg.value` to WETH. Order tokens (`token0 < token1`). Compute `sqrtPriceX96` for the target
   price from the actual amounts (`amount1·2^192/amount0`, via `Math.mulDiv` then `Math.sqrt`).
2. `pool = factory.getPool(token0, token1, fee)`. If it exists and is initialized, read `slot0`; if
   its price deviates from the target by more than `maxDeviationBps` (owner-settable, default 2000)
   revert `PoolPriceSkewed()`. Else `createAndInitializePoolIfNecessary`.
3. Approve and `mint` a full-range position (`tickLower = -887200`, `tickUpper = 887200` for
   tickSpacing 200; derive from `tickSpacing` in general: `(MIN_TICK / spacing) * spacing`),
   `amount0Min/amount1Min = 0`, recipient = this, deadline = block.timestamp. Store `positionId[token]`.
4. Leftover WETH → unwrap → `launchpad.creditMind{value}(token)`; leftover tokens → burn (0xdead).
`harvest(token)` (only launchpad): `collect(positionId, this, max, max)`; unwrap WETH → `creditMind`;
tokens → 0xdead; return amounts. LP NFT is never transferred out (no rescue function for it).

### 2.5 `MockGraduator` — `src/MockGraduator.sol`

For testnets without Uniswap v3 and for unit tests: holds ETH + tokens forever, returns
`(pool = address(this), positionId = 0)`; `harvest` returns `(0, 0)`. Also used by the runner in
local Anvil e2e.

### 2.6 Scripts and tests

- `script/Deploy.s.sol`: reads env `OWNER`, `TREASURY`, `OPERATOR`, `GRADUATOR_KIND` (`uniswapv3`|`mock`),
  `WETH9`, `UNIV3_FACTORY`, `UNIV3_POSITION_MANAGER`, `UNIV3_FEE_TIER`; deploys graduator (with a
  temporary launchpad placeholder → use two-step: deploy launchpad with graduator=0, deploy graduator
  pointing at launchpad, then `setGraduator`). Logs addresses, writes `deployments/<chainId>.json`.
- `script/GenerateFixtures.s.sol` (or a test with `vm.writeJson`): writes `packages/shared/fixtures/curve.json`
  with ≥ 40 cases (buy/sell/complete) `{ "realEthReserve", "tokensSold", "op", "amountIn", "tokensOut|ethOut", "ethUsed", "fee" }`.
- `test/`: unit + fuzz + invariant tests. Must cover: curve math monotonicity and rounding (buy then
  sell never profits), completion & refund, fee split, graduation with MockGraduator and with a
  `MockPositionManager/MockFactory/MockWETH` for `UniswapV3Graduator` (including price-deviation
  revert and leftover crediting), draw limits & epochs, retire/withdraw, pause scope, access control,
  reentrancy (malicious receiver), events. Invariants: `address(launchpad).balance >= Σ realEthReserve + Σ mindBalance + protocolBalance`;
  token balance of launchpad `== TOTAL_SUPPLY - tokensSold` while Bonding.
- `foundry.toml`: `solc_version = "0.8.37"`, cancun, optimizer, `fs_permissions` for fixtures, rpc_endpoints
  and `[etherscan]` blockscout entries from `docs/ROBINHOOD_CHAIN.md`.

---

## 3. `@www-rh/shared` (`packages/shared/`)

Exports (`src/index.ts`):
- `chains.ts`: `robinhoodChain` (4663) and `robinhoodChainTestnet` (46630) via viem `defineChain`
  (rpc urls, blockscout explorer, `contracts.multicall3` = `0xca11bde05977b3631167028862be2a173976ca11`
  guarded behind a note; include `sourceId`).
- `abi.ts`: `mindLaunchpadAbi`, `mindTokenAbi`, `graduatorAbi` as **human-readable ABI via `parseAbi`**
  matching §2 exactly (functions, events, errors). A vitest test compares selectors/topics to
  `contracts/out/MindLaunchpad.sol/MindLaunchpad.json` when that file exists (skipped otherwise).
- `curve.ts`: pure bigint functions `quoteBuy`, `quoteSell`, `priceOf`, `marketCap`, `progressBps`
  (= `tokensSold·10000/CURVE_SUPPLY`), constants from §1. Fixture test against `fixtures/curve.json`.
- `models.ts`: catalog `MODELS: ModelSpec[]` with `{ id: 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-4-5' | 'claude-fable-5-1', label, modelIdHash: keccak256(toHex(id)) as bytes32, inputUsdPerMTok, outputUsdPerMTok, cacheReadUsdPerMTok, cacheWriteUsdPerMTok, supportsFallbacks }`;
  prices: opus-5-5 4/20 (cache read 0.20, write 5), sonnet-5-5 2/10 (0.20, 2.5), haiku-4-5 1/5 (0.10, 1.25), fable-5-1 10/50 (0.25, 12.5).
  `DEFAULT_MODEL = 'claude-opus-5-5'`. Helpers `modelById(hash)`, `modelIdToHash(id)`.
- `types.ts`: API DTOs (§5) and WS messages (§6) as TS types + zod schemas.
- `addresses.ts`: per-chainId known addresses (WETH9, Uniswap v3 factory/NPM from `docs/ROBINHOOD_CHAIN.md`),
  and `launchpadAddress(chainId)` reading from `deployments/<chainId>.json` if present.

---

## 4. Runner (`runner/`)

Node 22 ESM TypeScript service. Entry `src/main.ts` (`pnpm --filter @www-rh/runner start`).
Env (`.env.example` at repo root, documented): `CHAIN_ID` (46630), `RPC_URL`, `LAUNCHPAD_ADDRESS`,
`OPERATOR_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `ETH_USD_PRICE` (fallback) / `ETH_USD_FEED` (Chainlink
AggregatorV3 address, optional), `DB_PATH` (`./data/runner.sqlite`), `PORT` (8787), `MAX_CONCURRENT_MINDS` (3),
`TICK_INTERVAL_MS` (20000), `TICK_MAX_ITERATIONS` (8), `MIN_TICK_BUDGET_USD` (0.05), `DRAW_THRESHOLD_USD` (2),
`ANCHOR_EVERY_N_MEMORIES` (5), `BROWSER_HEADLESS` (true), `FRAME_FPS` (1), `START_BLOCK`, `DRY_RUN` (no txs),
`PUBLIC_WEB_ORIGIN` (CORS).

### 4.1 Modules

- `chain/clients.ts`: viem `publicClient` (http, polling) + `walletClient` (operator account). `chain/launchpad.ts`: typed read/write helpers (`getMind`, `getCurve`, `mindBalance`, `drawCompute`, `anchorMemory`, `setMindStatus`, `graduate`, `harvest`).
- `indexer/`: polls `getLogs` for all §2 events from `lastProcessedBlock` in ranges (≤ 2000 blocks), idempotent by `(txHash, logIndex)`. Tables: `minds`, `curves`, `trades`, `fee_accruals`, `fundings`, `draws`, `anchors`, `indexer_state`. Emits in-process events (`mind:created`, `mind:funded`, `trade`, `curve:complete`, `graduated`).
- `economics/`: `ethUsd()` (feed or fixed); `costOfUsage(model, usage)` in USD micro-cents from `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`; `Budget`: `available = onchainMindBalanceWei·ethUsd - unsettledSpendUsd`; a mind is runnable when `available >= MIN_TICK_BUDGET_USD`; `settle()` when `unsettledSpend >= DRAW_THRESHOLD_USD` → `drawCompute(token, weiEquivalent, operator, receiptHash)` where `receiptHash = keccak256(JSON ledger of the ticks being settled)`; the ledger is persisted (`compute_ledger` table) and served by the API so draws are auditable. Never draw more than spent; never exceed the on-chain epoch cap (catch `DrawLimitExceeded` and retry next epoch).
- `browser/`: single Chromium (`chromium.launch`), one `BrowserContext` per active mind (viewport 1280×800, UA default, JS on, downloads blocked, `route()` blocking `file:`, private/loopback IPs, `data:` navigations, non-http(s) schemes). `MindBrowser` actions: `navigate(url)`, `read()` → `{ url, title, text (≤ 6000 chars, readability-style: main/article/body innerText collapsed), links: [{i, text, href}] (≤ 60) }`, `click(linkIndex | cssSelector)`, `type(selector, text, submit?)`, `scroll('up'|'down')`, `back()`, `screenshot()` → JPEG (quality 55, ≤ 900px wide) base64. Frames are also pushed to the stream bus at `FRAME_FPS` while a tick is running (and once after each action).
- `memory/`: `memories(mind, seq, kind: 'note'|'finding'|'thought', content, url, created_at, content_hash)` + FTS (use `fts5` if the sqlite build supports it; fall back to `LIKE`). `remember(mind, kind, content, url)`, `recall(mind, query, limit)`, `recent(mind, n)`. Anchoring: every `ANCHOR_EVERY_N_MEMORIES` memories → `anchorMemory(token, seq, keccak256(canonical JSON of the batch), 'runner://memories/<token>/<fromSeq>-<toSeq>')` (tx skipped in `DRY_RUN`).
- `mind/persona.ts`: builds the system prompt (stable prefix, cached with `cache_control`): identity ("You are the mind of $SYMBOL ($name), a coin living on Robinhood Chain…"), the creator's persona text, the rules (explore the open web, be curious and honest, record findings with `remember`, share short public thoughts with `think_aloud`; never log in, never enter personal data, never buy anything, never attempt to bypass blocks; your compute is paid by the coin's trading fees — you exist while the vault lasts), and a dynamic trailer (date, budget remaining, last 10 memories, current URL) placed **after** the cached prefix.
- `mind/tools.ts`: `betaZodTool` definitions wrapping browser + memory: `browse_navigate`, `browse_read`, `browse_click`, `browse_type`, `browse_scroll`, `browse_back`, `browse_screenshot` (returns an image block for vision), `remember`, `recall`, `think_aloud`. Spread `eager_input_streaming: true` on each (streaming runner). Validate URLs again inside `run`.
- `mind/tick.ts`: one tick = `client.beta.messages.toolRunner({ model, max_tokens: 16000, system: [...cached], messages: [{role:'user', content: 'Continue living. …'}], tools, stream: true, max_iterations: TICK_MAX_ITERATIONS, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' }, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })` — `fallbacks` only for models whose catalog entry has `supportsFallbacks` (opus-5-5, sonnet-5-5, fable-5-1); haiku-4-5 uses `thinking: { type: 'enabled', budget_tokens: 2048 }` and no fallbacks. Apply the stop-reason rules from the SDK guidance (stop on `refusal`; on `max_tokens` with a `tool_use`, abort the tick; re-issue once on unparsable JSON). Stream text deltas and summarized thinking to the bus as `thought` events; tool calls as `action` events. Sum `usage` of every iteration → `costOfUsage` → ledger row per tick. Persist a compact transcript (`ticks` table: id, mind, started_at, model, iterations, cost_usd, summary).
- `mind/scheduler.ts`: every `TICK_INTERVAL_MS` pick up to `MAX_CONCURRENT_MINDS` runnable minds (status Alive, phase any, budget ok) by least-recently-ticked; run ticks concurrently; after each tick re-check budget — if not runnable set status `Dormant` on-chain (operator tx; skip in DRY_RUN) and emit `status`; on `mind:funded` or `trade` events for a Dormant mind with budget → set `Alive`. Also: when a curve reaches `Complete`, call `graduate(token)` from the operator (best-effort, skip if someone else did); every `HARVEST_INTERVAL` (default 6h) call `harvest` for graduated minds (DRY_RUN-aware).
- `api/`: Hono on `@hono/node-server`, CORS for `PUBLIC_WEB_ORIGIN`, JSON per §5; `ws` server at `/ws` per §6.
- `main.ts`: start indexer → API → scheduler; graceful shutdown closes browser.

### 4.2 Tests (vitest)

Curve mirror vs fixtures; `costOfUsage` and `Budget` policy (table-driven); URL safety filter;
page text extraction on a static HTML (Playwright, headless — skip if the browser is missing);
indexer idempotency against a fake log source; API handlers with an in-memory DB; tool input
validation (bad URL rejected). No test may call the Anthropic API or a real RPC.

---

## 5. HTTP API (runner, JSON)

Base `/api`. All addresses lowercase hex; bigints as decimal strings; timestamps ISO-8601.

- `GET /health` → `{ ok, chainId, launchpad, lastIndexedBlock, headBlock, activeMinds, dryRun }`
- `GET /minds?sort=created|mcap|activity&limit=50&cursor=` → `{ items: MindSummary[], nextCursor }`
- `GET /minds/:token` → `MindDetail`
- `GET /minds/:token/trades?limit=100` → `Trade[]`
- `GET /minds/:token/memories?limit=50&before=seq` → `Memory[]`
- `GET /minds/:token/thoughts?limit=100` → `Thought[]` (think_aloud + tick summaries)
- `GET /minds/:token/compute` → `{ balanceWei, balanceUsd, burnUsdPerHour, runwayHours, ledger: LedgerEntry[], draws: Draw[] }`
- `GET /minds/:token/frame.jpg` → last frame (image/jpeg) or 404
- `GET /models` → `ModelSpec[]` (public fields only)
- `GET /stats` → `{ minds, alive, graduated, volumeEthTotal, feesToMindsEth }`

```ts
type MindSummary = { token, name, symbol, creator, metadataURI, image?, modelId, model: string, status: 'alive'|'dormant'|'retired',
  phase: 'bonding'|'complete'|'graduated', priceWei, marketCapWei, progressBps, realEthReserve, tokensSold,
  mindBalanceWei, lastTickAt?, currentUrl?, createdAt, trades24h, volume24hWei }
type MindDetail = MindSummary & { personaHash, pool?, positionId?, description?, persona?: string /*from metadata if resolvable*/, lastFrameAt? }
type Trade = { txHash, logIndex, blockNumber, timestamp, trader, isBuy, ethAmount, tokenAmount, fee, priceWei }
type Memory = { seq, kind, content, url?, createdAt, contentHash, anchorTx? }
type Thought = { id, tickId, kind: 'thought'|'summary', text, createdAt }
type LedgerEntry = { tickId, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd, settledTx? }
type Draw = { txHash, amountWei, to, receiptHash, timestamp }
```

## 6. WebSocket protocol (`/ws?token=0x…`)

Server → client JSON messages (`type` discriminated):
`{ type:'hello', token, status, phase, lastFrame?: base64 }`,
`{ type:'frame', jpegBase64, url, at }` (throttled to `FRAME_FPS`),
`{ type:'thought', text, delta: boolean, tickId, at }`,
`{ type:'action', tool, input (redacted ≤ 300 chars), at }`,
`{ type:'memory', memory: Memory }`,
`{ type:'status', status, phase, at }`,
`{ type:'budget', balanceWei, balanceUsd, burnUsdPerHour, at }`,
`{ type:'trade', trade: Trade }`.
Client → server: `{ type:'subscribe', token }` (also via query), `{ type:'ping' }`. Server pings every 25 s.

---

## 7. Web (`web/`)

Vite + React 19 + TypeScript + react-router + wagmi 3 (injected connector + WalletConnect optional via env) + viem + TanStack Query + Tailwind v4 (`@tailwindcss/vite`). Chains from `@www-rh/shared`; `VITE_CHAIN_ID`, `VITE_LAUNCHPAD_ADDRESS`, `VITE_RUNNER_URL` (http), `VITE_RUNNER_WS` (ws). Dark, terminal-ish aesthetic ("every coin has a mind" header), Russian/English toggle not required; UI copy in English with a RU README.

Routes:
- `/` — grid of `MindSummary` cards: image, name/$symbol, status dot (alive = pulsing green), model badge, price & mcap (ETH), progress bar to graduation, live thumbnail (latest frame via `frame.jpg` refreshed every 5 s), "feed the mind" micro-button. Sort tabs: new / mcap / active. Header: wallet connect, chain switch ("Add Robinhood Chain"), stats strip.
- `/create` — form: name, symbol, image URL, description, **model select** (from `/models` with price hint), persona textarea (becomes `personaHash` and is embedded in the metadata JSON), initial buy (ETH) with quote preview, optional "seed compute" (ETH → `fundMind` after creation). Metadata JSON is uploaded via `POST /api/metadata` (runner stores it and returns `runner://metadata/<hash>` + it is also embedded as a `data:application/json;base64,…` URI fallback if the runner is unavailable). Then `createMind(...)` with `value = creationFee + initialBuy`.
- `/mind/:token` — three columns: (1) **stream**: live frame canvas (WS `frame`), current URL, thoughts ticker (WS `thought`), action log; (2) **trade**: curve stats (price, mcap, progress, reserve), buy/sell panel with quotes from `quoteBuy/quoteSell` reads, slippage (default 1 %), deadline, approve-then-sell flow, graduate button when `Complete`, Uniswap link when `Graduated`; (3) **mind**: model, persona, compute meter (balance ETH/USD, burn/h, runway), "feed the mind" (fundMind), memories list (anchor tx links), creator tools (change model/persona, retire) when connected as creator. Recent trades table below.

All contract writes go through wagmi `useWriteContract` with `mindLaunchpadAbi`; reads via `useReadContract`/`useReadContracts`; explorer links use the chain's blockExplorer. Vite dev proxy `/api` and `/ws` → runner.

## 8. Docs, CI, ops

- `README.md` (RU, with EN summary): what it is, architecture, quickstart (anvil → deploy → runner → web), env vars, links to docs.
- `docs/DEPLOY.md` (RU): testnet and mainnet steps: faucets, `forge script … --rpc-url … --broadcast --verify --verifier blockscout`, filling env, running the runner (docker compose), operator key funding, harvest/graduate ops, risks.
- `docker-compose.yml`: `runner` (node:22 image + playwright chromium deps) and `web` (static build served by nginx or `serve`).
- `.github/workflows/ci.yml`: forge fmt check + forge test; pnpm install, typecheck, vitest, web build.
- Root `package.json` scripts: `build`, `test`, `typecheck`, `lint`, `abi:sync` (copies ABI JSON from `contracts/out` into `packages/shared/abi/*.json` for the equivalence test), `dev:runner`, `dev:web`, `anvil:e2e` (spins anvil, deploys with MockGraduator, runs the runner in DRY_RUN against it).
