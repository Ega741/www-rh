# www-rh contracts

Foundry project for the Robinhood Chain (Arbitrum Orbit, chain id 4663 / testnet 46630) launchpad where
every coin funds an AI "mind" from its trading fees. Normative description: `docs/SPEC.md` §1–§2;
chain addresses: `docs/ROBINHOOD_CHAIN.md`.

| Contract | Role |
|---|---|
| `src/MindLaunchpad.sol` | Token factory, constant-product bonding curve with virtual reserves, fee router, mind vault, registry. `Ownable2Step`, `Pausable` (createMind/buy only), `ReentrancyGuard`. |
| `src/MindToken.sol` | Plain ERC20 + ERC20Permit; the full supply (1e9) is minted to the launchpad. |
| `src/UniswapV3Graduator.sol` | Moves `LP_SUPPLY` + the curve ETH into a full-range Uniswap v3 position owned forever by the graduator; harvests fees (ETH → mind vault, tokens → `0x…dEaD`). A pre-created pool at a skewed price never blocks graduation (`GraduatedAtSkewedPrice`). |
| `src/MockGraduator.sol` | Graduator for testnets without Uniswap v3 and local runs: keeps ETH and tokens, returns `(address(this), 0, 0)`. |
| `src/libraries/CurveMath.sol` | Pure curve math (quotes, price, fee split, `minEthToComplete`), shared by the launchpad, the views and the fixture generator; mirrored bit-for-bit by `@www-rh/shared` `curve.ts`. |
| `src/interfaces/` | `IMindLaunchpad` (types, events, errors, full external interface), `IGraduator`, minimal hand-written Uniswap v3 interfaces (`uniswap/`). |

Money flows in short: every trade fee is split `mindShareBps` (70 %) to the coin's mind vault and the rest to
`protocolBalance`; graduation takes `graduationFeeBps` (2.5 %) of the reserve with the same split. ETH comes back
from a graduator only through the launchpad's `receive()`, which accepts ETH from addresses ever set as graduator
and does no accounting; `graduate`/`harvest` check the exact balance change (`EthReturnMismatch()` otherwise) and
credit the vault. Vault ETH leaves only through `drawCompute` (operator, epoch-capped) to `computeTreasury`.

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
forge build --sizes            # MindLaunchpad runtime ~20 KB (< 24 KB limit)
forge test -vv                 # unit + fuzz (512 runs) + invariant (64 x 32) tests
FOUNDRY_PROFILE=ci forge test  # 2048 fuzz runs, 256 x 64 invariant runs
forge test --match-contract UniswapV3GraduatorTest -vvv
forge inspect MindLaunchpad abi --json > /tmp/MindLaunchpad.abi.json
forge inspect MindLaunchpad storageLayout
```

Test suites (`test/`):

| File | Covers |
|---|---|
| `CurveMath.t.sol` | round trips never profit (buy→sell, sell→buy), `x·y` never decreases, price monotone, completion exactness (`minEthToComplete`), 1-wei rounding guard, fee split |
| `MindLaunchpad.Trading.t.sol` | createMind validation/creation fee/initial buy, buy/sell vs quotes, completion with refund, minimal completing amount and −1/−2 wei, rounding guard on-chain, fee split + `FeeAccrued`, events |
| `MindLaunchpad.Graduation.t.sol` | graduation via `MockGraduator`, returned ETH credit + `MindFunded`, `EthReturnMismatch` (graduate and harvest), `GraduatorNotSet`, `graduatorOf` vs `setGraduator`, `receive()` gating (`DirectEthNotAccepted`) |
| `MindLaunchpad.Vault.t.sol` | `fundMind`, `drawCompute` epoch caps/reset/`computeTreasury` payee/any status, creator pause vs operator status rules, `setMindConfig`, `anchorMemory` |
| `MindLaunchpad.Admin.t.sol` | constructor, owner setters and bounds, access control for every restricted function, pause scope, protocol fee withdrawal, Ownable2Step |
| `Reentrancy.t.sol` | `ReentrantReceiver` re-entering on sell, completing-buy refund, draw and withdrawal |
| `UniswapV3Graduator.t.sol` | Uniswap v3 mocks, both token orderings, fresh / uninitialized / exact / skewed / extremely skewed pools, leftovers credited and burned, harvest crediting and burning, access control |
| `invariant/LaunchpadInvariants.t.sol` | `balance >= Σ realEthReserve + Σ mindBalance + protocolBalance` (and exact equality), launchpad token balance `== TOTAL_SUPPLY - tokensSold` while Bonding, `k` never decreases, draw cap |
| `Fixture.t.sol` | the checked-in `curve.json` is up to date, matches `CurveMath`, and every case replays on a real launchpad (quotes and executed trades) |
| `Deploy.t.sol` | the deploy script for both graduator kinds, defaults, ownership hand-over, JSON output |

Mocks live in `test/mocks/` (`MockWETH9`, `MockUniswapV3Factory`, `MockUniswapV3Pool`,
`MockNonfungiblePositionManager`, `ReentrantReceiver`, `ConfigurableGraduator`).

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

## Deploy

`script/Deploy.s.sol` performs the two-step wiring in one broadcast: `MindLaunchpad(deployer, TREASURY,
COMPUTE_TREASURY, OPERATOR)` → graduator(launchpad) → `setGraduator` → (if `OWNER` ≠ deployer)
`transferOwnership(OWNER)` on the launchpad and on a `UniswapV3Graduator`. **Ownable2Step: `OWNER` must then call
`acceptOwnership()` on each contract.** It writes `deployments/<chainId>.json`:

```json
{ "chainId": 46630, "deployedAt": 1790939410, "graduator": "0x…", "graduatorKind": "mock", "launchpad": "0x…" }
```

| Env | Meaning |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | required; broadcaster |
| `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` | role addresses, each defaults to the deployer |
| `GRADUATOR_KIND` | `uniswapv3` \| `mock` (default `uniswapv3` on 4663, `mock` elsewhere) |
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
- ETH is sent with `call` only; every function that sends ETH or calls a graduator is `nonReentrant`.
- If the chain's WETH9 unwraps with a 2300-gas `transfer` (canonical WETH9 does), `UniswapV3Graduator.receive()`
  still works: it only compares `msg.sender` with an immutable.
