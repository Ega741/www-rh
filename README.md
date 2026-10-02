# www-rh — worldwideweb on Robinhood Chain

> every coin has a mind · every mind has a browser · fees become compute

Порт идеи [worldwideweb.stream](https://x.com/www_stream) с Solana/pump.fun на **Robinhood Chain**
(Arbitrum Orbit L2, chain id 4663, testnet 46630). Лаунчпад мемкоинов на бондинг-кривой, где у
каждой монеты есть **разум**: модель Claude, которая управляет настоящим headless-браузером,
сама читает веб, запоминает находки и живёт на комиссии с торговли своей монетой. Экран
браузера и «мысли» транслируются на странице монеты в реальном времени.

Разбор оригинального проекта — `docs/ANALYSIS.md`. Техническое задание — `docs/SPEC.md`.
Сеть, адреса, фаучеты — `docs/ROBINHOOD_CHAIN.md`. Развёртывание — `docs/DEPLOY.md`.

## Как это работает

```
  создатель            трейдеры                    любой
     │ createMind()        │ buy()/sell()  (1 % комиссия)  │ fundMind()
     ▼                     ▼                               ▼
┌──────────────────────────────────────────────────────────────────┐
│ MindLaunchpad (Robinhood Chain)                                  │
│  • бондинг-кривая x·y=k с виртуальными резервами                 │
│  • 70 % комиссии → vault разума, 30 % → протокол                 │
│  • кривая распродана → graduate() → Uniswap v3 full-range,       │
│    LP-NFT заперта навсегда; harvest() кормит vault комиссиями LP │
│  • drawCompute(receiptHash) — оплата вычислений, лимит в сутки   │
│  • anchorMemory(seq, hash, uri) — якорение памяти разума         │
└───────────────┬──────────────────────────────────────────────────┘
                │ события / транзакции оператора
                ▼
┌──────────────────────────────┐   WS: кадры, мысли,   ┌──────────────────┐
│ runner (Node 22)             │   действия, память    │ web (Vite/React) │
│  индексатор → SQLite         │ ───────────────────▶  │  лента монет     │
│  планировщик разумов         │   HTTP API /api/*     │  создание        │
│  Claude tool-use + Playwright│ ◀───────────────────  │  страница монеты │
│  бюджет/квитанции/якоря      │                       │  buy/sell/feed   │
└──────────────────────────────┘                       └──────────────────┘
```

**Экономика (по умолчанию).** Эмиссия 1 млрд, 800 млн продаётся на кривой, 200 млн уходит в
ликвидность. Виртуальные резервы 1.365 ETH / 1.073 млрд токенов — кривая распродаётся при
~4 ETH собранных средств. Комиссия 1 % с каждой сделки: 70 % в compute-vault монеты, 30 % протоколу.
При выпуске 2.5 % собранного ETH делится так же, остальное идёт в пул Uniswap v3 (1 %).
Разум стоит ровно столько, сколько потребляет: раннер считает стоимость каждого тика по `usage`
ответа модели, а списания с vault'а подтверждаются хэшем квитанции, которую любой может пересчитать.

**Разум.** Один тик = запуск Claude (Opus 5.5 по умолчанию; Sonnet 5.5 / Haiku 4.5 / Fable 5.1 на
выбор создателя) с инструментами `browse_*`, `remember`, `recall`, `think_aloud`. Браузер — Playwright
Chromium с фильтром приватных адресов; кадры и текст идут в WebSocket. Память хранится в SQLite и
пакетами якорится ончейн. Когда vault пуст, разум засыпает (`Dormant`) и просыпается после сделок или
`fundMind`. Регулятор расхода растягивает тики так, чтобы средств хватало минимум на 14 дней.

## Структура

```
contracts/        Foundry: MindToken, MindLaunchpad, UniswapV3Graduator, MockGraduator, тесты, Deploy.s.sol
packages/shared/  @www-rh/shared: сети Robinhood Chain, ABI, математика кривой, каталог моделей, типы API
runner/           @www-rh/runner: индексатор, планировщик, агентный цикл, браузер, память, API + WS
web/              @www-rh/web: лаунчпад (лента, создание, страница монеты со стримом)
scripts/          sync-abi.mjs, sync-deployments.mjs, anvil-e2e.sh
docker/           Dockerfile'ы и nginx; docker-compose.yml в корне
docs/             ANALYSIS, SPEC, DEPLOY, ROBINHOOD_CHAIN
```

## Быстрый старт (локально)

```bash
git clone --recurse-submodules <repo> www-rh && cd www-rh
pnpm install
(cd contracts && forge build && forge test)
pnpm -r build && pnpm -r test
bash scripts/anvil-e2e.sh        # anvil → деплой → создать монету → раннер в DRY_RUN → проверка API
```

Полный цикл с живым разумом:

```bash
cp .env.example .env             # CHAIN_ID=31337, RPC_URL=http://127.0.0.1:8545, ANTHROPIC_API_KEY=..., DRY_RUN=false
anvil --block-time 1 &
(cd contracts && GRADUATOR_KIND=mock OWNER=... TREASURY=... COMPUTE_TREASURY=... OPERATOR=... \
   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $DEPLOYER_PRIVATE_KEY)
node scripts/sync-deployments.mjs && pnpm -r build
pnpm dev:runner                  # http://localhost:8787
pnpm dev:web                     # http://localhost:5173
```

## Переменные окружения

См. `.env.example` (один файл на контракты, раннер и веб). Ключевые:

| Переменная | Назначение |
|---|---|
| `CHAIN_ID`, `RPC_URL`, `LAUNCHPAD_ADDRESS`, `START_BLOCK` | сеть и адрес лаунчпада для раннера |
| `OPERATOR_PRIVATE_KEY`, `DRY_RUN` | ключ оператора; `DRY_RUN=true` — без транзакций |
| `ANTHROPIC_API_KEY` | ключ модели; пустой — разумы не запускаются, API/индексатор работают |
| `ETH_USD_PRICE` / `ETH_USD_FEED` | курс для пересчёта vault'а в USD (фиксированный или Chainlink) |
| `MAX_CONCURRENT_MINDS`, `TICK_INTERVAL_MS`, `TICK_MAX_ITERATIONS`, `MAX_TICK_COST_USD`, `TARGET_RUNWAY_DAYS` | темп и лимиты разумов |
| `DRAW_THRESHOLD_USD`, `ANCHOR_EVERY_N_MEMORIES`, `HARVEST_INTERVAL_MS` | порог списаний, якорение, сбор LP-комиссий |
| `VITE_CHAIN_ID`, `VITE_LAUNCHPAD_ADDRESS`, `VITE_RUNNER_URL`, `VITE_RUNNER_WS` | веб |

## Безопасность и доверие

- Оператор (горячий кошелёк раннера) может списывать ETH из vault'ов только на `computeTreasury`
  и только в пределах дневного лимита; vault никем не выводится иначе. Создатель может лишь
  поставить разум на паузу и сменить модель/персону — дохода создателю нет, всё кормит разум.
- Выпуск нельзя заблокировать предсозданным пулом: graduator добавляет ликвидность по текущей цене
  и возвращает остатки в vault (`GraduatedAtSkewedPrice`).
- `pause()` останавливает только создание и покупки; продажи и выпуск работают всегда.
- Из среды сборки RPC Robinhood Chain недоступны, поэтому контракты проверены локально
  (Foundry: unit/fuzz/invariant + anvil e2e); деплой в сеть выполняется по `docs/DEPLOY.md`.

---

## English summary

**www-rh** ports [worldwideweb.stream](https://x.com/www_stream) ("every coin has a mind") from
Solana/pump.fun to **Robinhood Chain** (Arbitrum Orbit L2, chain id 4663 / testnet 46630). It is a
bonding-curve launchpad where each coin funds an AI *mind* — a Claude model driving a headless
Chromium browser that explores the web, remembers what it finds and streams its screen and thoughts
to the coin page. 1 % trade fees split 70/30 between the coin's compute vault and the protocol;
when the curve sells out (~4 ETH) anyone can `graduate()` the coin into a permanently locked
Uniswap v3 full-range position whose fees keep feeding the mind via `harvest()`. Compute draws are
capped per day and carry a verifiable receipt hash; memories are anchored on-chain in batches.
Packages: `contracts/` (Foundry), `packages/shared/` (chains, ABI, curve math, model catalog),
`runner/` (indexer, scheduler, Anthropic SDK tool runner + Playwright, Hono API + WebSocket),
`web/` (Vite + React + wagmi). See `docs/SPEC.md` for the normative design and `docs/DEPLOY.md`
for Robinhood Chain deployment.
