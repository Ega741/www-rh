# www-rh contracts

Foundry project for the Robinhood Chain (Arbitrum Orbit, chain id 4663 / testnet 46630) launchpad where
every coin funds an AI "mind" from its trading fees. Normative description: `docs/SPEC.md` §1–§2 (in-house curve)
and §9 (Pons mode); chain addresses: `docs/ROBINHOOD_CHAIN.md`.

Two venues share one core (`MindCore`): **Pons mode** (`PonsMindRegistry`, the mainnet path: minds are layered on
Pons V2 launches and paid from the creator fees Pons already distributes) and the **in-house curve**
(`MindLaunchpad`, testnet/anvil, `VENUE=curve`).

| Contract | Role |
|---|---|
| `src/MindCore.sol` | Abstract venue-independent core: roles (`Ownable2Step`, renounce disabled; operator, treasury, compute treasury), `Pausable`, `ReentrancyGuard`, mind registry (`MindInfo`, creator config/pause, operator status), mind vault (`fundMind`, epoch-capped `drawCompute`, `MAX_DRAW_PER_EPOCH`), protocol balance and withdrawal, `anchorMemory`, the gated/counted `receive()` return window. Interface: `src/interfaces/IMindCore.sol`. |
| `src/PonsMindRegistry.sol` | Pons mode (SPEC §9.2): `MindCore` + Pons V2. `launchMind` launches a Pons token whose creator fee recipient is a fresh `MindAccount` clone (native quote, buyback off, the creator snipe-exempt, initial buy refunds forwarded in the same tx); `prepareAdoption` (anyone; one `MindAccount` per (token, preparer), nothing registered yet) / `activateAdoption(token, preparer)` adopt an existing Pons token once the Pons creator fee recipient points at the preparer's account (registers the mind on first adoption, or takes it over when the previous creator left); `leave` harvests earned fees into the vault, then hands the fee stream to a validated recipient and marks the mind as left (SPEC §9.7); `recoverAccountTokens` returns ERC-20s stuck on the account to the creator; pool ids are derived from the Uniswap v4 PoolKey (`derivedPoolId`); `harvest` sweeps Pons fees best-effort and claims the account's escrow balance into the vault (optional `mindFeeBps` protocol cut). |
| `src/MindAccount.sol` | EIP-1167 clone target: the per-mind creator fee recipient. Registry-only `claim` (escrow → registry return window), `sweepCurve`, `sweepPool`, `transferFeeRecipient`. |
| `src/interfaces/pons/` | Minimal hand-written Pons V2 interfaces (`IPonsV2LaunchFactory`, `IPonsV2BondingCurve`, `IPonsV2FeeEscrow`, `IPonsV2MemeHook`) with the SPEC §9.1 members only; struct layouts match the deployed contracts. Pons' own contracts are outside this repository's audit. |
| `src/MindLaunchpad.sol` | Token factory, constant-product bonding curve with virtual reserves, fee router, mind vault, registry. `Ownable2Step` (renounce disabled), `Pausable` (createMind/buy only), `ReentrancyGuard`. A `Complete` curve not graduated within `graduationGrace` (default 1 day) accepts sells again (they reopen it). |
| `src/MindToken.sol` | Plain ERC20 + ERC20Permit; the full supply (1e9) is minted to the launchpad. |
| `src/UniswapV3Graduator.sol` | Moves `LP_SUPPLY` + the curve ETH into a full-range Uniswap v3 position owned forever by the graduator; harvests fees (ETH → mind vault, tokens → `0x…dEaD`). A pre-created pool at another price is first swapped back towards the price implied by the amounts (at most half of the sold side, `GraduatedAtSkewedPrice`); if it is still outside `priceToleranceBps` (default 1 %) graduation reverts `PoolPriceSkewed` and can be retried. |
| `src/MockGraduator.sol` | Graduator for testnets without Uniswap v3 and local runs: keeps ETH and tokens, returns `(address(this), 0, 0)`. |
| `src/libraries/CurveMath.sol` | Pure curve math (quotes, price, fee split, `minEthToComplete`), shared by the launchpad, the views and the fixture generator; mirrored bit-for-bit by `@www-rh/shared` `curve.ts`. |
| `src/interfaces/` | `IMindCore` (shared types, events, errors, functions), `IMindLaunchpad is IMindCore` (curve surface), `IPonsMindRegistry is IMindCore`, `IGraduator`, minimal hand-written Uniswap v3 (`uniswap/`) and Pons V2 (`pons/`) interfaces. |

Money flows in short: every trade fee is split `mindShareBps` (70 %) to the coin's mind vault and the rest to
`protocolBalance`; graduation takes `graduationFeeBps` (2.5 %) of the reserve with the same split. ETH comes back
from a graduator only through the launchpad's `receive()`, which accepts ETH only from the graduator that
`graduate`/`harvest` is calling at that moment and counts it; the call must report exactly the counted amount
(`EthReturnMismatch()` otherwise), which is credited to the vault (`fundMind` is `nonReentrant`, so nothing can be
credited twice). Vault ETH leaves only through `drawCompute` (operator, epoch-capped, cap ≤ 2 ETH per epoch) to
`computeTreasury`.

Pons mode money flows: `launchMind` takes exactly `factory.launchFee() + quoteIn + creationFee()`; the launch fee
goes to Pons, `quoteIn` buys on the Pons curve for the creator (the unspent part of a capped final buy comes back to
the registry's `receive()` while a window is open for that curve only, and is forwarded to the creator in the same
transaction), the creation fee stays as `protocolBalance`. Pons credits each sweep's creator share (and the full
creator tax) to the mind's `MindAccount` in its fee escrow; `harvest(token)` first tries to sweep (the curve through
the account, which Pons authorizes as the current creator fee recipient, then directly for minds launched here; the
graduated pool through the account once the operator recorded its `poolId`), each attempt in try/catch, then opens a
return window for the account, which claims from the escrow and forwards its whole balance; the counted amount must
equal what the account reports (`EthReturnMismatch()`), `mindFeeBps` of it goes to `protocolBalance` and the rest to
the vault. Invariant: `registry.balance == Σ mindBalance + protocolBalance`.

## Setup

```bash
export PATH=/root/.foundry/bin:$PATH FOUNDRY_SOLC=/usr/local/bin/solc FOUNDRY_DISABLE_NIGHTLY_WARNING=1
cd contracts
```

`FOUNDRY_SOLC` points forge at a local solc 0.8.37 (drop it where forge can download compilers).
Dependencies are vendored in `lib/` (forge-std, OpenZeppelin 5.6.1); no npm packages are used.

## Build, test, inspect

```bash
forge fmt                      # format (CI: forge fmt --check)
forge build                    # compile (lint runs on build; src/ is warning-free)
forge build --sizes            # runtime: MindLaunchpad ~21 KB, PonsMindRegistry ~17.5 KB (< 24 KB limit)
forge test -vv                 # unit + fuzz (512 runs) + invariant (64 x 32) tests
FOUNDRY_PROFILE=ci forge test  # 2048 fuzz runs, 256 x 64 invariant runs
forge test --match-contract UniswapV3GraduatorTest -vvv
forge inspect MindLaunchpad abi --json > /tmp/MindLaunchpad.abi.json
forge inspect PonsMindRegistry abi --json > /tmp/PonsMindRegistry.abi.json
forge inspect MindAccount abi --json > /tmp/MindAccount.abi.json
forge inspect MindLaunchpad storageLayout
ROBINHOOD_RPC_URL=https://… forge test --match-path test/fork/PonsFork.t.sol -vv   # live Pons V2 (skipped without the URL)
```

Test suites (`test/`):

| File | Covers |
|---|---|
| `CurveMath.t.sol` | round trips never profit (buy→sell, sell→buy), `x·y` never decreases, price monotone, completion exactness (`minEthToComplete`), 1-wei rounding guard, fee split |
| `MindLaunchpad.Trading.t.sol` | createMind validation/creation fee/initial buy, buy/sell vs quotes, completion with refund, minimal completing amount and −1/−2 wei, rounding guard on-chain, fee split + `FeeAccrued`, events |
| `MindLaunchpad.Graduation.t.sol` | graduation via `MockGraduator`, returned ETH credit + `MindFunded`, `EthReturnMismatch` (graduate and harvest), the ETH return counter (no double credit through `fundMind`, forced ETH not counted, 2300-gas returns fail, returns from other addresses rejected, split returns summed), `GraduatorNotSet`, `graduatorOf` vs `setGraduator`, `setGraduator` sanity checks, `receive()` gating (`DirectEthNotAccepted`) |
| `MindLaunchpad.EscapeHatch.t.sol` | `completedAt`, `graduationGrace` and its setter, sells/quotes blocked during the grace, post-grace sells reopening the curve (`CurveReopened`), buys staying Bonding-only, re-completion and graduation afterwards, holders exiting when graduation is impossible |
| `MindLaunchpad.Vault.t.sol` | `fundMind`, `drawCompute` epoch caps/reset/`computeTreasury` payee/any status, creator pause vs operator status rules, `setMindConfig`, `anchorMemory` |
| `MindLaunchpad.Admin.t.sol` | constructor, owner setters and bounds (`MAX_DRAW_PER_EPOCH`, 2x burst bound), access control for every restricted function, pause scope, protocol fee withdrawal, Ownable2Step, `renounceOwnership` disabled |
| `Reentrancy.t.sol` | `ReentrantReceiver` re-entering on sell, completing-buy refund, draw and withdrawal |
| `UniswapV3Graduator.t.sol` | realistic Uniswap v3 models, both token orderings, fresh / uninitialized / exact / skewed / extremely skewed / fuzzed pre-set prices (free correction), corrections trading against attacker liquidity (attacker loses at the fair price), `PoolPriceSkewed` when the attacker is deeper than the cap (retry after arbitrage), swap callback authorization, tolerance and mint minimums, leftovers credited and burned, harvest (seeded and real swap fees), access control |
| `invariant/LaunchpadInvariants.t.sol` | `balance >= Σ realEthReserve + Σ mindBalance + protocolBalance` (and exact equality), launchpad token balance `== TOTAL_SUPPLY - tokensSold` while Bonding, `k` never decreases, draw cap, `completedAt` vs phase; the handler also sells on Complete curves after the grace |
| `Fixture.t.sol` | the checked-in `curve.json` is up to date, matches `CurveMath`, and every case replays on a real launchpad (quotes and executed trades) |
| `Deploy.t.sol` | the deploy script for both graduator kinds, defaults, ownership hand-over, JSON output, `mock` refused on 4663 |
| `PonsMindRegistry.Launch.t.sol` | constructor, `launchMind` value accounting (fuzzed), account clone salts / `AccountExists`, Pons launch parameters (recipient = account, deployer = registry, native quote, buyback off), snipe-tax exemptions, initial buy, capped final buy refund forwarded + auto-graduation, slippage, creation fee, economics guard, `canLaunch`/launch-fee gating, validation, `LaunchFailed`, pause scope |
| `PonsMindRegistry.Adoption.t.sol` | per-preparer preparations (own account each, re-preparation updates the pending config, buyback launches and non-native quotes rejected), `activateAdoption(token, preparer)` only when the recipient is that preparer's account, first adoption registers the mind (`MindCreated` + `MindAdopted`), takeover after `leave` or a moved recipient (config/creator/account replaced), `AlreadyAdopted` while the current account still receives fees, a stale preparer cannot capture a later hand-off; `leave` (earned fees harvested first, recipient validation: zero / registry / mind accounts rejected, status Dormant, left minds cannot be set Alive, vault kept, draws/funding still work); `recoverAccountTokens`; `derivedPoolId` vector |
| `PonsMindRegistry.Harvest.t.sol` | sweep authorization (operator / current recipient only), curve sweep through the account, direct fallback, buyback-pending skip, Swept/PoolCreated phases, `setPoolId`, memecoin fees needing the operator, `createGraduatedPool`, exact claim accounting and `mindFeeBps` split (fuzzed), `EthReturnMismatch`, no double credit through `fundMind`, side-channel ETH and 2300-gas returns rejected, donations forwarded, forced ETH not counted, `receive()` gate |
| `PonsMindRegistry.Admin.t.sol` | MindCore through the registry: funding, draws (caps, epochs, statuses, failing/re-entering treasury), anchors, status rules, config, role setters, access control, protocol fee withdrawal, Ownable2Step, renounce disabled |
| `PonsMindRegistry.Invariant.t.sol` | with `invariant/PonsRegistryHandler.sol`: `registry.balance == Σ mindBalance + protocolBalance`, accounts hold only undelivered donations, no tokens stuck, draw cap, record consistency (launches, adoptions, trades, sweeps, graduation, pool fees, harvests, leave) |
| `DeployPons.t.sol` | `DeployPons` (roles, two-step owner, `canLaunch` report, refusals without Pons addresses or code, 4663 defaults), `DeployPonsLocal` (wiring, mainnet guard, end-to-end launch + harvest), `venue: "curve"` in `Deploy.s.sol` output |
| `fork/PonsFork.t.sol` | live Pons V2 on 4663 (interfaces decode, launch/trade/harvest/leave, adoption); skipped unless `ROBINHOOD_RPC_URL` is set |
| `audit/*.t.sol` | the audit PoCs (`test_POC_*` assert the safe behaviour) and a TickMath sanity check of the Uniswap math port |

Pons V2 models live in `test/mocks/pons/`: `MockPonsFactory` (+ `MockPonsLaunchDeployer`; the real launch checks and
their order, snipe-tax exemptions, `launchTokenFor`, economics digest, two-phase graduation, recipient hand-off),
`MockPonsCurve` (the real fee/tax/cap/refund math, price-bound slippage, auto-graduation, `sweepFees` authorization
and escrow crediting; linear snipe-tax decay and a folded-back buyback are the documented simplifications),
`MockPonsFeeEscrow`, `MockPonsMemeHook` (`registerPool`/`sweepPoolFees` authorization, simulated swap fees) and
`MockPonsToken`. They emit the Pons events, so the runner's indexer works against them on anvil.

Mocks live in `test/mocks/` (`MockWETH9`, `ReentrantReceiver`, `ConfigurableGraduator`, `MaliciousGraduator`) and
`test/mocks/uniswapv3/` (`UniV3Factory`, `UniV3Pool`, `UniV3PositionManager`, `UniV3Math`: Uniswap v3 models with
the real TickMath / LiquidityAmounts / SqrtPriceMath / SwapMath, multi-position liquidity, `swap` with callback and
per-position swap fees).

## Curve fixture

```bash
forge script script/GenerateFixtures.s.sol     # writes ../packages/shared/fixtures/curve.json
cd ../packages/shared && pnpm test              # the TS mirror must reproduce every case
```

Shape (SPEC §2.6): `{ "tradeFeeBps": "100", "cases": [...] }`, every number a decimal string, state *before* the op.
Buys: `{ realEthReserve, tokensSold, op: "buy" | "complete", amountIn (ethIn), tokensOut, ethUsed, fee }` —
`"complete"` marks a buy that sells out the curve (refund = `amountIn - ethUsed`). Sells:
`{ realEthReserve, tokensSold, op: "sell", amountIn (tokensIn), ethOut, fee }`. The 67 cases include fresh-curve
buys from 1 wei, a trading walk that sells back to zero twice, completion from five states (minimal completing
amount, −1 and −2 wei, +1 wei, 10 and 1000 ETH), sells at several states, and extra threshold cases. With the
default 1 % fee the gross-up `net' + fee'` of a completing buy is always exactly one wei above the minimal
completing amount, so every "minimal amount" case exercises the guard (`ethUsed = ethIn`, `fee = ethIn - net'`).
`test/Fixture.t.sol` fails if the file is stale; regenerate after changing `CurveMath` or `script/CurveFixtures.sol`.

## Deploy (Pons mode, mainnet path)

`script/DeployPons.s.sol` deploys `PonsMindRegistry(deployer, TREASURY, COMPUTE_TREASURY, OPERATOR, PONS_FACTORY,
PONS_FEE_ESCROW, PONS_MEME_HOOK)` (it deploys its `MindAccount` implementation), then `transferOwnership(OWNER)` if
`OWNER` ≠ deployer (**`OWNER` must call `acceptOwnership()`**), checks the wiring and writes
`deployments/<chainId>.json`:

```json
{ "accountImplementation": "0x…", "chainId": 4663, "deployedAt": 1790939410,
  "pons": { "factory": "0x…", "feeEscrow": "0x…", "memeHook": "0x…" }, "registry": "0x…", "venue": "pons" }
```

| Env | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | required; broadcaster |
| `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` | role addresses, each defaults to the deployer |
| `PONS_FACTORY`, `PONS_FEE_ESCROW`, `PONS_MEME_HOOK` | default to the Pons V2 mainnet addresses on 4663; required (and must have code) on every other chain, else the script refuses (`MissingPonsAddress` / `PonsAddressHasNoCode`) |
| `DEPLOYMENTS_FILE` | optional output path override |

```bash
OWNER=0x… TREASURY=0x… COMPUTE_TREASURY=0x… OPERATOR=0x… \
  forge script script/DeployPons.s.sol --rpc-url robinhood --broadcast \
  --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
# then, from OWNER: cast send <registry> "acceptOwnership()"
```

Operational notes: `launchMind` requires `factory.canLaunch(registry)` (public launches enabled, or Pons whitelists the
registry; the script logs a warning when it is false; adoption works regardless). Creator fees reach the escrow only on
sweeps: Pons' fee sweep operator, `harvest` through the mind account (the curve's current creator fee recipient) or,
after graduation, through the account as the pool creator once the operator called `setPoolId` from the hook's
`PoolRegistered` log. The runner then calls `harvest` (permissionless). Pons' contracts are outside our audit.

Local anvil with Pons models (`DeployPonsLocal.s.sol`: escrow, hook, factory with launch config 0 = supply 1e9,
`curveFeeBps` 100, phantom quote = graduation threshold = 4.2 ETH, launch fee 0.0005 ETH, public launches open; the
deployer owns the mocks and is Pons' protocol fee recipient and sweep operator; refused on 4663). Same JSON shape:

```bash
anvil --port 8545 &
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  forge script script/DeployPonsLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cat deployments/31337.json
```

## Deploy (in-house curve, testnet / anvil)

`script/Deploy.s.sol` performs the two-step wiring in one broadcast: `MindLaunchpad(deployer, TREASURY,
COMPUTE_TREASURY, OPERATOR)` → graduator(launchpad) → `setGraduator` → (if `OWNER` ≠ deployer)
`transferOwnership(OWNER)` on the launchpad and on a `UniswapV3Graduator`. **Ownable2Step: `OWNER` must then call
`acceptOwnership()` on each contract.** It writes `deployments/<chainId>.json`:

```json
{ "chainId": 46630, "deployedAt": 1790939410, "graduator": "0x…", "graduatorKind": "mock", "launchpad": "0x…",
  "venue": "curve" }
```

| Env | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | required; broadcaster |
| `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` | role addresses, each defaults to the deployer |
| `GRADUATOR_KIND` | `uniswapv3` \| `mock` (default `uniswapv3` on 4663, `mock` elsewhere; `mock` is refused on 4663) |
| `WETH9`, `UNIV3_FACTORY`, `UNIV3_POSITION_MANAGER` | required for `uniswapv3`; default to the 4663 addresses from `docs/ROBINHOOD_CHAIN.md` on mainnet |
| `UNIV3_FEE_TIER` | default `10000` (1 %, tick spacing 200, full range ±887200) |
| `DEPLOYMENTS_FILE` | optional output path override |

Without `--broadcast` the script simulates and writes `deployments/dry-run/<chainId>.json` (gitignored).
Local deployments (`deployments/31337.json`, `broadcast/*/31337/`) are gitignored as well.

Local anvil:

```bash
anvil --port 8545 &
DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 GRADUATOR_KIND=mock \
  forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cat deployments/31337.json
```

Testnet (46630, no public Uniswap v3 → mock graduator):

```bash
GRADUATOR_KIND=mock OWNER=0x… TREASURY=0x… COMPUTE_TREASURY=0x… OPERATOR=0x… \
  forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast \
  --verify --verifier blockscout --verifier-url https://explorer.testnet.chain.robinhood.com/api/
```

Mainnet (4663, Uniswap v3 graduator; Uniswap addresses default from `docs/ROBINHOOD_CHAIN.md`):

```bash
GRADUATOR_KIND=uniswapv3 OWNER=0x… TREASURY=0x… COMPUTE_TREASURY=0x… OPERATOR=0x… \
  forge script script/Deploy.s.sol --rpc-url robinhood --broadcast \
  --verify --verifier blockscout --verifier-url https://robinhoodchain.blockscout.com/api/
# then, from OWNER: cast send <launchpad> "acceptOwnership()" and cast send <graduator> "acceptOwnership()"
```

`robinhood` / `robinhood_testnet` resolve through `[rpc_endpoints]` in `foundry.toml`
(`ROBINHOOD_RPC_URL`, `ROBINHOOD_TESTNET_RPC_URL`). After deploying, run `node scripts/sync-deployments.mjs` at the
repo root to refresh `@www-rh/shared`'s generated deployments map.

## Verify on Blockscout

Blockscout needs no API key (`BLOCKSCOUT_API_KEY` in `foundry.toml` is optional). Use `--chain 4663` with
`https://robinhoodchain.blockscout.com/api/`, or `--chain 46630` with `https://explorer.testnet.chain.robinhood.com/api/`.

```bash
CHAIN=4663; VERIFIER_URL=https://robinhoodchain.blockscout.com/api/
# CHAIN=46630; VERIFIER_URL=https://explorer.testnet.chain.robinhood.com/api/

forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <launchpad> src/MindLaunchpad.sol:MindLaunchpad \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" <deployer> <treasury> <computeTreasury> <operator>)

forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <graduator> src/MockGraduator.sol:MockGraduator \
  --constructor-args $(cast abi-encode "constructor(address)" <launchpad>)

forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <graduator> src/UniswapV3Graduator.sol:UniswapV3Graduator \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,address,uint24)" \
    <deployer> <launchpad> 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA \
    0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 10000)

forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <registry> src/PonsMindRegistry.sol:PonsMindRegistry \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address,address,address,address)" \
    <deployer> <treasury> <computeTreasury> <operator> 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e \
    0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044)
# The MindAccount implementation (created by the registry, no constructor arguments):
forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <accountImplementation> src/MindAccount.sol:MindAccount

# Coins are created by the launchpad (CREATE); verify one with its MindCreated arguments:
forge verify-contract --chain $CHAIN --verifier blockscout --verifier-url $VERIFIER_URL --watch \
  <token> src/MindToken.sol:MindToken \
  --constructor-args $(cast abi-encode "constructor(string,string,address,address)" "<name>" "<symbol>" <launchpad> <creator>)
```

The constructor owner of the launchpad and of the Uniswap graduator is the deployer (ownership moves with
`transferOwnership`/`acceptOwnership`), so use the deployer address in the constructor arguments above.
Compiler settings come from `foundry.toml` (solc 0.8.37, optimizer 200 runs, cancun, `bytecode_hash = "none"`).

## Platform notes

- Arbitrum Orbit: `block.number` is the parent-chain block number, so no contract reads it; deadlines and draw
  epochs use `block.timestamp`.
- ETH is sent with `call` only; every function that sends ETH or calls a graduator, and `fundMind`, is
  `nonReentrant`. The launchpad's `receive()` writes storage, so graduators must return ETH with a full-gas `call`
  (a 2300-gas `transfer`/`send` fails).
- `foundry.toml` silences solc warning 6335 ("`leave` will be promoted to a keyword"): `PonsMindRegistry.leave` is
  named normatively by SPEC §9.2 and compiles fine with the pinned solc 0.8.37.
- If the chain's WETH9 unwraps with a 2300-gas `transfer` (canonical WETH9 does), `UniswapV3Graduator.receive()`
  still works: it only compares `msg.sender` with an immutable.
