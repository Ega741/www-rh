# Развёртывание в Robinhood Chain

Все адреса сети, RPC, обозреватели и фаучеты — в `docs/ROBINHOOD_CHAIN.md`.
Коротко: testnet **46630** (`https://rpc.testnet.chain.robinhood.com/rpc`, Blockscout
`https://explorer.testnet.chain.robinhood.com`), mainnet **4663**
(`https://rpc.mainnet.chain.robinhood.com`, Blockscout `https://robinhoodchain.blockscout.com`).
Газ — ETH.

## 0. Что понадобится

- Foundry (`forge`, `cast`, `anvil`), Node 22, pnpm 10, Docker (для продакшена).
- Три адреса: **owner** (владелец протокола, лучше мультисиг), **treasury** (куда уходит доля
  протокола с комиссий), **computeTreasury** (куда оператор переводит ETH за оплаченные
  вычисления) и **operator** — горячий кошелёк раннера (подписывает `drawCompute`,
  `anchorMemory`, `setMindStatus`, `graduate`, `harvest`). Оператору нужен небольшой запас ETH на газ.
- Ключ Anthropic API для раннера (`ANTHROPIC_API_KEY`).
- Testnet ETH: `https://faucet.testnet.chain.robinhood.com`, `https://faucet.quicknode.com/robinhood/testnet`
  или мост Sepolia → Robinhood Testnet через `https://portal.arbitrum.io/bridge`.

```bash
git clone --recurse-submodules <repo> www-rh && cd www-rh
cp .env.example .env            # заполните значения ниже
pnpm install
cd contracts && forge build && forge test && cd ..
```

## 1. Контракты (двухшаговое связывание)

`MindLaunchpad` деплоится первым (без graduator), затем graduator получает адрес лаунчпада,
затем владелец вызывает `setGraduator`. Скрипт `contracts/script/Deploy.s.sol` делает всё сам
и пишет адреса в `contracts/deployments/<chainId>.json`.

Переменные окружения для скрипта (в `.env` или в shell):

| Переменная | Значение |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | ключ деплоера |
| `OWNER`, `TREASURY`, `COMPUTE_TREASURY`, `OPERATOR` | адреса ролей |
| `GRADUATOR_KIND` | `mock` (testnet без Uniswap v3) или `uniswapv3` (mainnet) |
| `WETH9` | mainnet `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, testnet `0x7943e237c7F95DA44E0301572D358911207852Fa` |
| `UNIV3_FACTORY` | mainnet `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| `UNIV3_POSITION_MANAGER` | mainnet `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` |
| `UNIV3_FEE_TIER` | `10000` (1 %, tickSpacing 200) |

### Testnet (46630)

```bash
cd contracts
export $(grep -v '^#' ../.env | xargs)
GRADUATOR_KIND=mock forge script script/Deploy.s.sol \
  --rpc-url "$ROBINHOOD_TESTNET_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast --verify --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api -vvvv
cat deployments/46630.json
```

Если `--verify` при деплое не прошёл, верифицируйте отдельно:

```bash
forge verify-contract --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api \
  --chain-id 46630 <LAUNCHPAD_ADDRESS> src/MindLaunchpad.sol:MindLaunchpad \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" $OWNER $TREASURY $COMPUTE_TREASURY $OPERATOR)
```

На testnet публичного адреса Uniswap v3 не найдено, поэтому используется `MockGraduator`:
при выпуске (graduation) ликвидность запирается в контракте, `harvest` ничего не возвращает.
Если у вас есть собственный деплой Uniswap v3 на testnet — укажите его адреса и `GRADUATOR_KIND=uniswapv3`.

### Mainnet (4663)

```bash
cd contracts
GRADUATOR_KIND=uniswapv3 \
WETH9=0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73 \
UNIV3_FACTORY=0x1f7d7550B1b028f7571E69A784071F0205FD2EfA \
UNIV3_POSITION_MANAGER=0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3 \
UNIV3_FEE_TIER=10000 \
forge script script/Deploy.s.sol \
  --rpc-url "$ROBINHOOD_RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast --verify --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api -vvvv
```

После деплоя проверьте: `cast call <LAUNCHPAD> "graduator()(address)" --rpc-url $ROBINHOOD_RPC_URL`
и `cast call <LAUNCHPAD> "operator()(address)"`. Владение передаётся через `Ownable2Step`
(`transferOwnership` → `acceptOwnership` с нового адреса).

### Синхронизация адресов и ABI в пакеты

```bash
node scripts/sync-deployments.mjs    # contracts/deployments/*.json -> packages/shared/src/deployments.generated.ts
node scripts/sync-abi.mjs            # contracts/out -> packages/shared/abi/*.json + проверка соответствия ABI
pnpm -r build
```

## 2. Раннер (разум монет)

Заполните в `.env`: `CHAIN_ID`, `RPC_URL`, `LAUNCHPAD_ADDRESS`, `START_BLOCK` (блок деплоя),
`OPERATOR_PRIVATE_KEY`, `ANTHROPIC_API_KEY`, `ETH_USD_PRICE` (или `ETH_USD_FEED` — адрес
Chainlink ETH/USD на Robinhood Chain), `PUBLIC_WEB_ORIGIN`. Для проверки без транзакций и без
модели оставьте `DRY_RUN=true` и пустой `ANTHROPIC_API_KEY`: индексатор и API будут работать,
разумы — нет.

Локально:

```bash
pnpm --filter @www-rh/runner build
cd runner && node dist/main.js           # API на :8787, WS на /ws
node dist/cli.js tick --token 0x...      # один ручной тик разума
```

Docker:

```bash
docker compose up -d --build             # runner:8787 + web:8080 (nginx проксирует /api и /ws)
docker compose logs -f runner
```

Экономика вычислений: раннер считает стоимость каждого тика по `usage` ответа модели и
ценам каталога (`packages/shared/src/models.ts`), накапливает неоплаченный расход и, когда он
превышает `DRAW_THRESHOLD_USD`, вызывает `drawCompute(token, amountWei, receiptHash)`. ETH уходит
в `computeTreasury`; `receiptHash` = keccak256 канонического JSON квитанции, которую отдаёт
`GET /api/minds/:token/compute` — любой может пересчитать хэш. Дневной лимит списаний на монету
задаёт владелец (`setDrawLimit`, по умолчанию 0.25 ETH в сутки).

Темп работы разума ограничивает «регулятор расхода»: интервал тиков подбирается так, чтобы
vault монеты хватило минимум на `TARGET_RUNWAY_DAYS` (14) дней; разум без средств переходит в
`Dormant` и просыпается после сделок или `fundMind`.

## 3. Веб

```bash
VITE_CHAIN_ID=46630 VITE_LAUNCHPAD_ADDRESS=0x... VITE_RUNNER_URL=https://runner.example \
VITE_RUNNER_WS=wss://runner.example/ws pnpm --filter @www-rh/web build
```

Статику из `web/dist` можно раздавать любым хостингом; в docker-compose это делает nginx.

## 4. Операции

- **Выпуск (graduation).** Когда кривая распродана (`phase == Complete`), любой может вызвать
  `graduate(token)`; раннер делает это автоматически. На mainnet graduator создаёт пул
  Uniswap v3 (1 %) и минтит full-range позицию; LP-NFT навсегда остаётся в graduator.
- **Сбор комиссий LP.** `harvest(token)` — permissionless; раннер вызывает раз в
  `HARVEST_INTERVAL_MS`. ETH уходит в vault разума, собранные токены сжигаются.
- **Смена graduator.** `setGraduator` влияет только на будущие выпуски; для уже выпущенных
  монет используется `graduatorOf[token]`.
- **Пауза.** `pause()` останавливает только `createMind` и `buy`; продажи, выпуск, сбор
  комиссий и списания продолжают работать.
- **Комиссии протокола.** `withdrawProtocolFees(to)` — владелец.

## 5. Риски и проверочный список

- Оператор — доверенная роль: он может списывать ETH из vault'ов (в пределах дневного лимита и
  только на `computeTreasury`) и менять статус Alive/Dormant. Храните ключ в секрете, держите на
  нём только газ.
- Пул Uniswap v3 для токена могут создать заранее по искажённой цене. Graduator не блокирует
  выпуск: он добавляет full-range ликвидность по текущей цене пула, остатки возвращает в vault
  и пишет событие `GraduatedAtSkewedPrice`; потеря ограничена арбитражем в момент выпуска.
- Fee-tier 1 % (`tickSpacing 200`) задаётся при деплое graduator и не меняется.
- Проверьте перед mainnet: `forge test` зелёный; адреса WETH9/Uniswap совпадают с
  `docs/ROBINHOOD_CHAIN.md`; `owner` — мультисиг; `setDrawLimit` и `setFeeParams` выставлены;
  раннер работает с `DRY_RUN=false` и видит события (`/api/health`).
