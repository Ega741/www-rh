# Beagle contracts

Foundry project for the on-chain side of Beagle (`docs/SPEC.md` §3): `BeagleToken`, `CreditDesk`,
`CreditMath`, `IPriceSource` + `ManualPriceSource` / `ChainlinkPriceSource`, mocks, tests and scripts.

```sh
forge build --sizes          # solc 0.8.28, optimizer 2000 runs
forge test -vvv              # unit + fuzz + invariant tests (+ test/Deploy.t.sol runs the deploy script)
FOUNDRY_PROFILE=ci forge test  # 2000 fuzz runs, 200×40 invariant runs
forge fmt --check
```

Scripts (env vars as in SPEC §3.5):

```sh
# anvil: deploy token + price source + desk, force $0.01, write deployments/31337.json
INITIAL_PRICE_E18=10000000000000000 forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --broadcast --private-key <key>
# post a price (poster key)
PRICE_SOURCE=0x… PRICE_E18=… POSTER_PRIVATE_KEY=0x… forge script script/PostPrice.s.sol --rpc-url … --broadcast
# regenerate packages/shared/fixtures/quote.json
forge script script/GenerateFixtures.s.sol
```

`deployments/<chainId>.json` and `out/*.json` feed `scripts/sync-deployments.mjs` / `scripts/sync-abi.mjs`.

`Deploy.s.sol` guards (beyond SPEC §3.5):

- The deployment file is written only when broadcasting (`--broadcast` / `--resume`) or when
  `WRITE_DEPLOYMENT=true`; a dry run logs `dry run: … not written` instead of overwriting a live record with
  simulated addresses. (A broadcast that fails after simulation still leaves the file: re-run with `--resume`.)
- With an existing `TOKEN` and `NATIVE_BURN=true` the script probes `burn(0)` in simulation and refuses with
  `TokenNotBurnable()` when the token has no working `burn(uint256)` (`nativeBurn` is immutable, so such a desk
  could never burn). `NATIVE_BURN_UNCHECKED=true` skips the probe.
- The JSON `owner` is the on-chain owner at deploy time (the deployer) and `pendingOwner` is `OWNER` until
  `acceptOwnership()` is called on both contracts (zero otherwise). `sync-deployments.mjs` ignores `pendingOwner`.

## Refinements relative to SPEC §3.3 / §3.4

Intentional, ABI-visible choices that the spec text leaves open or that harden it; none change the indexed
events or the deployment JSON keys the spec lists.

- **Credit floor.** `burnForCreditMin(workspace, amount, minUsdMicro)` and
  `burnForCreditWithPermitMin(workspace, amount, minUsdMicro, deadline, v, r, s)` behave like the two-argument
  functions but revert `SlippageExceeded(usdMicro, minUsdMicro)` when the quote at inclusion time is below the
  floor (`0` disables it). Clients should pass the quoted value minus a tolerance: a price post landing between
  the UI quote and the transaction otherwise credits less, and the burn is final (SPEC §9). Distinct names
  rather than overloads keep every ABI consumer unambiguous.
- **Freshness is symmetric.** `_price()` rejects an observation with `|block.timestamp − updatedAt| > maxPriceAge`
  as `PriceStale`; the spec's `block.timestamp − updatedAt` would underflow on a future-dated observation, which
  would otherwise count as fresh forever. A source clock slightly ahead of the chain is tolerated.
- **`renounceOwnership()` is disabled** (`RenounceDisabled()`) on `CreditDesk` and `ManualPriceSource`:
  ownership only moves through `transferOwnership` / `acceptOwnership` (Ownable2Step). An ownerless desk could
  never be paused or have its operator/poster rotated.
- **`draw` also reverts `QuoteTooSmall()`** when the quote floors to 0 µUSD (no burn for zero credit); the spec
  lists the check only for `burnForCredit`. `draw(amount == 0)` reverts `BurnTooSmall(0, minBurn)` although
  `minBurn` itself does not apply to draws.
- **Error names not in the spec list.** `setMaxPriceAge(0)` → `BadMaxPriceAge()`; `recoverToken(to == 0)` →
  `ZeroAddress()`; `openBudget(workspace == 0)` → `ZeroAddress()` (the spec's `BadBudgetParams()` covers
  `cap`/`deadline`).
- **`ManualPriceSource.forcePrice(0)` is not a stop switch.** With no price set the rails do not apply
  (SPEC §3.3 "if a price is already set"), so the poster's next `post` re-seeds the price at any value. To halt
  quoting against a compromised poster use `setPoster(address(0))` and/or `CreditDesk.pause()`.
- **Budgets are approvals, not escrow** (SPEC §3.4): a budget owner can revoke the allowance or move tokens
  before a draw, so the operator's post-paid exposure is bounded only by the gateway's draw cadence.
