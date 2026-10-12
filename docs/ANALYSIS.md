# Анализ проекта Darwin (@darwincompute) и план порта (Solana)

## 1. Что такое Darwin Compute

Источники: аккаунт [x.com/darwincompute](https://x.com/darwincompute) («Darwin», bio: *better compute
for agents*, зарегистрирован в октябре 2026), сайт `darwincompute.com` (лендинг и `/app`), индексированные
посты и описания. Прямой доступ к x.com и к сайту из среды сборки закрыт, поэтому разбор собран по
индексированным фрагментам; формулировки ниже — цитаты из этих фрагментов.

**Суть продукта (одна фраза):** платная шина вычислений для ИИ-агентов — один API-ключ на все модели
(Claude, GPT, Gemini и свои GPU-модели) с автоматическим роутером, где доступ оплачивается не картой, а
**сжиганием токена `$DARWIN`** (Solana, запущен через pump.fun) из кошелька пользователя или самого агента.

Ключевые формулировки проекта:

- «**One API key for every model.** An MCP server for your agents.» — один ключ и MCP-сервер для агентов.
- «Darwin is paid for by **burning $DARWIN from your wallet**; no email, no card.» — доступ покупается
  сжиганием токена; никаких e-mail и карт. Вход на сайт — кошельком Solana; «new wallets get a
  workspace on first sign-in» — у каждого кошелька свой workspace.
- «Burning it from your wallet on the **Credits page** adds credit to your workspace, and the API and the
  MCP server only work while there is credit.» — сжигание на странице Credits превращается в кредит
  workspace'а; API и MCP работают, пока есть кредит.
- «**Model router** for when your usage runs low … easy requests go to cheaper models, hard ones stay on
  the big one.» и «Darwin keeps your best model for hard work, moves easy requests to cheaper ones as its
  limit runs down, and runs its own GPU model when everything else is spent.» — роутер держит лучшую
  модель для сложных задач, по мере исчерпания лимитов переводит простые запросы на дешёвые модели, а
  когда всё исчерпано — на собственную GPU-модель.
- «Routing to your own provider keys doesn't consume credit … provider keys are stored encrypted.» —
  можно подключить свои ключи провайдеров (BYOK): запросы через них кредит не тратят, ключи хранятся
  зашифрованными.
- Собственная GPU-модель: по лендингу — `gpt-oss-120b` («Pro moves an agent to gpt-oss-120b with a
  128K context»), в постах упоминается и Qwen3 30B как модель на их GPU. «**Warm hours** keep a GPU
  running so it never waits for a cold start» — за кредит можно купить «тёплые часы» GPU.
- Агентный сценарий: «the agent can **authorize a budget from its Solana wallet**, and compute gets
  provisioned» — агент сам выдаёт бюджет из своего кошелька, и под него выделяется compute.
- Экономика: «Darwin's rates will update shortly to match the $darwin price, so inference and burns will
  cost more. New rates will be posted before they take effect.» — тарифы привязаны к курсу токена.
- Токен: `5VnbrKp28Qs9CAH6PyZdxBNvLxZcbeX3YBsozgWnpump` (pump.fun, Solana). Команда предупреждает об
  имитаторе `@DarwinNFTx`.

## 2. Механика (реконструкция)

| Элемент | Как устроено у Darwin (Solana) |
|---|---|
| Вход | Подпись сообщения кошельком Solana → workspace на кошелёк. Нет e-mail/пароля/карты. |
| Пополнение | Страница Credits: пользователь сжигает `$DARWIN` из своего кошелька; сервис видит транзакцию и начисляет кредит workspace'у по текущему курсу токена. |
| Доступ | API-ключ workspace'а. OpenAI-совместимый endpoint (один `base_url` + ключ) и MCP-сервер. Работают только при положительном кредите. |
| Роутер | Псевдомодель «auto»: сложность запроса → уровень модели. По мере исчерпания лимитов/кредита — спуск к дешёвым моделям; последняя ступень — своя GPU-модель. |
| BYOK | Свои ключи Claude/GPT/Gemini; запросы через них не списывают кредит. Ключи шифруются. |
| Своя GPU-модель | Открытые веса (`gpt-oss-20b/120b`, Qwen3 30B) на своих GPU. Pro-апгрейд даёт 120B и 128K контекста; «тёплые часы» держат GPU без холодного старта. |
| Агенты | MCP-сервер даёт агенту баланс, модели, запуск запросов и покупку compute; агент может **авторизовать бюджет** из своего кошелька под задачу. |
| Тарифы | Цены в токенах пересчитываются по курсу `$DARWIN`; изменения публикуются заранее. |

## 3. Что переносим и что меняем для Solana

Оригинал живёт на Solana, и порт остаётся на Solana: токен — SPL-mint (на mainnet — запущенный через
pump.fun, 6 знаков), оплата — обычный SPL-`Burn` из кошелька пользователя, никакой собственной программы.
Это ровно то, что делает Darwin («burning $DARWIN from your wallet»): сервис смотрит на сжигания своего
mint'а и начисляет кредит по опубликованному курсу.

| Компонент | Darwin | Beagle (наша реализация) |
|---|---|---|
| Токен | SPL `$DARWIN` (pump.fun) | SPL `BEAGLE`; на localnet/devnet создаётся скриптом `solana/scripts/setup-cluster.sh` (6 знаков, эмиссия 1 млрд, mint authority отключён) |
| Сжигание → кредит | Burn из кошелька, сервис начисляет по своему курсу | **SPL `BurnChecked`** из кошелька (+ опциональный Memo `beagle:v1 ws=<pubkey>`, чтобы зачислить другому workspace). Индексатор находит сжигания через `getSignaturesForAddress(mint)` и начисляет `amount · price` по **опубликованной точке цены** на момент наблюдения; точка цены записывается в событие |
| Курс токена | Внутренний, «rates follow the $darwin price» | `PriceService`: manual / HTTP-feed / Jupiter Price API; история точек публична (`/api/price/history`), шаг ограничен, устаревание помечается |
| Бюджет агента | «authorize a budget from the Solana wallet» | **SPL-делегирование**: агент делает `ApproveChecked(ata, delegate = оператор, cap)`; оператор сжигает из счёта агента как делегат по мере потребления (memo с хэшем квитанции), SPL сам уменьшает `delegatedAmount`; `Revoke` закрывает бюджет в любой момент |
| Вход | Кошелёк Solana | **Sign-In-With-Solana** (подпись сообщения, проверка ed25519); workspace = публичный ключ |
| API | OpenAI-совместимый | OpenAI-совместимый `/v1/chat/completions` (+ stream) и Anthropic-совместимый `/v1/messages`; один ключ `bgl_…` |
| Роутер | «auto», спуск по лимитам | Детерминированная политика в `@beagle/shared`: сложность → уровень (frontier/efficient/budget/house), понижение при малом остатке кредита и деградации провайдера (circuit breaker), последняя ступень — house-модель |
| BYOK | Зашифрованные ключи | AES-256-GCM с мастер-ключом сервера; запросы через BYOK кредит не тратят |
| Своя модель | gpt-oss / Qwen на GPU | `house/gpt-oss-20b` и `house/gpt-oss-120b` (Pro) через vLLM; в разработке — мок |
| Апгрейды | Pro, warm hours | `pro` (30 дней) и `warm` (часы) покупаются кредитом |
| MCP | MCP-сервер для агентов | `@beagle/mcp`: stdio-бинарь и HTTP-транспорт `/mcp`; инструменты баланс/модели/квота/запрос/покупка compute/бюджет (approve, revoke)/апгрейд; с ключом агента транзакции исполняются сами, без — возвращаются неподписанными |
| Тарифы | По курсу токена | Кредит в µUSD; каталог цен моделей + наценка; стоимость в токенах следует за опубликованной ценой |

Что добавляем сверх оригинала: квитанция по каждому запросу (канонический JSON + хэш), хэш пакета
использования в memo каждого списания из бюджета, публичная история цены, `/api/status` с лагом
индексатора и здоровьем провайдеров.

Чего не делаем: собственная on-chain программа (не нужна — SPL Token даёт и сжигание, и делегирование),
лаунчпад (на mainnet — pump.fun), свой GPU-парк (в репозитории — compose-профиль с vLLM).

## 4. Архитектура порта (кратко)

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
┌──────────────────────────────┐   REST /api/*   ┌──────────────────┐
│ gateway (Node 22, Hono)      │ ◀─────────────▶ │ web (Vite/React) │
│  индексатор → SQLite-леджер  │                 │  wallet-adapter  │
│  точки цены (публичные)      │                 │  Credits (burn)  │
│  SIWS, API-ключи, BYOK       │                 │  Budgets (approve│
│  роутер + метеринг           │ ◀── агенты ──▶  │   / revoke)      │
│  /v1/chat/completions, /mcp  │  MCP stdio/HTTP │  ключи, usage    │
└──────────┬───────────────────┘                 └──────────────────┘
           │ Anthropic SDK · OpenAI-совместимые (OpenAI, Gemini, vLLM house)
           ▼
     провайдеры моделей
```

Нормативное описание — `docs/SPEC.md`. Сеть, RPC, эксплореры, фаучеты — `docs/SOLANA.md`. Развёртывание —
`docs/DEPLOY.md`.
