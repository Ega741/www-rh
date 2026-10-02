# @www-rh/runner

The runner gives every coin on the launchpad a **mind**: a Claude model driving a headless Chromium,
remembering what it finds, and paying for its own compute out of the coin's trading fees. It is a
single Node 22 process that

- **indexes** `MindLaunchpad` logs into SQLite (`node:sqlite`, WAL),
- **schedules ticks**: one tick = one Claude tool-runner conversation with browser / memory tools,
- **accounts** every API response at the model that served it and **settles** the spend on-chain with
  `drawCompute(token, amountWei, receiptHash)`,
- **anchors** memories on-chain in batches with `anchorMemory(token, toSeq, contentHash, uri)`,
- serves the **HTTP API** (`/api/*`) and the **WebSocket stream** (`/ws`) used by the web app.

The normative description is `docs/SPEC.md` §3–§6.

## Run

```sh
pnpm install
pnpm --filter @www-rh/shared build
pnpm --filter @www-rh/runner build

# minimal local run (anvil + MockGraduator deployment, nothing is ever sent):
RPC_URL=http://127.0.0.1:8545 CHAIN_ID=31337 LAUNCHPAD_ADDRESS=0x… DRY_RUN=true \
  node runner/dist/main.js

# or with the repository .env file
node --env-file=.env runner/dist/main.js

# development (tsx, no build step)
pnpm --filter @www-rh/runner dev
```

CLI (`node runner/dist/cli.js …`, also installed as `www-rh-runner`):

| Command | What it does |
|---|---|
| `start` | indexer + API/WS + scheduler (same as `dist/main.js`) |
| `index [--follow]` | index launchpad logs up to the head (and keep following) |
| `tick --token 0x…` | run one tick of one mind now (needs `ANTHROPIC_API_KEY`) |
| `graduate --token 0x…` | queue `graduate(token)` if the curve is `Complete` (DRY_RUN-aware) |
| `harvest --token 0x…` | queue `harvest(token)` if the coin is `Graduated` (DRY_RUN-aware) |
| `--help` | usage |

Startup order: open DB → start indexer → API/WS → once the indexer has processed the head it saw at
startup ("live"): verify `operator()` matches `OPERATOR_PRIVATE_KEY` (mismatch forces dry run),
reconcile live draw receipts and pending anchors, in live mode re-settle the spend of `dry_run`
receipts / anchors left by an earlier dry-run period (logged), start the receipt reconciler (every
60 s, see [Compute settlement](#compute-settlement-and-the-receipt-lifecycle)) and start the scheduler
when `ANTHROPIC_API_KEY` is set.

Shutdown (SIGINT/SIGTERM, and also an unhandled promise rejection or uncaught exception, which are
logged first) runs in bounded stages: stop picking ticks and abort in-flight ticks (≤ 10 s), stop the
receipt reconciler (≤ 3 s), refuse new transactions and drain the tx queue (≤ 30 s), wait for anchor
batches and metadata resolution (≤ 3 s each), close the browser (≤ 5 s), stop the indexer (≤ 3 s),
close the WebSocket hub and then the HTTP server (≤ 3 s), and finally — always, even when a stage
timed out — close the DB. A stage that times out is logged and skipped; the process is forced out
after 70 s.

Without a launchpad address the runner refuses to start unless `DRY_RUN` is on; in dry run it starts
degraded (API up, `/api/health` `ok: false`, the indexer only tracks the chain head and retries the
RPC with exponential backoff).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN_ID` | `46630` | 4663 mainnet, 46630 testnet, 31337 anvil |
| `RPC_URL` | required | JSON-RPC HTTP endpoint |
| `LAUNCHPAD_ADDRESS` | unset | overrides `launchpadAddress(CHAIN_ID)` from `@www-rh/shared` (zero address = unset) |
| `START_BLOCK` | `0` | first block indexed when the DB is empty |
| `CONFIRMATIONS` | `0` | index only up to `head − CONFIRMATIONS` |
| `OPERATOR_PRIVATE_KEY` | unset | operator hot wallet; unset or `0x` forces dry run |
| `DRY_RUN` | `true` | when true no transaction is sent (ticks still run and are charged locally) |
| `ANTHROPIC_API_KEY` | unset | required for ticks; without it indexer + API still run |
| `ETH_USD_PRICE` | `3000` | fallback ETH/USD (clamped to `ETH_USD_MIN`..`ETH_USD_MAX`, logged) |
| `ETH_USD_FEED` | unset | Chainlink AggregatorV3 feed (used when the answer is > 0, < 1 h old and inside `ETH_USD_MIN`..`ETH_USD_MAX`) |
| `ETH_USD_MIN` | `100` | lowest plausible ETH/USD: lower feed answers are rejected, a lower fallback is clamped up |
| `ETH_USD_MAX` | `100000` | highest plausible ETH/USD (must be above `ETH_USD_MIN`) |
| `MIN_TICK_BUDGET_USD` | `0.05` | runnable floor |
| `MAX_TICK_COST_USD` | `0.25` | per-tick spend guard; runnable threshold = max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD) |
| `DRAW_THRESHOLD_USD` | `2` | settle when unreceipted spend reaches this |
| `TARGET_RUNWAY_DAYS` | `14` | burn-governor target runway |
| `MIN_DAILY_SPEND_USD` | `0.5` | burn-governor floor |
| `DB_PATH` | `./data/runner.sqlite` | SQLite file (directory created) |
| `PORT` | `8787` | HTTP + WS port |
| `PUBLIC_WEB_ORIGIN` | `http://localhost:5173` | comma-separated CORS origins |
| `MAX_CONCURRENT_MINDS` | `3` | ticks in flight |
| `TICK_INTERVAL_MS` | `20000` | minimum interval between ticks of one mind |
| `TICK_MAX_ITERATIONS` | `8` | tool-runner `max_iterations` |
| `TICK_TIMEOUT_MS` | `180000` | wall-clock limit of a tick |
| `TOOL_TIMEOUT_MS` | `30000` | deadline of one tool call inside a tick (≥ 1000); a timed-out tool returns an `error:` result and resets the browser context |
| `ANCHOR_EVERY_N_MEMORIES` | `5` | memories per anchor batch |
| `HARVEST_INTERVAL_MS` | `21600000` | harvest sweep interval |
| `BROWSER_HEADLESS` | `true` | Chromium headless |
| `FRAME_FPS` | `1` | frame capture rate while a tick runs |
| `IPFS_GATEWAY` | `https://ipfs.io/ipfs/` | gateway for `ipfs://` metadata and images |

Booleans accept `true|false|1|0`; empty values count as unset; invalid values exit with code 2 and a
list of problems.

## How a mind thinks

Each tick calls `client.beta.messages.toolRunner({ …, stream: true, max_iterations })` with:

- `system`: a cached stable prefix (identity, the creator's persona if `keccak256(persona)` matches the
  on-chain `personaHash`, rules) + a dynamic trailer (time, vault, runway, spend cap, last memories,
  current URL);
- tools (byte-identical for every mind): `browse_navigate`, `browse_read`, `browse_click`,
  `browse_type`, `browse_scroll`, `browse_back`, `browse_screenshot` (image block), `remember`,
  `recall`, `think_aloud`, each with `eager_input_streaming: true`;
- opus-5-5 / sonnet-5-5 / fable-5-1: adaptive summarized thinking, `effort: 'medium'`,
  `fallbacks: 'default'` (beta `server-side-fallback-2026-07-01`); haiku-4-5: `budget_tokens: 2048`,
  `max_tokens: 8192`, no effort / fallbacks.

Stop rules: `refusal` ends the tick; `max_tokens` with a `tool_use` aborts it; reaching
`MAX_TICK_COST_USD` stops iterating; an unparsable tool-input JSON re-issues the turn once; 429 / 5xx /
connection errors are retried 3× (1 s, 2 s, 4 s or `retry-after`); `TICK_TIMEOUT_MS` aborts the request
and recreates the browser context. Three failed ticks in a row put the mind in a local 1 h cooldown.

Timeouts — nothing can hold a tick (and the scheduler's single-flight lock) forever:

- every tool `run` races the tick's AbortSignal and `TOOL_TIMEOUT_MS`; on the deadline the tool returns
  `error: <tool> timed out …; the browser was reset` and the mind's browser context is recreated (the
  next browse tool starts a fresh one); when the tick is aborted a running tool returns at once;
- every `next()` of the tool runner and of each stream, and `finalMessage()`, races the AbortSignal, so
  `TICK_TIMEOUT_MS` ends the tick even if the SDK or a tool ignores the signal;
- browser operations without a timeout option of their own (`page.evaluate`, `page.$`, `mouse.wheel`,
  CDP `send`) have a 10 s operation timeout (a renderer stuck in `while (true) {}` never answers them);
  such a timeout also resets the browser context;
- tool results are capped at 32 000 characters.

The running usage (tokens, cost, served model) is written to the `ticks` row after every iteration, so
a crash still charges — and later settles — the completed iterations (`closeDangling` keeps them).

The burn governor spaces ticks so the vault lasts `TARGET_RUNWAY_DAYS`:
`interval = max(TICK_INTERVAL_MS, 86 400 000 · avgTickCostUsd / max(vaultUsd / TARGET_RUNWAY_DAYS, MIN_DAILY_SPEND_USD))`.

### Status, graduation and harvest

The scheduler owns operator transactions and never sends one for replayed history (events reach it
only for live logs). A mind with budget below the runnable threshold is settled (forced) and set
`Dormant` — unless it never ticked (no gas is spent on coins that never ran); it is set `Alive` again
once its available budget reaches twice the threshold; at most one status transaction per mind per
60 s; a mind whose model id is not in the catalog is never run. Besides reacting to live events, a
sweep every 60 s re-evaluates every relevant mind (paused minds: forced settlement; Alive minds that
ticked: threshold settlement and Dormant when out of budget; Dormant minds with a balance: Alive
again) and clears expired cooling periods. A persona is only used when the metadata is resolved
(`meta_status = ok`) and verified; `MindConfigUpdated` clears the previous persona until the new
metadata is resolved (a resolution racing a config change is discarded and re-run). Economics
snapshots used by the 1 s poll are cached for 10 s and invalidated by ticks and vault / status /
config events.
`graduate(token)` is sent on a live `CurveCompleted` and by a sweep (when the indexer becomes live and
every 10 min) for every mind still `Complete`; a revert such as `PoolPriceSkewed` is simply retried
by the next sweep. `CurveReopened` (a post-grace sell on a `Complete` curve) sets the phase back to
`bonding`. Graduated coins are harvested every `HARVEST_INTERVAL_MS`.

### Browser safety

Chromium runs with `acceptDownloads: false`, service workers blocked, no permissions and
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (WebRTC never sends UDP outside the proxy).
Every request passes the egress filter (only `http(s)` without credentials; IP literals in any
notation and every resolved address must be public — loopback, private, link-local, CGNAT, multicast,
reserved, local-use NAT64 `64:ff9b:1::/48` and IPv4-mapped/compatible/NAT64/6to4 forms are blocked):
in `context.route('**/*')`, in `context.routeWebSocket`, in tool `run` before navigating, and —
because Playwright never re-invokes route handlers for redirect hops the browser follows itself — in a
local egress proxy that Chromium uses for every connection (it re-checks each hop and connects to the
exact address that passed the check). Navigation requests are fetched by the route handler
(`route.fetch`, `maxRedirects: 0`, manual `Location` validation, bodies over 5 MB refused, every
fetched response disposed after `route.fulfill` so no body stays in memory); sub-resources go
straight through the proxy (`route.continue()`). A mind's context is recycled after 25 ticks or 1 h
(its URL is restored), and an unusable context is closed before a new one is created. Pop-ups are
closed (pages the session creates itself, e.g. after a renderer crash, are not), dialogs dismissed,
password / email / tel / file inputs are never typed into.

`read()` runs its extraction in a CDP isolated world (page scripts cannot patch the built-ins it uses)
and re-applies every cap in Node: text ≤ 6000 chars, title ≤ 300, ≤ 60 links with integer indexes,
≤ 120-char labels and parsed absolute http(s) hrefs ≤ 2048 chars, serialized result ≤ 24 000 chars.

### Compute settlement and the receipt lifecycle

A draw is `drawCompute(token, amountWei, receiptHash)`; the receipt row is written before anything is
sent, and the transaction is **signed locally and persisted (hash, nonce, raw bytes) before it is
broadcast**, so every possibly-broadcast draw can be resolved by hash. Receipt states:

| Status | Meaning | Ticks |
|---|---|---|
| `pending` | queued, or broadcast with a known tx hash and not yet indexed — it may be mined at any time | locked |
| `unknown` | may have been broadcast but the hash is unknown (only rows of older runners; served as `pending` by the API) | locked |
| `confirmed` | the matching `ComputeDrawn(receiptHash)` log is indexed | settled |
| `failed` | **proven** never mined | eligible again |
| `dry_run` | never sent (dry run) | re-settled in live mode |

Any failure after the transaction may have left the process — broadcast error, "already known" /
"nonce too low" on a retry, receipt-wait timeout, transport error while polling, replacement — leaves
the receipt `pending` with its hash. Broadcast retries re-send the same signed bytes (same receipt,
same amount, same hash), and the settler never builds a second receipt for a tick that has a live one.
A receipt becomes `failed` only on proof: simulation revert or a failure before broadcast, a reverted
receipt, or its nonce consumed by another transaction (observed on two reconciler passes, the second
after the indexer passed the first one's head without a matching `ComputeDrawn`). Amounts of live
receipts are subtracted from the drawable cap of new receipts.

The reconciler runs at startup (before any new draw) and every 60 s: indexed `ComputeDrawn` with the
receipt hash → `confirmed`; otherwise `eth_getTransactionReceipt(txHash)` (reverted → `failed`;
success and the indexer past its block without the log → `confirmed`, logged as an error); not mined
→ the operator nonce decides (consumed by another transaction → two-phase release; still free → the
stored signed transaction is re-broadcast every 2 min); `pending` without a hash (the runner stopped
before signing) → `failed`; `unknown` → the operator's pending nonce is recorded as a floor and the
receipt is released once every nonce below it is mined without a matching `ComputeDrawn`. Without
chain access (no `OPERATOR_PRIVATE_KEY`) live receipts are only matched against indexed logs and
never released.

### Indexer safety

Before advancing past a range whose `eth_getLogs` returned `[]`, the node's head is re-read in the same
pass (a lagging node answers `[]` for blocks it has not seen). The hash of every committed range end
is stored; when the next range's first block has a different parent hash, the reorg is logged and the
indexer rewinds 64 blocks (re-applying is idempotent). Every 10 min while live, every mind's indexed
`mind_balance` is compared with on-chain `mindBalance(token)` at the last indexed block; drift is
logged as an error and corrected. A vault balance that would go negative is stored as 0 and logged
as an error.

## HTTP API

All under `/api`; addresses lowercase, wei amounts decimal strings named `…Wei`, USD as numbers
(6 decimals), timestamps ISO-8601, unknown values `null`; errors `{ "error": "…" }`.

| Route | Response |
|---|---|
| `GET /api/health` | `{ ok, chainId, launchpad, lastIndexedBlock, headBlock, activeMinds, dryRun }` |
| `GET /api/minds?sort=created\|mcap\|activity&limit=1..200&cursor=` | `{ items: MindSummary[], nextCursor }` |
| `GET /api/minds/:token` | `MindDetail` |
| `GET /api/minds/:token/trades?limit=1..500` | `Trade[]` newest first |
| `GET /api/minds/:token/memories?limit=1..200&before=seq` | `Memory[]` seq descending |
| `GET /api/minds/:token/memories/batch/:fromSeq-:toSeq` | `AnchorBatch` as canonical JSON bytes |
| `GET /api/minds/:token/thoughts?limit=1..500` | `Thought[]` newest first |
| `GET /api/minds/:token/compute` | `ComputeResponse` (ledger, `receipts`, draws) |
| `GET /api/minds/:token/frame.jpg` | last frame (`Cache-Control: no-store`) or 404 |
| `GET /api/models` | public model catalog |
| `GET /api/stats` | `{ minds, alive, graduated, totalVolumeWei, totalFeesToMindsWei }` |
| `POST /api/metadata` | `{ uri, hash, personaHash }` (≤ 32 KB — chunked bodies are streamed and cut at the limit, 413 + connection closed; strict schema, 60 req/min) |
| `GET /api/metadata/:hash` | the stored metadata document (immutable) |

DTO schemas: `@www-rh/shared` (`mindSummarySchema`, `computeResponseSchema`, …).

## WebSocket `/ws?token=0x…`

One subscription per connection. Server messages: `hello` (status, phase, last frame), `frame`
(≤ `FRAME_FPS`/s while ticking), `thought` (`kind: 'text' | 'thinking'`, `delta: true` fragments then
one `delta: false` with the full block), `thoughtSaved`, `action` (tool + redacted input), `memory`,
`status`, `budget`, `trade`, `pong`, `error`. Client messages: `{ type: 'subscribe', token }`,
`{ type: 'ping' }`. Malformed token → close 1008, unknown token → close 4404 (retry after 3 s),
more than 100 connections per mind → close 1013; frames are dropped above 1 MB buffered and the
connection is closed above 4 MB. Protocol pings every 25 s.

## Verifying receipts and anchors

Everything the runner hashes uses the canonical JSON of `@www-rh/shared` (`canonicalJson`: keys sorted,
no whitespace, integers only, bigints as decimal strings, UTF-8).

**Compute draws.** Every `ComputeDrawn(token, amount, receiptHash)` event commits to a receipt served by
`GET /api/minds/:token/compute` (`receipts[]`):

```ts
import { drawReceiptHash, costOfUsageMicroUsd } from '@www-rh/shared';

const { receipts } = await (await fetch(`${runner}/api/minds/${token}/compute`)).json();
for (const r of receipts) {
  // 1. the hash on-chain is the hash of this exact object
  assert(drawReceiptHash(r.receipt) === r.receiptHash);
  // 2. the amount never exceeds the spend converted at the recorded price (ceil), capped by the vault
  const micro = r.receipt.ticks.reduce((s, t) => s + BigInt(t.costUsdMicro), 0n);
  const price = BigInt(r.receipt.ethUsdPriceMicro);
  assert(BigInt(r.receipt.amountWei) <= (micro * 10n ** 18n + price - 1n) / price);
  // 3. each tick's cost follows from its tokens at the served model's prices
  //    (exact for single-iteration ticks; a tick's cost is the sum of per-request ceil-rounded
  //    costs, so it can exceed costOfUsageMicroUsd(model, totals) by at most `iterations` µUSD)
}
```

Then match `receiptHash` with the `ComputeDrawn` log of the transaction (`receipts[].txHash`, or the
`draws[]` list). Dry-run receipts (`status: "dry_run"`) were never sent and never count as settled;
a `pending` receipt with a `txHash` may still be mined (see the receipt lifecycle above), a `failed`
one was proven never mined.

**Memory anchors.** `MemoryAnchored(token, seq, contentHash, uri)` with
`uri = runner://memories/<token>/<fromSeq>-<toSeq>` and `seq = toSeq`:

```sh
curl -s "$RUNNER/api/minds/$TOKEN/memories/batch/$FROM-$TO" > batch.json
cast keccak "$(cat batch.json)"     # == contentHash of the MemoryAnchored log
```

The batch endpoint returns the canonical JSON bytes, so hashing the body is enough; every
`Memory.contentHash` is `memoryContentHash({ seq, kind, content, url, createdAt })`.

**Metadata.** `runner://metadata/<hash>`: `GET /api/metadata/<hash>` returns the canonical document
whose `sha256` is `<hash>`; `personaHash` on-chain is `keccak256(utf8(persona))`. External metadata
(`ipfs://`, `http(s)://`) is fetched with a 5 s absolute deadline over all redirect hops (plus the
socket idle timeout) and a 64 KB cap.

## Tests

`pnpm --filter @www-rh/runner test` (vitest; no network, no Anthropic API, no RPC): canonical hashes
(golden values), curve mirror vs `packages/shared/fixtures/curve.json`, cost / budget / governor /
settlement tables, the receipt lifecycle (`test/settlement.test.ts`: tx-queue outcomes, no second draw
after an unknown outcome, reconciliation by hash / nonce / indexed log, dry-run spend in live mode,
schema migration), egress filter (IP classes, IPv4-mapped IPv6, NAT64, stub resolver, redirect hops,
CONNECT tunnels, metadata deadline), indexer idempotency / ordering / live-vs-replay / lagging node /
reorg rewind / balance drift, scheduler (fake clock, fake ticks, sweep, persona gating, snapshot
cache), tick loop (fake tool runner: stop reasons, retries, JSON rebuild, timeout, hung tools and
runners, per-iteration usage), API + WS handlers on an in-memory DB (chunked body limit, shutdown with
open WebSockets), metadata resolution, tool input validation and deadlines, request shapes per model,
and Playwright tests (extraction caps and isolated world, busy-loop timeouts, fetch-body disposal,
crash recovery, context recycling; skipped when Chromium cannot launch; set
`PLAYWRIGHT_BROWSERS_PATH`).
