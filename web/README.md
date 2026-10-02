# @www-rh/web

Веб-приложение www-rh — «worldwideweb on Robinhood Chain»: лаунчпад в стиле pump.fun, где у
каждой монеты есть **разум** — модель Claude с собственным браузером. Его экран, мысли и действия
транслируются на странице монеты, а вычисления оплачиваются из хранилища (vault), которое
пополняется торговыми комиссиями.

*EN summary: Vite + React 19 + wagmi 3 front-end. Home grid with live thumbnails, a create flow
and a three-column mind page (live stream, trading, compute meter / memories / receipts / creator
tools). Two venues (SPEC §9): **Pons mode** (`VITE_VENUE=pons`, the default and the mainnet path) —
coins launch and trade on Pons V2, the mind lives in `PonsMindRegistry` (launch via
`registry.launchMind`, or adopt an existing Pons coin in three steps), the trade column talks to the
Pons curve directly and the compute meter shows Pons creator fees claimable + "Harvest"; **curve
mode** (`VITE_VENUE=curve`) — the in-house `MindLaunchpad` bonding curve of §7, unchanged. Talks to
the runner over HTTP (`/api`) and WebSocket (`/ws`), and to the contracts through wagmi.*

## Стек

Vite 8, React 19, TypeScript (strict), react-router 7, wagmi 3 + viem 2, TanStack Query 5,
Tailwind CSS v4 (`@tailwindcss/vite`). Сети, ABI, математика кривой, каталог моделей, zod-схемы API
и канонический JSON берутся из `@www-rh/shared` (Vite и TypeScript резолвят пакет в его исходники
`packages/shared/src`, отдельная сборка shared не нужна).

## Запуск

```sh
pnpm install                         # в корне репозитория
cp web/.env.example web/.env.local   # VITE_VENUE + VITE_REGISTRY_ADDRESS (pons) или VITE_LAUNCHPAD_ADDRESS (curve)
pnpm --filter @www-rh/runner dev     # раннер на :8787 (API + WS)
pnpm --filter @www-rh/web dev        # http://localhost:5173
```

В dev-режиме браузер ходит на относительные `/api/...` и `/ws`, а Vite проксирует их
(`ws: true`) на `VITE_RUNNER_URL` (по умолчанию `http://localhost:8787`). В production-сборке
API-база — `VITE_RUNNER_URL` (пусто = тот же origin), WebSocket — `VITE_RUNNER_WS` (пусто =
`/ws` того же origin).

```sh
pnpm --filter @www-rh/web build      # tsc --noEmit + vite build → web/dist
pnpm --filter @www-rh/web preview    # отдать dist на :4173
pnpm --filter @www-rh/web typecheck
pnpm --filter @www-rh/web test       # vitest: форматирование, котировки, WS-парсер, нормализация, хэши, окно выпуска, ошибки, Pons (котировки, запуск, усыновление v2, жизненный цикл, Leave/Recover, слияние ABI, фазы, события)
pnpm --filter @www-rh/web lint       # tsc с --noUnusedLocals/--noUnusedParameters
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `VITE_CHAIN_ID` | `46630` | сеть: 4663 mainnet, 46630 testnet, 31337 anvil |
| `VITE_VENUE` | `pons` | площадка (SPEC §9.5): `pons` — Pons V2 + `PonsMindRegistry`; `curve` — собственная кривая `MindLaunchpad` (§7). Любое значение, кроме `curve`, означает Pons. Pons V2 есть только в mainnet (4663): для testnet/anvil обычно `VITE_VENUE=curve` |
| `VITE_REGISTRY_ADDRESS` | — | Pons-режим: адрес `PonsMindRegistry`; пусто/нулевой адрес → `registryAddress(chainId)` из shared; без адреса запись отключена. Адрес фабрики Pons читается из `registry.factory()` (запасной вариант — mainnet-фабрика из `PONS` в shared) |
| `VITE_LAUNCHPAD_ADDRESS` | — | curve-режим: адрес `MindLaunchpad`; пусто/нулевой адрес → `launchpadAddress(chainId)` из shared; если адреса нет, запись в контракт отключена и показывается предупреждение |
| `VITE_RUNNER_URL` | — | origin раннера: цель dev-прокси и API-база в production |
| `VITE_RUNNER_WS` | — | WebSocket раннера в production (`wss://host/ws`) |
| `VITE_RPC_URL` | — | свой RPC для транспорта wagmi (в кошелёк не передаётся) |
| `VITE_WALLETCONNECT_PROJECT_ID` | — | включает WalletConnect (иначе только injected-кошельки, EIP-6963) |
| `VITE_MULTICALL` | — | `1` — объявить Multicall3 (`withMulticall3`) и батчить чтения |

## Страницы

Ниже — curve-режим (§7). Отличия Pons-режима — в разделе «Pons-режим».

- **`/`** — сетка разумов (`GET /api/minds`, вкладки new / mcap / active, «load more» по курсору),
  живые миниатюры (`frame.jpg` каждые 5 с, пока карточка видна и разум жив), статус (alive /
  sleeping / paused by creator), модель, цена и капитализация, прогресс кривой, кнопка
  «feed the mind» (`fundMind`, 0.001 ETH по умолчанию) и полоса статистики (`GET /api/stats`).
- **`/create`** — имя, тикер, описание, картинка (https/ipfs URL), ссылки, выбор модели с ценами
  (`GET /api/models`, при недоступности — каталог из shared), персона, первая покупка с котировкой
  по общей математике кривой (свежая кривая) и проскальзыванием, опциональный «seed compute».
  Поток: `POST /api/metadata` → (если раннер недоступен — `data:`-URI, только если он ≤ 2048 байт)
  → перечитать `creationFee`/`feeParams` → `createMind(...)` с `value = creationFee + initialBuy`
  → из чека декодируется `MindCreated` (`parseEventLogs`) → опционально `fundMind` →
  переход на `/mind/<token>`.
- **`/mind/:token`** — три колонки:
  1. **стрим**: кадры из WS на canvas, текущий URL, лента мыслей (дельты `text`, `thinking` за
     переключателем, сохранённые мысли), журнал действий;
  2. **торговля**: состояние кривой, buy/sell с котировками `quoteBuy`/`quoteSell` (обновление
     каждые 2 с, локальная оценка пока чтение не пришло), проскальзывание 0.1–20 % (1 % по
     умолчанию), дедлайн, approve ровно на сумму → sell; в фазе `complete` — кнопка Graduate
     (`WrongPhase` = уже выпущено, просто обновляем), после выпуска — ссылки на страницу токена и
     пула в Blockscout («MockGraduator (no DEX)» при `positionId = 0`) и кнопка «Harvest fees»;
  3. **разум**: модель и персона (с проверкой `personaHash`), счётчик вычислений (баланс ETH/USD,
     расход в час, запас хода), «feed the mind», память (ссылки на транзакции якорения и JSON
     батча, проверка `contentHash` в браузере), квитанции списаний (статус, `receiptHash`,
     пересчёт хэша в браузере, ссылка на транзакцию), инструменты создателя (`setMindConfig`,
     `setCreatorPaused`; вывода средств нет — vault тратится только на вычисления).

  Пока раннер отвечает 404 по новой монете, страница показывает «indexing…», опрашивает его раз в
  2 с и уже работает по данным из сети (`getMind`, `getCurve`, `mindBalance`).

  **Окно выпуска (SPEC §2.3, правило 3).** В фазе `complete` страница читает `completedAt(token)` и
  `graduationGrace()` (по умолчанию 86400 с) и показывает «graduation window: ends in HH:MM:SS», а
  когда `now >= completedAt + grace` — «sells reopened since …»: включаются форма продажи и чтения
  `quoteSell` (кнопка активна, когда котировка из сети подтвердит, что и блок перешёл границу) с
  пометкой, что первая продажа возвращает кривую в `bonding` (`CurveReopened`); покупка в `complete`
  остаётся выключенной, Graduate — доступной. Откат `graduate` с `PoolPriceSkewed` (декодируется по
  ABI из shared) — не ошибка, а уведомление «pool price is skewed, graduation will be retried; you
  can try again later». Смена фазы по WS сразу перечитывает кривую; при переходе `complete` →
  `bonding` buy/sell работают как обычно, и, если `completedAt` был ненулевым, показывается строка
  «curve reopened after the graduation window expired». Математика окна — чистые функции
  `lib/grace.ts` (с тестами).

## Pons-режим (SPEC §9.5, `VITE_VENUE=pons`)

Общий контур MindCore (`getMind`, `mindBalance`, `fundMind`, `setMindConfig`, `setCreatorPaused`,
`creationFee`, `paused`) одинаков у лаунчпада и реестра (те же селекторы), поэтому «feed the mind»,
смена модели/персоны и пауза работают так же, только адресом служит `PonsMindRegistry`.

- **`/create`** — две вкладки (`?tab=adopt&token=0x…` открывает вторую сразу):
  1. **launch on Pons**: имя, тикер, логотип (https/ipfs URL), описание, соцсети (x, telegram,
     website, discord, farcaster — полные http(s) URL; первые три также попадают в метаданные),
     ползунок creator tax 0..`maxCreatorTaxBps` из `GET /api/launch-config` (по умолчанию 1 %; налог
     целиком идёт на аккаунт разума), выбор launch config, первая покупка с превью `ponsQuoteBuy` на
     свежей кривой конфига (phantom reserve против всего supply, sellable = supply − reserved) и
     проскальзыванием, модель, персона. Поток: метаданные (как раньше: `POST /api/metadata`, иначе
     `data:`-URI ≤ 2048 байт) → свежие чтения прямо перед отправкой (`creationFee` реестра,
     `launchFee`, `getLaunchConfig(id)` и `previewLaunchEconomics(id, 0x0)` фабрики) →
     `registry.launchMind(params, quoteIn, minTokensOut, modelId, personaHash, uri)` с
     `value = launchFee + quoteIn + creationFee`, `expectedEconomics` = превью,
     `salt = keccak256(utf8(name + ' ' + symbol + ' ' + nonce))` (новый nonce на каждую попытку) →
     из чека декодируется `MindLaunched` → переход на `/mind/<token>`. Если раннер недоступен,
     launch config читается из фабрики. Показываются предупреждения `paused()` реестра и
     `factory.canLaunch(registry) == false`.
  2. **adopt an existing Pons coin** (усыновление v2, §9.7): вставить адрес токена → запись запуска
     (`factory.getLaunchedToken`: кривая, deployer, получатель комиссий, creator tax, котируемый актив,
     buyback, фаза) и список ожидающих подготовок из `GET /api/minds/:token/adoptions` (preparer,
     account; каждая перепроверяется `registry.pendingAdoption(token, preparer)`) → шаг 1
     `registry.prepareAdoption(token, modelId, personaHash, uri)` создаёт или обновляет **собственную**
     подготовку кошелька (кто угодно; показывается будущий аккаунт `predictAdoptionAccount(token, wallet)`)
     → шаг 2 кнопка `factory.transferCreatorFeeRecipient(token, myAccount)` (активна, только если
     кошелёк — текущий получатель; иначе явное предупреждение и подсказка, кто и что должен вызвать) →
     шаг 3 `registry.activateAdoption(token, preparer)` (кто угодно, когда получатель у фабрики равен
     аккаунту этой подготовки; активация предлагается для любой подготовки, чей аккаунт уже получатель).
     Шаг выводится чистой функцией `adoptionStep` (`lib/pons/adoption.ts`) из записи запуска, моей
     подготовки, `isMind`, `hasLeft` (запасной вариант — `MindDetail.pons.left`) и того, равен ли
     аккаунт разума получателю, поэтому поток продолжается после перезагрузки и из разных кошельков.
     Запуски с ERC-20 в качестве котируемого актива и с `buybackEnabled` не поддерживаются.
- **`/mind/:token`** — данные: `registry.getMind/ponsMind/mindBalance/claimable`,
  `factory.getLaunchedToken` (фаза, получатель комиссий), кривая Pons (`getReserves`,
  `sellableTokens`, `realQuoteReserve`, `graduationThreshold`, `feeBps`, `creatorTaxBps`, `graduated`,
  `readyToGraduate`; best-effort `launchedAt`). Цена = `quoteReserve·1e18/tokenReserve`, прогресс =
  `realQuoteReserve/graduationThreshold`. Фазы: bonding / graduating (`Swept`, или кривая распродана)
  / graduated (`PoolCreated`/`Rescued`).
  - торговля напрямую с кривой: buy — `curve.buy{value: quoteIn}(quoteIn, minOut, account)`, sell —
    approve ровно на сумму кривой, затем `curve.sell(tokensIn, minOut, account)`; котировки локальные
    (`ponsQuoteBuy`/`ponsQuoteSell` из shared по живым резервам — у Pons нет view-котировки), дедлайна
    у кривой нет, только minOut. Первые `snipeTaxSeconds` (15 с) после запуска — красное
    предупреждение о snipe tax (до 99 %, убывает; создатель освобождён) с обратным отсчётом и, если
    кошелёк подключён, текущей ставкой `currentSnipeTaxBps`; котировка налог не учитывает, так что
    облагаемая покупка откатится по проскальзыванию, а не заплатит его.
  - graduating: кнопка «Seed the Uniswap pool» (`registry.createGraduatedPool`, кто угодно;
    `WrongGraduationPhase` = уже сделано, просто обновляем) или «Settle the launch»
    (`factory.graduate`, если автоматический выпуск не прошёл); после выпуска — вместо формы
    «Trade on Pons» (https://www.ponsfamily.com), Uniswap (только mainnet) и Blockscout.
  - счётчик вычислений: vault + claimable (кредит в FeeEscrow Pons) и кнопка «Harvest»
    (`registry.harvest(token)`, кто угодно).
  - инструменты создателя: «Leave» — `registry.leave(token, newRecipient)` с подтверждением
    (галочка); диалог объясняет, что заработанные комиссии сначала собираются в vault (как harvest),
    и проверяет получателя (не ноль, не реестр, не аккаунт разума — через `registry.tokenOf(addr)`).
    Если получатель комиссий уже не аккаунт разума, вместо кнопки показывается, кому идут комиссии, и
    путь перехвата. В свёрнутом разделе «advanced» — «Recover tokens»:
    `registry.recoverAccountTokens(token, erc20)` (адрес ERC-20, баланс аккаунта показывается заранее).
- **`/`** — на карточках бейдж площадки (`pons`/`curve`, из `MindSummary.venue`), фаза «graduating»
  для Pons; в подвале — адрес реестра и предупреждение, если `venue` раннера (`/api/health`) не
  совпадает со сборкой.
- Ошибки реестра (`AccountExists`, `NotPonsLaunch`, `NotRecipientOrDeployer`, `AdoptionNotReady`,
  `AlreadyAdopted`, `WrongValue`, `LaunchFailed`, `BuybackEnabledLaunch`, `InvalidRecipient`) и
  всплывающие ошибки кривой/фабрики Pons
  (`SlippageExceeded`, `CurveGraduated`, `LaunchEconomicsMismatch`, `NotCreatorFeeRecipient`, …)
  декодируются по ABI вызова, затем по ABI лаунчпада/реестра/кривой/фабрики, затем по селектору.

**Усыновление v2 и жизненный цикл (SPEC §9.7).** Каждая подготовка привязана к своему автору:
аккаунт — клон с солью `(token, preparer)`, до активации в реестре ничего не регистрируется, а чужая
незавершённая подготовка не может перехватить передачу комиссий. Разум, чей аккаунт больше не
получает комиссии (создатель вызвал `leave`, или получателя сменили), можно **перехватить** тем же
путём: на странице разума показывается состояние «left» (комиссии перенаправлены, vault по-прежнему
платит за вычисления, разум спит; «resume» его не будит) со ссылкой
`/create?tab=adopt&token=…`; активация заменяет создателя, модель, персону и аккаунт, vault остаётся
у разума. `hasLeft(token)` читается из сети (`PonsLive.left`, `MindDetail.pons.left`), чек активации
декодируется `mindAdoptedFromLogs` (новый разум или перехват).

ABI, адреса Pons и математика котировок берутся из `@www-rh/shared` (§9.3). Члены §9.7
(`activateAdoption(token, preparer)`, `predictAdoptionAccount(token, preparer)`, `pendingAdoption`,
`hasLeft`, `derivedPoolId`, `recoverAccountTokens`, `MindAdopted` с тремя индексами,
`BuybackEnabledLaunch`, `InvalidRecipient`) продублированы в `ponsMindRegistryV2Abi` и сливаются с ABI
shared по сигнатуре (`mergeAbi`): то, что уже есть в shared, берётся оттуда, а заменённые сигнатуры §9.2
отбрасываются. Локально (в `src/lib/pons/`) остаются только недостающие части: ошибки кривой и фабрики Pons,
`factory.graduate(address)`, `curve.token()`, `FailedDeployment()` реестра, view-функции кривой
`launchedAt`/`snipeTaxSeconds`/`currentSnipeTaxBps`, свежие резервы конфига
(`ponsReservedTokens`/`ponsInitialReserves`) и URL приложения Pons.

## Устройство

```
src/
  main.tsx, App.tsx        провайдеры (wagmi, TanStack Query) и роутер
  config.ts                VITE_* → сеть, площадка, адреса лаунчпада/реестра, URL раннера (чистые функции + тесты)
  wagmi.ts                 createConfig: injected + WalletConnect по env, batch.multicall, polling 2 с
  api.ts                   типизированный клиент HTTP API (§5)
  ws.ts                    парсер сообщений и переподключающийся WebSocket (§6)
  format.ts                wei/ETH/USD/токены, прогресс, запас хода, время
  queries.ts               хуки TanStack Query
  lib/                     нормализация ответов (с проверкой zod-схемами shared), котировки,
                           метаданные, публикация, хэши, редьюсер стрима, ошибки, события
  lib/pons/                Pons-режим: ABI (shared + локальные дополнения), математика запуска,
                           машина состояний усыновления, жизненный цикл (left / перехват), проверки
                           Leave / Recover tokens, фазы, snipe-окно, события, ссылки (+ тесты)
  hooks/                   поток разума, данные разума (API + сеть; usePonsMindData в Pons-режиме),
                           usePons (фабрика, launch config), транзакции, смена сети, тики
  routes/                  Home, Create (curve) / PonsCreate (launch + adopt), Mind, NotFound
  components/              карточки, панели, кошелёк, ChainGuard, ...
  components/pons/         PonsLaunchForm, AdoptPanel, PonsTradePanel, HarvestButton, LeaveMind,
                           RecoverTokens, PonsLifecycleNotice
```

Все ответы API и сообщения WS сначала проверяются zod-схемами из `@www-rh/shared`; при
расхождении версий раннера и shared в консоль один раз пишется предупреждение, а данные читаются
«мягко», чтобы интерфейс не падал. Ошибки контракта декодируются через viem
(`ContractFunctionRevertedError.data.errorName`, иначе по 4-байтному селектору) и показываются
человеческим текстом.
