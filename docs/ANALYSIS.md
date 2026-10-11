# Анализ проекта Darwin (@darwincompute) и план порта на Robinhood Chain

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

## 3. Что переносим и что меняем для Robinhood Chain

Robinhood Chain — EVM L2 на стеке Arbitrum Orbit (Nitro), газ в ETH, блоки ~100 мс, mainnet chain id
**4663**, testnet **46630**. Роль pump.fun играет лаунчпад **Pons V2** (ponsfamily.com): токен проекта на
mainnet запускается на Pons, а наш контракт принимает любой ERC-20 (`docs/ROBINHOOD_CHAIN.md`).

| Компонент | Darwin / Solana | Beagle / Robinhood Chain (наша реализация) |
|---|---|---|
| Токен | SPL `$DARWIN` (pump.fun) | ERC-20 `BEAGLE` (1 млрд, фикс. эмиссия) — на testnet/anvil наш `BeagleToken`; на mainnet токен с Pons |
| Сжигание → кредит | Транзакция burn, сервис начисляет по своему курсу | Контракт **`CreditDesk.burnForCredit(workspace, amount)`**: сжигает токены (burn или перевод на `0x…dEaD`) и **пишет в событие USD-номинал по ончейн-цене** `IPriceSource`. Кредит начисляется ровно по событию — любой может пересчитать |
| Курс токена | Внутренний | `ManualPriceSource` (оператор публикует цену с ограничением шага/частоты) или `ChainlinkPriceSource`; квота отклоняется при устаревшей цене |
| Бюджет агента | «authorize a budget from the wallet» | **`openBudget(workspace, cap, deadline)`** + `approve`: оператор списывает (`draw`) токены по мере потребления, не выше `cap`, с хэшем квитанции об использовании; агент в любой момент закрывает бюджет |
| Вход | Кошелёк Solana | **SIWE** (EIP-4361) кошельком EVM; workspace = адрес |
| API | OpenAI-совместимый | OpenAI-совместимый `/v1/chat/completions` (+ stream) и Anthropic-совместимый `/v1/messages`; один ключ `bgl_…` |
| Роутер | «auto», спуск по лимитам | Детерминированная политика в `@beagle/shared`: сложность → уровень (frontier/efficient/budget/house), понижение при малом остатке кредита и при деградации провайдера (circuit breaker по 429/5xx), последняя ступень — house-модель |
| BYOK | Зашифрованные ключи | AES-256-GCM с мастер-ключом сервера; запросы через BYOK кредит не тратят |
| Своя модель | gpt-oss / Qwen на GPU | `house/gpt-oss-20b` (по умолчанию) и `house/gpt-oss-120b` (Pro) через vLLM (OpenAI-совместимый endpoint); в разработке — мок |
| Апгрейды | Pro, warm hours | `pro` (30 дней) и `warm` (часы) покупаются кредитом; драйвер «тёплого» GPU — подключаемый |
| MCP | MCP-сервер для агентов | `@beagle/mcp`: stdio-бинарь и HTTP-транспорт `/mcp` в шлюзе; инструменты баланс/модели/квота/запрос/покупка compute/бюджет/апгрейд |
| Тарифы | По курсу токена | Кредит в µUSD; каталог цен моделей + наценка (`MARKUP_BPS`); стоимость в токенах следует за ончейн-ценой автоматически |

Что добавляем сверх оригинала (дёшево и усиливает доверие): квитанции по каждому запросу с канонической
JSON-записью и хэшем; хэш пакета использования в `draw` бюджета; публичный `/api/status` с лагом
индексатора и здоровьем провайдеров.

Чего не делаем: собственный лаунчпад (на mainnet — Pons), фьючерсы по токену, свой GPU-парк (в репозитории —
compose-профиль с vLLM).

## 4. Архитектура порта (кратко)

```
  пользователь / агент                        оператор (горячий кошелёк шлюза)
     │ approve + burnForCredit()                  │ draw(budgetId, amount, receiptHash)
     │ approve + openBudget()                     │ post(price) → ManualPriceSource
     ▼                                            ▼
┌──────────────────────────────────────────────────────────────┐
│ CreditDesk (Robinhood Chain)                                 │
│  • quote(amount) по IPriceSource (свежесть ≤ maxPriceAge)    │
│  • burnForCredit → CreditPurchased(receiptId, workspace, …) │
│  • openBudget / draw / closeBudget → Budget* события         │
└───────────────────────────┬──────────────────────────────────┘
                            │ события (viem getLogs)
                            ▼
┌──────────────────────────────┐   REST /api/*   ┌──────────────────┐
│ gateway (Node 22, Hono)      │ ◀─────────────▶ │ web (Vite/React) │
│  индексатор → SQLite-леджер  │                 │  лендинг         │
│  SIWE, API-ключи, BYOK       │                 │  Credits (burn)  │
│  роутер + метеринг           │                 │  ключи, usage    │
│  /v1/chat/completions        │ ◀── агенты ──▶  │  бюджеты, Pro    │
│  /v1/messages, /mcp          │  MCP stdio/HTTP │                  │
└──────────┬───────────────────┘                 └──────────────────┘
           │ Anthropic SDK · OpenAI-совместимые (OpenAI, Gemini, vLLM house)
           ▼
     провайдеры моделей
```

Нормативное описание — `docs/SPEC.md`. Сеть и адреса — `docs/ROBINHOOD_CHAIN.md`. Развёртывание —
`docs/DEPLOY.md`.
