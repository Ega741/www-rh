# @beagle/mcp

MCP server that gives agents access to [Beagle](../../README.md): one API key for every model, paid for
by burning BEAGLE on Robinhood Chain. Ships as a stdio binary (`beagle-mcp`) and as a library the gateway
mounts at `/mcp` (Streamable HTTP). Spec: `docs/SPEC.md` §6.

## Quick start (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "beagle": {
      "command": "npx",
      "args": ["-y", "@beagle/mcp"],
      "env": {
        "BEAGLE_API_URL": "https://beagle.example.com",
        "BEAGLE_API_KEY": "bgl_…"
      }
    }
  }
}
```

Inside this repository: `pnpm --filter @beagle/mcp build` and point `command` at `node`,
`args` at `packages/mcp/dist/bin.js`. Claude Code: `claude mcp add beagle -e BEAGLE_API_KEY=bgl_… -- node packages/mcp/dist/bin.js`.

Alternatively connect to the gateway's HTTP transport directly: `https://beagle.example.com/mcp` with
`Authorization: Bearer bgl_…` (no local process; wallet tools then return unsigned transaction steps).

## Environment

| Variable | Meaning |
|---|---|
| `BEAGLE_API_KEY` | **required** — `bgl_…` API key (Keys page or `beagle-gateway create-key`). Missing → exit code 2. |
| `BEAGLE_API_URL` | gateway origin; default `http://localhost:8787` |
| `BEAGLE_AGENT_PRIVATE_KEY` | optional `0x` private key of the agent wallet. With it `beagle_buy_compute` / `beagle_open_budget` sign and send (`approve` → `burnForCredit` / `openBudget`), wait for the receipt and poll the balance until the credit lands (≤ 60 s). Without it they return unsigned steps. |
| `BEAGLE_RPC_URL` | optional JSON-RPC URL for the agent wallet; default: the chain's public RPC from `@beagle/shared/chains` |
| `BEAGLE_WORKSPACE` | optional default workspace (0x address) for the wallet tools; otherwise the agent wallet address, otherwise the tool call must pass `workspace` |

Chain id and the CreditDesk / token addresses come from the gateway (`GET /api/config`). All logging goes to
stderr; stdout is the MCP channel.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `beagle_balance` | — | balance / reserved / headroom / available (µUSD strings), plan, token price, `summary` (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`) |
| `beagle_models` | `{ tier? }` | catalog with prices (µUSD per 1M + human), availability, Pro gating, aliases |
| `beagle_quote` | `{ usd? \| tokens? }` | tokens ↔ µUSD at the desk's on-chain price |
| `beagle_complete` | `{ prompt? \| messages?, system?, model? (beagle/auto), max_tokens?, difficulty? }` | `{ text, model, provider, paidBy, costMicro, balanceMicro, finishReason, requestId, usage }` — **costs credit** |
| `beagle_usage` | `{ limit?, window? (24h\|7d\|30d) }` | rows + summary |
| `beagle_buy_compute` | `{ usd? \| tokens?, workspace? }` | with a wallet: `{ executed, txHash, receiptId?, creditedMicro, balanceMicro, … }`; else `{ unsigned: true, chainId, steps: [{ to, data, value: '0', description }] }` — **burns tokens** |
| `beagle_open_budget` | `{ usd? \| tokens?, hours (1–720), workspace? }` | with a wallet: `{ executed, txHash, budgetId, … }`; else unsigned steps |
| `beagle_budgets` | — | `BudgetDto[]` with formatted amounts and total headroom |
| `beagle_upgrade` | `{ kind: 'pro' \| 'warm', quantity? }` | `UpgradeDto` — **costs credit** |
| `beagle_status` | — | chain, indexer, provider health, house model, operator |

Every result is JSON text plus `structuredContent` (bigints as decimal strings). Failures are `isError`
results with `{ error: { code, message, status? } }`, `code` being the gateway error code
(`insufficient_credit`, `invalid_api_key`, `rate_limited`, …) or `invalid_request` / `internal_error`.

Resources: `beagle://models` (markdown table), `beagle://quickstart`.

## Library

```ts
import { createBeagleMcpServer, createRestBeagleApi, createViemWalletExecutor } from '@beagle/mcp';

const api = createRestBeagleApi({ baseUrl: 'http://localhost:8787', apiKey: 'bgl_…' });
const server = createBeagleMcpServer(api, {
  wallet: createViemWalletExecutor({ privateKey, chainId: 31337, deployment: { creditDesk, token } }), // optional
  workspace: '0x…', // optional default for the wallet tools
});
await server.connect(transport);
```

`BeagleApi` (SPEC §6.2) is the only dependency of the tools; the gateway passes an in-process implementation
bound to the key's workspace. `complete(req, options?)` may attach `beagle` metadata (cost, balance, provider,
paidBy) to the completion; the tools fall back to `balance()` when it is absent.

## Development

```sh
pnpm --filter @beagle/mcp build     # tsc → dist/
pnpm --filter @beagle/mcp typecheck
pnpm --filter @beagle/mcp test      # vitest: in-memory BeagleApi fake, SDK InMemoryTransport, fetch stub, fake JSON-RPC node
```
