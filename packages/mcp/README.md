# @beagle/mcp

MCP server that gives agents access to [Beagle](../../README.md): one API key for every model, paid for
by burning BEAGLE on Robinhood Chain. Ships as a stdio binary (`beagle-mcp`) and as a library the gateway
mounts at `/mcp` (Streamable HTTP). Spec: `docs/SPEC.md` §6.

## Quick start (Claude Desktop / Claude Code)

The package is **not published to npm** (it is a workspace package built to `dist/`), so run the local build.
Build it once from the repository root, then point your MCP client at `dist/bin.js` with an **absolute** path
(MCP clients spawn the server from their own working directory, so a relative path breaks):

```sh
pnpm --filter @beagle/mcp build      # → <repo>/packages/mcp/dist/bin.js
```

Claude Desktop (`claude_desktop_config.json`) or any client that takes the same shape:

```json
{
  "mcpServers": {
    "beagle": {
      "command": "node",
      "args": ["/abs/path/to/www-rh/packages/mcp/dist/bin.js"],
      "env": {
        "BEAGLE_API_URL": "https://beagle.example.com",
        "BEAGLE_API_KEY": "bgl_…"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add beagle -e BEAGLE_API_URL=https://beagle.example.com -e BEAGLE_API_KEY=bgl_… \
  -- node /abs/path/to/www-rh/packages/mcp/dist/bin.js
```

Once the package is published, `"command": "npx", "args": ["-y", "@beagle/mcp"]` will work as well; until then
`npx @beagle/mcp` fails with E404, and an unpublished scoped name is nothing to hand your API key to.

Alternatively connect to the gateway's HTTP transport directly: `https://beagle.example.com/mcp` with
`Authorization: Bearer bgl_…` (no local process; wallet tools then return unsigned transaction steps).

## Environment

| Variable | Meaning |
|---|---|
| `BEAGLE_API_KEY` | **required** — `bgl_…` API key (Keys page or `beagle-gateway create-key`). Missing → exit code 2. |
| `BEAGLE_API_URL` | gateway origin; default `http://localhost:8787` |
| `BEAGLE_AGENT_PRIVATE_KEY` | optional `0x` private key of the agent wallet. With it `beagle_buy_compute` / `beagle_open_budget` sign and send (`approve` → `burnForCreditMin` / `openBudget`), wait for the receipt and poll the balance until the credit lands (see *Timing*). Without it they return unsigned steps. |
| `BEAGLE_RPC_URL` | optional JSON-RPC URL for the agent wallet; default: the chain's public RPC from `@beagle/shared/chains`. The executor checks the node's chain id against the gateway's before sending anything (`chain_mismatch`). |
| `BEAGLE_WORKSPACE` | optional default workspace (0x address) for the wallet tools. Without it the tools fall back to the **agent wallet address**, which is only a guess at your API key's workspace: results then carry `workspaceSource: "agent_wallet"` and a warning. Set it (or pass `workspace`) when the key's workspace is not the agent wallet. |

Chain id and the CreditDesk / token addresses come from the gateway (`GET /api/config`). The stdio binary
connects its transport **before** talking to the gateway: the agent wallet's address is derived from the key
immediately, and the chain / desk details are fetched on the first wallet-tool call and retried on each call
until that succeeds. A gateway that is down or slow when the client spawns the binary therefore neither delays
the MCP handshake nor downgrades the session; the affected call returns `isError` with code `wallet_unavailable`
(nothing was sent) and the next call tries again. All logging goes to stderr; stdout is the MCP channel.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `beagle_balance` | — | balance / reserved / headroom / available (µUSD strings), plan, token price, `summary` (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`) |
| `beagle_models` | `{ tier? }` | catalog with prices (µUSD per 1M + human), availability, Pro gating, aliases |
| `beagle_quote` | `{ usd? \| tokens? }` | tokens ↔ µUSD at the desk's on-chain price |
| `beagle_complete` | `{ prompt? \| messages?, system?, model? (beagle/auto), max_tokens?, difficulty? }` | `{ text, model, provider, paidBy, costMicro, balanceMicro, finishReason, requestId, usage }` — **costs credit** |
| `beagle_usage` | `{ limit?, window? (24h\|7d\|30d) }` | rows + summary |
| `beagle_buy_compute` | `{ usd? \| tokens?, workspace?, tolerance_bps? (0–5000, default 100) }` | with a wallet: `{ executed, txHash, receiptId?, creditedMicro, credited, balanceMicro, minUsdMicro, toleranceBps, workspaceSource, elapsedMs, … }`; else `{ unsigned: true, chainId, steps: [{ to, data, value: '0', description }], minUsdMicro, toleranceBps, … }` — **burns tokens**, with a credit floor (see below) |
| `beagle_open_budget` | `{ usd? \| tokens?, hours (1–720), workspace? }` | with a wallet: `{ executed, txHash, budgetId, workspaceSource, … }`; else unsigned steps |
| `beagle_budgets` | — | `BudgetDto[]` with formatted amounts, `active` / `countsAsHeadroom` per row and the total headroom (open, unexpired, not stalled — the same predicate as `/api/balance`) |
| `beagle_upgrade` | `{ kind: 'pro' \| 'warm', quantity? }` | `UpgradeDto` — **costs credit**; prices are in `beagle_status.upgradePrices` |
| `beagle_status` | — | chain, indexer, provider health, house model, operator, `upgradePrices` |

Amounts: `usd` and `tokens` accept numbers or decimal strings; numbers are read at their shortest decimal
form, so `tokens: 0.1` is exactly `0.1 BEAGLE` (`1e17` raw), never `0.100000000000000006`.

Every result is JSON text plus `structuredContent` (bigints as decimal strings). Failures are `isError`
results with `{ error: { code, message, status? } }`, `code` being the gateway error code
(`insufficient_credit`, `invalid_api_key`, `rate_limited`, …), `invalid_request` / `internal_error`, or a
wallet code (`wallet_unavailable`, `chain_mismatch`, `simulation_failed`, `slippage_exceeded`, `tx_failed`,
`tx_reverted`, …).

Resources: `beagle://models` (markdown table), `beagle://quickstart`.

### Credit floor (`tolerance_bps`)

A burn is final, and the desk credits the USD value **at the price it reads when the transaction is mined**, not
the one the quote showed: a price post can land in between. Every burn this package initiates therefore goes
through `burnForCreditMin(workspace, amount, minUsdMicro)` with

```
minUsdMicro = quotedUsdMicro − ceil(quotedUsdMicro · tolerance_bps / 10 000)      (default tolerance_bps = 100, i.e. 1 %)
```

The contract reverts with `SlippageExceeded(usdMicro, minUsdMicro)` instead of crediting less than the floor;
a reverted burn costs only gas and burns nothing (the approve, if one was sent, stays in place and is reused by
the retry). `tolerance_bps` is an integer `0–5000`: `0` demands exactly the quoted amount, larger values accept
more slippage. The result carries `minUsdMicro`, `minUsd` and `toleranceBps`; the unsigned steps encode the floor
in the `burnForCreditMin` calldata and spell it out in the step description.

With a wallet the executor simulates first, so a stale quote surfaces as `isError` code `slippage_exceeded`
(message with both numbers) before anything is sent. If the price moves between the simulation and inclusion,
the mined transaction reverts; the executor replays the call at the receipt's block to tell `SlippageExceeded`
apart (`slippage_exceeded` with the `txHash`) from any other revert (`tx_reverted`). In either case re-quote and
retry, or pass a larger `tolerance_bps`. Plain `burnForCredit` (no floor) is left to third parties and to the
library's `buildUnsignedSteps` / `buyCompute` when called without `minUsdMicro`; the tool always has a quote and
always sets a floor. `creditFloor(quotedUsdMicro, toleranceBps?)` is exported for callers that build their own
transactions.

### Purchases, allowances and budgets

`beagle_buy_compute` with a wallet approves **current allowance + amount**, not `amount`: the desk's
`allowance(owner, desk)` is shared by every open budget of the wallet (headroom = min(cap − drawn, allowance,
balance)) and `burnForCreditMin` spends it, so an exact approve would silently shrink or stall those budgets.
`beagle_open_budget` adds its cap on top of the existing allowance for the same reason. Only an effectively
unlimited allowance is left untouched (adding to it would overflow `uint256`). The unsigned steps approve exactly
the amount; their descriptions tell a wallet with open budgets to add to its allowance instead.

`creditedMicro` is the `usdMicro` from the decoded `CreditPurchased` event (the exact amount the gateway
books), `credited` tells whether it is visible on the key's workspace yet; the balance poll compares against
the lowest balance seen, so a completion settling concurrently does not hide the credit.

### Timing and timeouts

MCP clients drop a tool call after their request timeout (the SDK default is 60 s; Claude Desktop uses the
same). A purchase is approve receipt + burn receipt + indexer lag, so `beagle_buy_compute` keeps its total
time under a budget (`callBudgetMs`, default 45 s, measured from the call start): once the burn is mined it
polls `/api/balance` only until that budget or `creditWaitMs` (60 s, SPEC §6.1) runs out, whichever is
first, and returns `executed: true, credited: false` with the `txHash` rather than letting the client time
out. While waiting it sends `notifications/progress` for clients that reset their timeout on progress.

If a call still times out on the client side, **the burn may have gone through**: check `beagle_balance`,
`beagle_usage` or the explorer link before retrying — never retry a purchase blindly. The same holds for
`beagle_complete`: a request the client gave up on may still have been served and charged; `beagle_usage`
lists it.

## Library

```ts
import { createBeagleMcpServer, createRestBeagleApi, createViemWalletExecutor } from '@beagle/mcp';

const api = createRestBeagleApi({ baseUrl: 'http://localhost:8787', apiKey: 'bgl_…' });
const server = createBeagleMcpServer(api, {
  wallet: createViemWalletExecutor({ privateKey, chainId: 31337, deployment: { creditDesk, token } }), // optional
  workspace: '0x…', // optional default for the wallet tools
  callBudgetMs: 45_000, // optional: total time budget of beagle_buy_compute
});
await server.connect(transport);
```

`BeagleApi` (SPEC §6.2) is the only dependency of the tools; the gateway passes an in-process implementation
bound to the key's workspace. `complete(req, options?)` may attach `beagle` metadata (cost, balance, provider,
paidBy) to the completion; the tools fall back to `balance()` when it is absent. `createLazyWalletExecutor`
wraps a wallet whose construction needs the network (what the binary does); `createAgentWallet(api, config)`
is the binary's own wiring. `WalletExecutor.buyCompute({ workspace, tokens, minUsdMicro? })` and
`buildUnsignedSteps({ action: 'buyCompute', …, minUsdMicro? })` use `burnForCreditMin` when a floor is given
and plain `burnForCredit` otherwise; `creditFloor`, `DEFAULT_TOLERANCE_BPS` (100) and `MAX_TOLERANCE_BPS`
(5000) implement the policy above.

## Development

```sh
pnpm --filter @beagle/mcp build     # tsc → dist/
pnpm --filter @beagle/mcp typecheck
pnpm --filter @beagle/mcp test      # vitest: in-memory BeagleApi fake, SDK InMemoryTransport, fetch stub, fake JSON-RPC node
```
