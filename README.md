# Beagle — compute for agents on Solana

> one API key for every model · paid for by burning BEAGLE from your Solana wallet · no e-mail, no card

Воспроизведение идеи [Darwin Compute](https://x.com/darwincompute) («better compute for agents») на
**Solana**. Один API-ключ даёт доступ ко всем моделям — Claude, GPT, Gemini и собственной GPU-модели
(`gpt-oss`) — через OpenAI- и Anthropic-совместимые endpoint'ы и MCP-сервер для агентов. Доступ покупается
**сжиганием SPL-токена BEAGLE** из собственного кошелька: шлюз индексирует сжигания mint'а, оценивает их по
опубликованной точке цены и начисляет кредит workspace'у. Никакой собственной on-chain программы: только
SPL Token и Memo. Роутер держит лучшую модель для сложных запросов, переводит простые на дешёвые, при
исчерпании кредита или деградации провайдеров спускается ниже и в конце — на собственную house-модель.

Разбор оригинала — `docs/ANALYSIS.md`. Нормативная спецификация — `docs/SPEC.md`. Сеть, RPC, эксплореры —
`docs/SOLANA.md`. Развёртывание — `docs/DEPLOY.md`.

## Как это работает

```
  пользователь / агент (кошелёк Solana)             оператор (keypair шлюза, делегат)
     │ BurnChecked(ata, mint, amount) [+ Memo ws=…]     │ BurnChecked(ata агента, authority = делегат)
     │ ApproveChecked(ata, delegate = оператор, cap)    │   + Memo "beagle:draw v1 ws=… h=<хэш квитанции>"
     ▼                                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│ Solana: SPL Token program + Memo program (своей программы нет)   │
└───────────────────────────┬──────────────────────────────────────┘
                            │ getSignaturesForAddress(mint) → getTransaction (jsonParsed)
                            ▼
┌──────────────────────────────┐   /api/*          ┌──────────────────┐
│ gateway (Node 22, Hono)      │ ◀───────────────▶ │ web (Vite/React) │
│  индексатор → SQLite-леджер  │                   │  wallet-adapter  │
│  точки цены (публичные)      │                   │  Credits (burn)  │
│  SIWS, API-ключи, BYOK       │  /v1/chat/…       │  Budgets         │
│  роутер + метеринг + лимиты  │ ◀── агенты ───▶   │  Keys, Usage     │
│  /v1/messages, /mcp          │  MCP stdio / HTTP │  Providers, Pro  │
└──────────┬───────────────────┘                   └──────────────────┘
           │ Anthropic SDK · OpenAI-совместимые API (OpenAI, Gemini, vLLM house)
           ▼
     провайдеры моделей
```

**Экономика.** Кредит хранится в µUSD. Сжигание `amount` токенов (6 знаков) даёт `amount · price / 1e18` µUSD по
**опубликованной точке цены** на момент, когда шлюз увидел транзакцию; точка цены и её источник записываются в
событие, история точек публична (`/api/price/history`). Источник цены — ручной, HTTP-фид или Jupiter Price
API; шаг ограничен, устаревание помечается. Запрос стоит цену провайдера из каталога + наценка
(`MARKUP_BPS`, 10 %); через свои ключи (BYOK) — бесплатно. Нет кредита — `402 insufficient_credit`.
Апгрейды `pro` (30 дней: `gpt-oss-120b`, 128K контекста, выше лимиты) и `warm` (часы тёплого GPU)
покупаются кредитом.

**Бюджет агента.** Агент делает `ApproveChecked(ata, delegate = оператор, cap)` — обычное SPL-делегирование.
Пока делегирование живо, его headroom (`min(delegatedAmount, balance)` в USD) добавляется к доступному кредиту;
оператор периодически сжигает из счёта агента как делегат на сумму накопленного потребления, кладя в memo хэш
квитанции (канонический JSON списка запросов); индексатор подтверждает списание по этому memo. `Revoke`
закрывает бюджет в любой момент; новое `approve` заменяет лимит. Оператор умеет только сжигать — перевести
токены он не может.

**Роутер.** `beagle/auto` оценивает сложность запроса (длина, код, инструменты, `reasoning_effort`) →
уровень frontier / efficient / budget; при остатке < $1 — на уровень дешевле, < $0.10 — house; провайдер с
серией 429/5xx выпадает (circuit breaker), BYOK-провайдеры идут первыми. Явный id модели соблюдается;
запасные варианты — только дешевле (`x-beagle-fallback: none|cheaper|any`). Политика — чистая функция в
`@beagle/shared` со сценарными тестами.

## Структура

```
solana/           scripts/setup-cluster.sh (создание mint'а, эмиссия, запись deployments), keys/ (тестовые ключи localnet),
                  deployments/<cluster>.json
packages/shared/  @beagle/shared: кластеры, адреса программ и деплоев, memo, SIWS, математика кредита, каталог моделей,
                  роутинг, DTO
packages/mcp/     @beagle/mcp: MCP-инструменты для агентов, REST-клиент, Keypair-исполнитель транзакций, stdio-бинарь
gateway/          @beagle/gateway: индексатор, сканер делегирований, списания, сервис цены, роутер, метеринг,
                  провайдеры, API, MCP over HTTP, CLI
web/              @beagle/web: лендинг, Models, Docs, вход кошельком (SIWS), Credits, Budgets, Keys, Usage, Providers, Upgrades
scripts/          sync-deployments.mjs, mock-provider.mjs, solana-e2e.sh, e2e/*.mjs
docker/           Dockerfile'ы и nginx; docker-compose.yml в корне (gateway, web, профили gpu: vLLM)
docs/             ANALYSIS, SPEC, DEPLOY, SOLANA
```

## Быстрый старт (локально)

```bash
git clone <repo> beagle && cd beagle
pnpm install
pnpm -r build && pnpm -r test
pnpm solana:e2e     # solana-test-validator → mint → mock-провайдер → шлюз → burn → запрос → 402 → бюджет → draw → MCP
```

Живой стенд с моделями:

```bash
cp .env.example .env            # CLUSTER=localnet, OPERATOR_SECRET_KEY, DRY_RUN=false, PRICE_SOURCE=manual, ANTHROPIC_API_KEY=…, HOUSE_BASE_URL=…
solana-test-validator --reset --quiet &
bash solana/scripts/setup-cluster.sh localnet && node scripts/sync-deployments.mjs && pnpm -r build
node --env-file=.env gateway/dist/cli.js migrate && node --env-file=.env gateway/dist/cli.js set-price --usd 0.01
set -a; source .env; set +a      # шлюз читает только process.env (иначе: node --env-file=.env gateway/dist/main.js)
pnpm dev:gateway                 # http://localhost:8787
pnpm dev:web                     # http://localhost:5173 (Vite читает .env сам)
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
// Claude Desktop / Claude Code: MCP-сервер для агента — локальная сборка (`pnpm --filter @beagle/mcp build`),
// путь к bin.js в конфиге клиента должен быть абсолютным. Пакет @beagle/mcp в npm не опубликован.
{ "mcpServers": { "beagle": { "command": "node", "args": ["/abs/path/to/beagle/packages/mcp/dist/bin.js"],
  "env": { "BEAGLE_API_URL": "http://localhost:8787", "BEAGLE_API_KEY": "bgl_…",
           "BEAGLE_AGENT_SECRET_KEY": "<base58 или JSON-массив байт keypair агента>" } } } }
```

Claude Code: `claude mcp add beagle -e BEAGLE_API_URL=http://localhost:8787 -e BEAGLE_API_KEY=bgl_… -- node $PWD/packages/mcp/dist/bin.js`.
Без локального процесса — транспорт Streamable HTTP шлюза: `http://localhost:8787/mcp` с заголовком
`Authorization: Bearer bgl_…` (кошельковые инструменты тогда возвращают неподписанные транзакции).

Инструменты MCP: `beagle_balance`, `beagle_models`, `beagle_quote`, `beagle_complete`, `beagle_usage`,
`beagle_buy_compute`, `beagle_open_budget`, `beagle_close_budget`, `beagle_budgets`, `beagle_upgrade`,
`beagle_status`. С `BEAGLE_AGENT_SECRET_KEY` сжигание, делегирование и отзыв исполняются агентом сами; без
ключа возвращаются неподписанные транзакции (base64).

Заголовки ответа: `x-beagle-model` (какая модель обслужила), `x-beagle-paid-by`, `x-beagle-cost-micro`,
`x-beagle-balance-micro`, `x-beagle-route` (почему так). Заголовки запроса: `x-beagle-difficulty` (0..1),
`x-beagle-fallback`.

## Переменные окружения

Все — в `.env.example` (один файл на шлюз, веб и скрипты). Шлюз читает только `process.env`: на голом железе
`node --env-file=.env gateway/dist/main.js` (или `set -a; source .env; set +a`), в docker compose файл подключён
через `env_file`, Vite читает `VITE_*` сам. Ключевые:

| Переменная | Назначение |
|---|---|
| `NODE_ENV` | `production` включает защитные проверки: обязательный `SESSION_SECRET`, `credit` только с `--force` |
| `CLUSTER`, `RPC_URL`, `MINT_ADDRESS`, `COMMITMENT`, `INDEX_FROM_SIGNATURE` | кластер, RPC, mint (по умолчанию из `solana/deployments`), уровень подтверждения, стартовый курсор индексатора |
| `OPERATOR_SECRET_KEY`, `DRY_RUN` | keypair оператора (делегат для бюджетов); `DRY_RUN=true` — без транзакций |
| `PRICE_SOURCE`, `INITIAL_PRICE_USD`, `PRICE_FEED_URL`, `JUPITER_PRICE_URL`, `PRICE_MAX_AGE_S`, `PRICE_MAX_STEP_BPS` | источник и границы опубликованной цены |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `HOUSE_BASE_URL` | платформенные ключи провайдеров и адрес house-модели (vLLM) |
| `SESSION_SECRET`, `KEYRING_MASTER_KEY`, `ADMIN_TOKEN` | сессии, шифрование BYOK-ключей, админ-маршруты |
| `MARKUP_BPS`, `BYOK_FEE_BPS`, `LOW_CREDIT_USD`, `VERY_LOW_CREDIT_USD`, `MIN_RESERVE_USD` | экономика и пороги роутера |
| `PRO_PRICE_USD`, `PRO_DAYS`, `WARM_HOUR_PRICE_USD`, `WARM_DRIVER` | апгрейды |
| `DRAW_THRESHOLD_USD`, `DRAW_INTERVAL_MS`, `BUDGET_SCAN_INTERVAL_MS` | списания из бюджетов и сканирование делегирований |
| `VITE_CLUSTER`, `VITE_RPC_URL`, `VITE_GATEWAY_URL`, `VITE_MINT_ADDRESS` | веб |

## Безопасность и доверие

- **Сжигание окончательно.** Кредит равен `amount · price` по опубликованной точке цены на момент наблюдения;
  точка записана в событии, история публична — любой может пересчитать начисления по транзакциям mint'а.
- **Своей программы нет.** Пользователь подписывает только `Burn` (окончательно) и `Approve` / `Revoke`
  (ограничено, отзываемо). Оператор подписывает только `Burn` как делегат в пределах `delegatedAmount`;
  перевести чужие токены он не может.
- **Цена off-chain**, с ограничением шага за обновление и флагом устаревания; изменения публикуются точками до
  применения. Сломанный фид может сместить начисления будущих сжиганий не более чем на `PRICE_MAX_STEP_BPS`.
- **Ключи.** API-ключи хранятся хэшами; BYOK — AES-256-GCM с мастер-ключом сервера; сессии случайные; SIWS-nonce
  одноразовые с истечением; CORS ограничен; `baseUrl` BYOK без редиректов (SSRF); лимиты размера тела и частоты.
- **Промпты не сохраняются** (только токены и стоимость), если не включён `LOG_PROMPTS`.
- Цены моделей в каталоге — снимок на 2026-10; оператор обновляет их через `MODEL_CATALOG_FILE`.

## Известные ограничения

- Из среды сборки mainnet/devnet недоступны: всё проверено на `solana-test-validator` (e2e) и офлайн-тестах;
  выход в сеть — по `docs/DEPLOY.md`.
- Доступность house-модели равна доступности GPU за `HOUSE_BASE_URL`; endpoint один на обе house-модели.
- Уровень `confirmed` в редких случаях откатывается: индексатор сверяет события с `finalized` и отменяет
  начисление, если транзакция исчезла.
- Бюджет — делегирование, а не эскроу: владелец может отозвать его до списания, поэтому шлюз списывает часто
  и ограничивает постоплатный долг резервом.
- `/v1/messages` покрывает основное подмножество Anthropic Messages API (текст, картинки, инструменты).

---

## English summary

**Beagle** replicates [Darwin Compute](https://x.com/darwincompute) ("better compute for agents") on **Solana**.
One API key gives access to every model — Claude, GPT, Gemini and the project's own house model (`gpt-oss`) —
through OpenAI-compatible `/v1/chat/completions`, Anthropic-compatible `/v1/messages` and an MCP server for
agents. Access is paid by **burning the BEAGLE SPL token from your own wallet** (a plain SPL `Burn`, optionally
with a memo naming another workspace); the gateway indexes the mint's burns, prices them with its published
price point at observation time and credits the workspace. No custom on-chain program, no e-mail, no card:
Sign-In-With-Solana, workspace = wallet. The router keeps the best model for hard requests, moves easy ones to
cheaper models, downgrades as credit or provider limits run down and falls back to the house model. BYOK keys
are stored encrypted and routed for free. Agents **authorize a budget** by delegating tokens to the operator
(SPL `Approve`); the operator burns from it as usage accrues, never above the cap, with a receipt hash in each
burn's memo; `Revoke` closes it. Upgrades (`pro`, `warm` GPU hours) are bought with credit. Packages:
`packages/shared/`, `packages/mcp/`, `gateway/`, `web/`, `solana/`. See `docs/SPEC.md` and `docs/DEPLOY.md`.
