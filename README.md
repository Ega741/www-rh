# Beagle — compute for agents on Robinhood Chain

> one API key for every model · paid for by burning BEAGLE · no e-mail, no card

Порт идеи [Darwin Compute](https://x.com/darwincompute) («better compute for agents») с Solana на
**Robinhood Chain** (Arbitrum Orbit L2, chain id 4663, testnet 46630). Один API-ключ даёт доступ ко всем
моделям — Claude, GPT, Gemini и собственной GPU-модели (`gpt-oss`) — через OpenAI- и Anthropic-совместимые
endpoint'ы и MCP-сервер для агентов. Доступ покупается **сжиганием токена BEAGLE**: контракт `CreditDesk`
сжигает токены, пишет в событие USD-номинал по ончейн-цене, а шлюз начисляет workspace'у ровно эту сумму.
Роутер держит лучшую модель для сложных запросов, переводит простые на дешёвые, при исчерпании кредита или
деградации провайдеров спускается ниже и в конце — на собственную house-модель.

Разбор оригинала — `docs/ANALYSIS.md`. Нормативная спецификация — `docs/SPEC.md`. Сеть и адреса —
`docs/ROBINHOOD_CHAIN.md`. Развёртывание — `docs/DEPLOY.md`.

## Как это работает

```
  пользователь / агент (кошелёк)                      оператор (горячий кошелёк шлюза)
     │ approve + burnForCredit(workspace, amount)        │ draw(budgetId, amount, receiptHash)
     │ approve + openBudget(workspace, cap, deadline)    │ post(price) → ManualPriceSource
     ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────┐
│ CreditDesk (Robinhood Chain)                                     │
│  • quote(amount) по IPriceSource (цена не старше maxPriceAge)    │
│  • burnForCredit → CreditPurchased(receiptId, workspace, µUSD)   │
│  • openBudget / draw / closeBudget → бюджеты агентов             │
└───────────────────────────┬──────────────────────────────────────┘
                            │ события (viem getLogs)
                            ▼
┌──────────────────────────────┐   /api/*          ┌──────────────────┐
│ gateway (Node 22, Hono)      │ ◀───────────────▶ │ web (Vite/React) │
│  индексатор → SQLite-леджер  │                   │  лендинг, Models │
│  SIWE, API-ключи, BYOK       │                   │  Credits (burn)  │
│  роутер + метеринг + лимиты  │  /v1/chat/…       │  Keys, Usage     │
│  /v1/chat/completions        │ ◀── агенты ───▶   │  Providers (BYOK)│
│  /v1/messages, /mcp          │  MCP stdio / HTTP │  Budgets, Pro    │
└──────────┬───────────────────┘                   └──────────────────┘
           │ Anthropic SDK · OpenAI-совместимые API (OpenAI, Gemini, vLLM house)
           ▼
     провайдеры моделей
```

**Экономика.** Кредит хранится в µUSD. Сжигание `amount` токенов даёт `amount · price / 1e30` µUSD по цене
`IPriceSource` (оператор публикует цену в `ManualPriceSource` с ограничением шага ±25 % и частоты; при
наличии Chainlink-фида — `ChainlinkPriceSource`). Наши клиенты сжигают через `burnForCreditMin` с нижней
границей кредита (по умолчанию −1 % от показанной котировки): если цена успела уйти дальше — транзакция
откатывается (`SlippageExceeded`), а не сжигает токены дешевле. Запрос стоит цену провайдера из каталога + наценка
(`MARKUP_BPS`, 10 %); через свои ключи (BYOK) — бесплатно. Нет кредита — `402 insufficient_credit`.
Апгрейды `pro` (30 дней: `gpt-oss-120b`, 128K контекста, выше лимиты) и `warm` (часы тёплого GPU)
покупаются кредитом.

**Бюджет агента.** Агент делает `approve(cap)` и `openBudget(workspace, cap, deadline ≤ 30 дней)`. Пока
бюджет открыт, его headroom (`min(cap − drawn, allowance, balance)` в USD) добавляется к доступному кредиту;
оператор периодически делает `draw` на сумму накопленного потребления с хэшем квитанции (канонический JSON
списка запросов), индексатор зачисляет кредит по событию `BudgetDrawn`. Агент закрывает бюджет в любой момент.

**Роутер.** `beagle/auto` оценивает сложность запроса (длина, код, инструменты, `reasoning_effort`) →
уровень frontier / efficient / budget; при остатке < $1 — на уровень дешевле, < $0.10 — house; провайдер с
серией 429/5xx выпадает (circuit breaker), BYOK-провайдеры идут первыми. Явный id модели соблюдается;
запасные варианты — только дешевле (`x-beagle-fallback: none|cheaper|any`). Политика — чистая функция в
`@beagle/shared` с сценарными тестами.

## Структура

```
contracts/        Foundry: BeagleToken, CreditDesk, CreditMath, ManualPriceSource, ChainlinkPriceSource, моки, тесты,
                  Deploy.s.sol / PostPrice.s.sol / GenerateFixtures.s.sol, deployments/<chainId>.json
packages/shared/  @beagle/shared: сети Robinhood Chain, адреса, ABI, математика кредита, каталог моделей, роутинг, DTO
packages/mcp/     @beagle/mcp: MCP-инструменты для агентов, REST-клиент, stdio-бинарь beagle-mcp
gateway/          @beagle/gateway: индексатор, роутер, метеринг, провайдеры, API, MCP over HTTP, CLI
web/              @beagle/web: лендинг, Credits, Keys, Usage, Providers, Upgrades, Budgets, Models, Docs
scripts/          sync-abi.mjs, sync-deployments.mjs, mock-provider.mjs, anvil-e2e.sh
docker/           Dockerfile'ы и nginx; docker-compose.yml в корне (gateway, web, профиль gpu: vLLM)
docs/             ANALYSIS, SPEC, DEPLOY, ROBINHOOD_CHAIN
```

## Быстрый старт (локально)

```bash
git clone --recurse-submodules <repo> beagle && cd beagle
pnpm install
(cd contracts && forge build && forge test)
pnpm -r build && pnpm -r test
pnpm anvil:e2e      # anvil → деплой → mock-провайдер → шлюз → burn → запрос → 402 → бюджет → draw → MCP
```

Живой стенд с моделями:

```bash
cp .env.example .env          # CHAIN_ID=31337, OPERATOR_PRIVATE_KEY, DRY_RUN=false, ANTHROPIC_API_KEY=…, HOUSE_BASE_URL=…
anvil --block-time 1 &
(cd contracts && DEPLOYER_PRIVATE_KEY=$K OPERATOR=$OP POSTER=$OP INITIAL_PRICE_E18=10000000000000000 \
   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $K)
node scripts/sync-deployments.mjs && node scripts/sync-abi.mjs && pnpm -r build
set -a; source .env; set +a   # шлюз читает только process.env и сам .env не открывает (иначе: node --env-file=.env gateway/dist/main.js)
pnpm dev:gateway              # http://localhost:8787
pnpm dev:web                  # http://localhost:5173 (Vite читает .env сам)
```

## Использование

```bash
# OpenAI-совместимый endpoint: любой SDK с base_url
curl http://localhost:8787/v1/chat/completions \
  -H "authorization: Bearer bgl_…" -H "content-type: application/json" \
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"hello"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/v1", api_key="bgl_…")
client.chat.completions.create(model="beagle/best", messages=[{"role": "user", "content": "hi"}])
```

```json
// Claude Desktop / Claude Code: MCP-сервер для агента — локальная сборка (`pnpm --filter @beagle/mcp build`,
// затем `node packages/mcp/dist/bin.js`; в конфиге клиента путь к bin.js должен быть абсолютным).
// Пакет @beagle/mcp в npm не опубликован: `npx -y @beagle/mcp` не работает, и чужому пакету с таким именем
// нельзя отдавать BEAGLE_API_KEY / BEAGLE_AGENT_PRIVATE_KEY.
{ "mcpServers": { "beagle": { "command": "node", "args": ["/abs/path/to/beagle/packages/mcp/dist/bin.js"],
  "env": { "BEAGLE_API_URL": "http://localhost:8787", "BEAGLE_API_KEY": "bgl_…" } } } }
```

Claude Code: `claude mcp add beagle -e BEAGLE_API_URL=http://localhost:8787 -e BEAGLE_API_KEY=bgl_… -- node $PWD/packages/mcp/dist/bin.js`.
Без локального процесса — транспорт Streamable HTTP шлюза: `http://localhost:8787/mcp` с заголовком
`Authorization: Bearer bgl_…` (кошельковые инструменты тогда возвращают неподписанные шаги).

Инструменты MCP: `beagle_balance`, `beagle_models`, `beagle_quote`, `beagle_complete`, `beagle_usage`,
`beagle_buy_compute`, `beagle_open_budget`, `beagle_budgets`, `beagle_upgrade`, `beagle_status`. С
`BEAGLE_AGENT_PRIVATE_KEY` покупка compute и открытие бюджета исполняются агентом сами; без ключа
возвращаются неподписанные транзакции.

Заголовки ответа: `x-beagle-model` (какая модель обслужила), `x-beagle-paid-by`, `x-beagle-cost-micro`,
`x-beagle-balance-micro`, `x-beagle-route` (почему так). Заголовки запроса: `x-beagle-difficulty` (0..1),
`x-beagle-fallback`.

## Переменные окружения

Все — в `.env.example` (один файл на контракты, шлюз и веб). Шлюз читает только `process.env` и сам `.env` не
открывает: на голом железе `node --env-file=.env gateway/dist/main.js` (или `set -a; source .env; set +a`), в
docker compose файл подключён через `env_file`, Vite читает `VITE_*` сам. Ключевые:

| Переменная | Назначение |
|---|---|
| `NODE_ENV` | `production` включает защитные проверки: обязательный `SESSION_SECRET`, `credit` только с `--force` (Docker-образ ставит его сам) |
| `CHAIN_ID`, `RPC_URL`, `CREDIT_DESK_ADDRESS`, `START_BLOCK`, `CONFIRMATIONS` | сеть и адрес `CreditDesk` (по умолчанию из `contracts/deployments`) |
| `OPERATOR_PRIVATE_KEY`, `DRY_RUN` | ключ оператора (draw бюджетов, публикация цены); `DRY_RUN=true` — без транзакций |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `HOUSE_BASE_URL` | платформенные ключи провайдеров и адрес house-модели (vLLM) |
| `SESSION_SECRET`, `KEYRING_MASTER_KEY`, `ADMIN_TOKEN` | сессии, шифрование BYOK-ключей, админ-маршруты |
| `MARKUP_BPS`, `BYOK_FEE_BPS`, `LOW_CREDIT_USD`, `VERY_LOW_CREDIT_USD`, `MIN_RESERVE_USD` | экономика и пороги роутера |
| `PRO_PRICE_USD`, `PRO_DAYS`, `WARM_HOUR_PRICE_USD`, `WARM_DRIVER` | апгрейды |
| `DRAW_THRESHOLD_USD`, `DRAW_INTERVAL_MS`, `PRICE_POSTER_ENABLED`, `PRICE_FEED_URL` | бюджеты и публикация цены |
| `VITE_CHAIN_ID`, `VITE_GATEWAY_URL`, `VITE_CREDIT_DESK_ADDRESS`, `VITE_WALLETCONNECT_PROJECT_ID` | веб |

## Безопасность и доверие

- **Сжигание окончательно и проверяемо.** Кредит равен `usdMicro` из события контракта по цене, которую
  прочитал сам контракт; леджер шлюза — кэш событий плюс списания. Любой может пересчитать начисления.
- **Оператор** может только публиковать цену в пределах `maxStepBps`/`minInterval` и делать `draw` из
  бюджетов не выше `cap` и не позже `deadline`, с хэшем квитанции. Иначе чужие токены ему недоступны.
  Владелец (на mainnet — мультисиг с таймлоком) меняет параметры и ставит паузу; `renounceOwnership` отключён;
  `closeBudget` работает всегда. Бюджет — это approve, а не эскроу: владелец бюджета может отозвать allowance до
  `draw`, поэтому шлюз списывает часто (`DRAW_THRESHOLD_USD`) и ограничивает долг доступным headroom.
- **Проверено адверсариальным ревью** (9 линз: безопасность и экономика контрактов, деньги и безопасность шлюза,
  соответствие спецификации, MCP, веб, документация): каждая находка перепроверена отдельным агентом, исправления
  покрыты регрессионными тестами — 131 тест Foundry (unit/fuzz/invariant), 460+ тестов vitest, anvil e2e.
- **Ключи.** API-ключи хранятся хэшами; BYOK — AES-256-GCM с мастер-ключом сервера; сессии случайные; SIWE-nonce
  одноразовые; CORS ограничен; `baseUrl` BYOK проверяется на SSRF; лимиты размера тела и частоты запросов.
- **Промпты не сохраняются** (только токены и стоимость), если не включён `LOG_PROMPTS`.
- Цены моделей в каталоге — снимок на 2026-10; оператор обновляет их через `MODEL_CATALOG_FILE`.

## Известные ограничения

- Из среды сборки RPC Robinhood Chain недоступны: контракты проверены локально (Foundry unit/fuzz/invariant +
  anvil e2e); деплой в сеть — по `docs/DEPLOY.md`.
- Доступность house-модели равна доступности GPU за `HOUSE_BASE_URL`; в репозитории — compose-профили с vLLM.
  Endpoint у шлюза один: обе house-модели (`HOUSE_MODEL_SMALL`, `HOUSE_MODEL_LARGE` для Pro) запрашиваются с
  `HOUSE_BASE_URL`, а vLLM обслуживает одну модель на процесс — для обеих нужен OpenAI-совместимый роутер перед
  `house`/`house-large`, иначе вторую модель уберите из каталога (`MODEL_CATALOG_FILE`, `docs/DEPLOY.md` §3).
- Цена токена для начислений берётся из `ManualPriceSource` (оператор в границах) — при появлении
  Chainlink-фида используйте `ChainlinkPriceSource`. TWAP-оракул по пулу Uniswap/Pons — будущая работа.
- `/v1/messages` покрывает основное подмножество Anthropic Messages API (текст, картинки, инструменты); экзотика
  (батчи, файлы, расширенные блоки) не транслируется.

---

## English summary

**Beagle** ports [Darwin Compute](https://x.com/darwincompute) ("better compute for agents") from Solana to
**Robinhood Chain** (Arbitrum Orbit L2, chain id 4663 / testnet 46630). One API key gives access to every
model — Claude, GPT, Gemini and the project's own house model (`gpt-oss`) — through OpenAI-compatible
`/v1/chat/completions`, Anthropic-compatible `/v1/messages` and an MCP server for agents. Access is paid by
**burning BEAGLE**: `CreditDesk.burnForCredit` burns the tokens, quotes them in USD from an on-chain price
source and emits the amount; the gateway indexes the event and credits the workspace exactly that. Wallet
sign-in (SIWE), no e-mail, no card. The router keeps the best model for hard requests, moves easy ones to
cheaper models, downgrades as credit or provider limits run down and falls back to the house model. BYOK keys
are stored encrypted and routed for free. Agents can **authorize a budget** on-chain (`openBudget`); the
operator draws from it as usage accrues, never above the cap, with a receipt hash per draw. Upgrades (`pro`,
`warm` GPU hours) are bought with credit. Packages: `contracts/` (Foundry), `packages/shared/`, `packages/mcp/`,
`gateway/`, `web/`. See `docs/SPEC.md` and `docs/DEPLOY.md`.
