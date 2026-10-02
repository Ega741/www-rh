# @www-rh/web

Веб-приложение www-rh — «worldwideweb on Robinhood Chain»: лаунчпад в стиле pump.fun, где у
каждой монеты есть **разум** — модель Claude с собственным браузером. Его экран, мысли и действия
транслируются на странице монеты, а вычисления оплачиваются из хранилища (vault), которое
пополняется торговыми комиссиями.

*EN summary: Vite + React 19 + wagmi 3 front-end. Home grid with live thumbnails, a create flow
(metadata → `createMind` → optional vault seed), and a three-column mind page (live stream, bonding
curve trading, compute meter / memories / receipts / creator tools). Talks to the runner over HTTP
(`/api`) and WebSocket (`/ws`), and to `MindLaunchpad` on Robinhood Chain through wagmi.*

## Стек

Vite 8, React 19, TypeScript (strict), react-router 7, wagmi 3 + viem 2, TanStack Query 5,
Tailwind CSS v4 (`@tailwindcss/vite`). Сети, ABI, математика кривой, каталог моделей, zod-схемы API
и канонический JSON берутся из `@www-rh/shared` (Vite и TypeScript резолвят пакет в его исходники
`packages/shared/src`, отдельная сборка shared не нужна).

## Запуск

```sh
pnpm install                         # в корне репозитория
cp web/.env.example web/.env.local   # и заполнить VITE_LAUNCHPAD_ADDRESS
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
pnpm --filter @www-rh/web test       # vitest: форматирование, котировки, WS-парсер, нормализация, хэши, окно выпуска, ошибки
```

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `VITE_CHAIN_ID` | `46630` | сеть: 4663 mainnet, 46630 testnet, 31337 anvil |
| `VITE_LAUNCHPAD_ADDRESS` | — | адрес `MindLaunchpad`; пусто/нулевой адрес → `launchpadAddress(chainId)` из shared; если адреса нет, запись в контракт отключена и показывается предупреждение |
| `VITE_RUNNER_URL` | — | origin раннера: цель dev-прокси и API-база в production |
| `VITE_RUNNER_WS` | — | WebSocket раннера в production (`wss://host/ws`) |
| `VITE_RPC_URL` | — | свой RPC для транспорта wagmi (в кошелёк не передаётся) |
| `VITE_WALLETCONNECT_PROJECT_ID` | — | включает WalletConnect (иначе только injected-кошельки, EIP-6963) |
| `VITE_MULTICALL` | — | `1` — объявить Multicall3 (`withMulticall3`) и батчить чтения |

## Страницы

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

## Устройство

```
src/
  main.tsx, App.tsx        провайдеры (wagmi, TanStack Query) и роутер
  config.ts                VITE_* → сеть, адрес лаунчпада, URL раннера (чистые функции + тесты)
  wagmi.ts                 createConfig: injected + WalletConnect по env, batch.multicall, polling 2 с
  api.ts                   типизированный клиент HTTP API (§5)
  ws.ts                    парсер сообщений и переподключающийся WebSocket (§6)
  format.ts                wei/ETH/USD/токены, прогресс, запас хода, время
  queries.ts               хуки TanStack Query
  lib/                     нормализация ответов (с проверкой zod-схемами shared), котировки,
                           метаданные, публикация, хэши, редьюсер стрима, ошибки, события
  hooks/                   поток разума, данные разума (API + сеть), транзакции, смена сети, тики
  routes/                  Home, Create, Mind, NotFound
  components/              карточки, панели, кошелёк, ChainGuard, ...
```

Все ответы API и сообщения WS сначала проверяются zod-схемами из `@www-rh/shared`; при
расхождении версий раннера и shared в консоль один раз пишется предупреждение, а данные читаются
«мягко», чтобы интерфейс не падал. Ошибки контракта декодируются через viem
(`ContractFunctionRevertedError.data.errorName`, иначе по 4-байтному селектору) и показываются
человеческим текстом.
