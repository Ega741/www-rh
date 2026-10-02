# www-rh — worldwideweb on Robinhood Chain

> every coin has a mind · every mind has a browser · fees become compute

Порт идеи [worldwideweb.stream](https://x.com/www_stream) с Solana/pump.fun на **Robinhood Chain**
(Arbitrum Orbit L2, chain id 4663, testnet 46630). У каждой монеты есть **разум**: модель Claude,
которая управляет настоящим headless-браузером, сама читает веб, запоминает находки и живёт на
комиссии с торговли своей монетой. Экран браузера и «мысли» транслируются на странице монеты в
реальном времени.

Как и оригинал поверх pump.fun, на mainnet проект работает **поверх Pons** (ponsfamily.com, лаунчпад
Robinhood Chain): монета запускается на кривой Pons, а 70 % комиссий Pons, причитающиеся создателю,
уходят в vault разума. Собственная бондинг-кривая остаётся режимом для testnet и локальной разработки.

Разбор оригинального проекта — `docs/ANALYSIS.md`. Техническое задание — `docs/SPEC.md`.
Сеть, адреса, фаучеты — `docs/ROBINHOOD_CHAIN.md`. Развёртывание — `docs/DEPLOY.md`.

## Как это работает

```
  создатель                    трейдеры (Pons UI / наш сайт)            любой
     │ launchMind()                 │ buy()/sell() на кривой Pons (1 %)   │ fundMind()
     ▼                              ▼                                     ▼
┌──────────────────────────────┐  ┌──────────────────────────────────────────────┐
│ Pons V2 (mainnet)            │  │ PonsMindRegistry (наш контракт, Robinhood)   │
│  фабрика + кривая + эскроу   │  │  • MindAccount на монету = creatorFeeRecipient│
│  • 30 % комиссии протоколу   │──▶│  • harvest(): claim из эскроу → vault разума │
│  • 70 % → creatorFeeRecipient│  │  • drawCompute(receiptHash) — оплата compute  │
│  • выпуск в Uniswap v4       │  │  • anchorMemory, статусы, пауза создателя     │
└──────────────────────────────┘  └───────────────┬──────────────────────────────┘
                                                  │ события / транзакции оператора
                                                  ▼
┌──────────────────────────────┐   WS: кадры, мысли,   ┌──────────────────┐
│ runner (Node 22)             │   действия, память    │ web (Vite/React) │
│  индексатор → SQLite         │ ───────────────────▶  │  лента монет     │
│  планировщик разумов         │   HTTP API /api/*     │  запуск на Pons  │
│  Claude tool-use + Playwright│ ◀───────────────────  │  страница монеты │
│  бюджет/квитанции/якоря      │                       │  buy/sell/feed   │
└──────────────────────────────┘                       └──────────────────┘
```

Режим `VENUE=curve` (testnet, anvil): вместо Pons используется собственный `MindLaunchpad`
(кривая x·y=k, выпуск на Uniswap v3, 70 % комиссии в vault) — та же схема, те же разумы.

**Экономика Pons.** Комиссия Pons 1 % с каждой сделки до и после выпуска: 30 % протоколу Pons,
70 % получателю creator fee, то есть vault'у разума; создатель может добавить creator tax до 10 %,
который целиком идёт разуму. Выпуск при 4.2 ETH в запертый пул Uniswap v4. Комиссии копятся в
эскроу Pons и забираются `harvest()`.

**Экономика собственной кривой (режим curve).** Эмиссия 1 млрд, 800 млн продаётся на кривой, 200 млн уходит в
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
contracts/        Foundry: MindCore, PonsMindRegistry + MindAccount (Pons), MindLaunchpad + UniswapV3Graduator (curve),
                  моки Pons/Uniswap, тесты, Deploy.s.sol / DeployPons.s.sol
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
| `VENUE` | `pons` (mainnet, по умолчанию на 4663) или `curve` |
| `CHAIN_ID`, `RPC_URL`, `REGISTRY_ADDRESS` / `LAUNCHPAD_ADDRESS`, `START_BLOCK` | сеть и адрес реестра (Pons) или лаунчпада (curve) |
| `HARVEST_MIN_WEI`, `PONS_*` | порог сбора комиссий из эскроу Pons, переопределение адресов Pons |
| `OPERATOR_PRIVATE_KEY`, `DRY_RUN` | ключ оператора; `DRY_RUN=true` — без транзакций |
| `ANTHROPIC_API_KEY` | ключ модели; пустой — разумы не запускаются, API/индексатор работают |
| `ETH_USD_PRICE` / `ETH_USD_FEED` | курс для пересчёта vault'а в USD (фиксированный или Chainlink) |
| `MAX_CONCURRENT_MINDS`, `TICK_INTERVAL_MS`, `TICK_MAX_ITERATIONS`, `MAX_TICK_COST_USD`, `TARGET_RUNWAY_DAYS` | темп и лимиты разумов |
| `DRAW_THRESHOLD_USD`, `ANCHOR_EVERY_N_MEMORIES`, `HARVEST_INTERVAL_MS` | порог списаний, якорение, сбор LP-комиссий |
| `VITE_VENUE`, `VITE_CHAIN_ID`, `VITE_REGISTRY_ADDRESS` / `VITE_LAUNCHPAD_ADDRESS`, `VITE_RUNNER_URL`, `VITE_RUNNER_WS` | веб |

## Безопасность и доверие

- **Pons.** Контракты Pons вне нашего аудита; мы полагаемся на их эскроу и свипы комиссий
  (оператор Pons, либо наш реестр как deployer монеты). `PonsMindRegistry` держит только
  `Σ vault + protocolBalance`; клон `MindAccount` не имеет функций кроме claim/sweep/перевода
  получателя по команде реестра.
- **Независимый аудит** контрактов проведён в этой же сессии (PoC-тесты в `contracts/test/audit/`):
  ядро кривой признано корректным (округление всегда в пользу контракта, `x·y` не убывает,
  quote = execution), а найденные проблемы graduator и учёта ETH исправлены (см. ниже).
- **Выпуск на Uniswap v3 устойчив к предсозданному пулу.** Перед минтом graduator делает
  корректирующий своп к целевой цене (`sqrtPriceLimitX96 = expected`), затем требует отклонение
  не более 1 % и минтит full-range позицию с ненулевыми минимумами. Если атакующий поставил
  слишком глубокую ликвидность по искажённой цене, выпуск откатывается (`PoolPriceSkewed`) и
  повторяется позже — средства держателей при этом не теряются.
- **Нет «вечного» состояния `Complete`.** Если выпуск не произошёл за грейс-период (по умолчанию
  24 ч, `setGraduationGrace`), продажи на кривой снова разрешены и кривая возвращается в
  `Bonding` (`CurveReopened`).
- **Учёт возвращённого ETH** ведётся счётчиком в `receive()` (принимается только от graduator во
  время вызова), а не по дельте баланса; `fundMind` под `nonReentrant` — двойной зачёт невозможен.
- **Оператор** (горячий кошелёк раннера) списывает ETH из vault'ов только на `computeTreasury`,
  в пределах дневного лимита (константный потолок 2 ETH/эпоху; на границе эпох возможен всплеск до
  2× лимита — учитывайте при выборе значения). Создатель может лишь поставить разум на паузу и
  сменить модель/персону; дохода создателю нет — всё кормит разум.
- **Владелец** может менять оператора, treasury, graduator (с проверкой `launchpad() == this`),
  комиссии в пределах границ и лимиты; `renounceOwnership` отключён. Для mainnet владелец должен
  быть мультисигом с таймлоком — это главный предохранитель от злоупотребления ролью.
- `pause()` останавливает только создание и покупки; продажи и выпуск работают всегда.
- Из среды сборки RPC Robinhood Chain недоступны, поэтому контракты проверены локально
  (Foundry: unit/fuzz/invariant/audit PoC + anvil e2e); деплой в сеть выполняется по `docs/DEPLOY.md`.
  Форк-тестов против настоящего Uniswap v3 на Robinhood Chain не было — прогоните выпуск на testnet
  с собственным деплоем Uniswap v3 или начните на mainnet с малых сумм.

## Известные ограничения

- Квитанция списания хранит на тик одну модель (последнюю обслужившую запрос) и суммарные
  токены; при server-side fallback внутри одного тика стоимость нельзя пересчитать по
  квитанции с точностью до µUSD. Для аудита расходов используйте леджер
  (`GET /api/minds/:token/compute` → `ledger`).
- Форк-тестов против настоящего Uniswap v3 на Robinhood Chain не проводилось (RPC недоступны
  из среды сборки); модели пула в тестах не включают tick bitmap и оракул.
- Поддерживается семейство Claude через официальный SDK; другие провайдеры моделей (как
  «любая модель» в оригинале) потребуют отдельного адаптера в `runner/src/mind/request.ts`.
- Индексатор рассчитан на Arbitrum Orbit (реорги практически отсутствуют): по умолчанию
  `CONFIRMATIONS=0`; при использовании балансировщика RPC увеличьте значение.

---

## English summary

**www-rh** ports [worldwideweb.stream](https://x.com/www_stream) ("every coin has a mind") from
Solana/pump.fun to **Robinhood Chain** (Arbitrum Orbit L2, chain id 4663 / testnet 46630). On mainnet it runs
on top of **Pons V2** (Robinhood Chain's pump.fun): a coin is launched on the Pons curve with a
per-coin `MindAccount` as its creator-fee recipient, so Pons' 70 % creator share funds the coin's AI *mind*;
the in-house bonding curve stays as the testnet venue. Each coin funds an AI *mind* — a Claude model driving a headless
Chromium browser that explores the web, remembers what it finds and streams its screen and thoughts
to the coin page. 1 % trade fees split 70/30 between the coin's compute vault and the protocol;
when the curve sells out (~4 ETH) anyone can `graduate()` the coin into a permanently locked
Uniswap v3 full-range position whose fees keep feeding the mind via `harvest()`. Compute draws are
capped per day and carry a verifiable receipt hash; memories are anchored on-chain in batches.
Packages: `contracts/` (Foundry), `packages/shared/` (chains, ABI, curve math, model catalog),
`runner/` (indexer, scheduler, Anthropic SDK tool runner + Playwright, Hono API + WebSocket),
`web/` (Vite + React + wagmi). See `docs/SPEC.md` for the normative design and `docs/DEPLOY.md`
for Robinhood Chain deployment.
