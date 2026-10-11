# Beagle contracts

Foundry project for the on-chain side of Beagle (`docs/SPEC.md` §3): `BeagleToken`, `CreditDesk`,
`CreditMath`, `IPriceSource` + `ManualPriceSource` / `ChainlinkPriceSource`, mocks, tests and scripts.

```sh
forge build --sizes          # solc 0.8.28, optimizer 2000 runs
forge test -vvv              # unit + fuzz + invariant tests
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
