# @beagle/mcp

MCP server that gives agents access to [Beagle](../../README.md): one API key for every model, paid for
by burning BEAGLE (an SPL token on Solana). Ships as a stdio binary (`beagle-mcp`) and as a library the
gateway mounts at `/mcp` (Streamable HTTP). Spec: `docs/SPEC.md` §6.

## Quick start (Claude Desktop / Claude Code)

The package is **not published to npm** (it is a workspace package built to `dist/`), so run the local build.
Build it once from the repository root, then point your MCP client at `dist/bin.js` with an **absolute** path
(MCP clients spawn the server from their own working directory, so a relative path breaks):

```sh
pnpm install
pnpm --filter @beagle/shared build && pnpm --filter @beagle/mcp build   # → <repo>/packages/mcp/dist/bin.js
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
`Authorization: Bearer bgl_…` (no local process; the on-chain tools then return unsigned transactions).

## Environment

| Variable | Meaning |
|---|---|
| `BEAGLE_API_KEY` | **required** — `bgl_…` API key (Keys page or `beagle-gateway create-key`). Missing → exit code 2. |
| `BEAGLE_API_URL` | gateway origin; default `http://localhost:8787` |
| `BEAGLE_AGENT_SECRET_KEY` | optional Solana keypair of the agent wallet: **base58** (the 64-byte secret key a wallet exports) or the **JSON byte array** a `solana-keygen` file holds (`BEAGLE_AGENT_SECRET_KEY="$(cat agent.json)"`). A 32-byte base58 value is refused (exit code 2): it is indistinguishable from a public key, and a pasted address must not silently become an unrelated, unfunded wallet (a 32-byte seed is accepted as a JSON array). With it `beagle_buy_compute` / `beagle_open_budget` / `beagle_close_budget` sign and send (`BurnChecked` + memo / `ApproveChecked` / `Revoke`), wait for confirmation and poll the receipts until the credit lands (see *Timing*). Without it they return unsigned transactions. |
| `BEAGLE_RPC_URL` | optional JSON-RPC URL; default: the cluster RPC the gateway advertises in `GET /api/config`. Before the first transaction the executor checks the node against the gateway's cluster (genesis hash on mainnet / devnet, mint account everywhere): a wrong URL fails with `chain_mismatch`, nothing sent. A gateway without chain access (it advertises the all-zero key as its mint) fails the wallet tools with `chain_unavailable` instead; the other tools keep working. |
| `BEAGLE_WORKSPACE` | optional default workspace (base58 public key) for the on-chain tools, and the default signer of an unsigned `beagle_close_budget`. Without it the tools fall back to the **agent wallet address**, which is only a guess at your API key's workspace: results then carry `workspaceSource: "agent_wallet"` and a warning. Set it (or pass `workspace`) when the key's workspace is not the agent wallet. |

Cluster, mint, token program, operator and RPC come from the gateway (`GET /api/config`). The stdio binary
connects its transport **before** talking to the gateway: the agent wallet's address comes from the keypair
immediately, and the deployment is fetched on the first wallet-tool call and retried on each call until that
succeeds. A gateway that is down or slow when the client spawns the binary therefore neither delays the MCP
handshake nor downgrades the session; the affected call returns `isError` with code `wallet_unavailable`
(nothing was sent) and the next call tries again. All logging goes to stderr; stdout is the MCP channel. The
secret key never appears in logs or error messages.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `beagle_balance` | — | balance / reserved / headroom / available (µUSD strings), plan, the published price point with `stale`, `summary` (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`, `(stale)` appended) |
| `beagle_models` | `{ tier? }` | catalog with prices (µUSD per 1M + human), availability, Pro gating, aliases |
| `beagle_quote` | `{ usd? \| tokens? }` | tokens ↔ µUSD at the current price point (`pricePointId`, `stale`) |
| `beagle_complete` | `{ prompt? \| messages?, system?, model? (beagle/auto), max_tokens?, difficulty? }` | `{ text, model, provider, paidBy, costMicro, balanceMicro, finishReason, requestId, usage }` — **costs credit** |
| `beagle_usage` | `{ limit?, window? (24h\|7d\|30d) }` | rows + summary |
| `beagle_buy_compute` | `{ usd? \| tokens?, workspace?, payer?, tokenAccount? }` | with a wallet: `{ executed, signature, slot, tokenAccount, memo, explorerUrl, credited, creditedMicro, pricePointId, priceStale, receipt?, balanceMicro, warnings, elapsedMs, … }`; else `{ unsigned: true, cluster, transactions: [{ base64, description }], feePayer, blockhash, lastValidBlockHeight, tokenAccount, memo, … }` — **burns tokens** (final) |
| `beagle_open_budget` | `{ usd? \| tokens?, workspace?, fundOtherWorkspace?, payer?, tokenAccount? }` | with a wallet: `{ executed, signature, tokenAccount, cap, registered, budget, registerErrorCode, fundsWorkspace, … }`; else unsigned `ApproveChecked` + the `register` body for `POST /api/budgets/register`. `fundOtherWorkspace: true` is required when `workspace` is not the signing wallet (see *Budgets*) |
| `beagle_close_budget` | `{ tokenAccount?, payer? }` | with a wallet: `{ executed, signature, tokenAccount, delegate, delegatedAmount }`; else unsigned `Revoke` signed by `payer`, else `BEAGLE_WORKSPACE`, else the owner of `tokenAccount` (read from the chain). Default account: the signer's account delegated to the operator (its open budget) |
| `beagle_budgets` | — | `BudgetDto[]` keyed by token account, with formatted cap / balance / headroom, `active` / `countsAsHeadroom` per row and the total headroom (open, not stalled — the same predicate as `/api/balance`) |
| `beagle_upgrade` | `{ kind: 'pro' \| 'warm', quantity? }` | `UpgradeDto` — **costs credit**; prices are in `beagle_status.upgradePrices` |
| `beagle_status` | — | cluster, mint, indexer, price point (+ `priceAge`), provider health, house model, operator, `upgradePrices` |

Amounts: `usd` and `tokens` accept numbers or decimal strings; numbers are read at their shortest decimal
form, so `tokens: 0.1` is exactly `0.1 BEAGLE` (`100000` raw with 6 decimals), never `0.100000000000000006`.

Every result is JSON text plus `structuredContent` (bigints as decimal strings). Failures are `isError`
results with `{ error: { code, message, status?, signature?, logs? } }`, `code` being the gateway error code
(`insufficient_credit`, `invalid_api_key`, `rate_limited`, `not_delegated`, `not_owner`, …), `invalid_request` /
`internal_error`, or a wallet code (`wallet_unavailable`, `chain_mismatch`, `chain_unavailable`, `rpc_error`,
`insufficient_tokens`, `insufficient_sol`, `blockhash_expired`, `tx_failed`, `not_configured`, `invalid_address`,
`invalid_amount`, `ambiguous_token_account`).

Resources: `beagle://models` (markdown table), `beagle://quickstart`.

### Buying compute: a plain SPL burn, priced when observed

There is no custom program. `beagle_buy_compute` is one transaction: `BurnChecked(tokenAccount, mint, owner,
amount, decimals)` from your token account of the mint (the associated token account, or the largest account
when the ATA is short or empty) plus `Memo("beagle:v1 ws=<workspace>")` when the workspace to credit is not the signer.
The gateway finds the burn through the mint's signatures and credits its USD value at the **published price
point in force when it observes the burn** — not the quote the tool showed. The result therefore reports the
quote's `pricePointId`, whether the price is `stale` (older than the gateway allows: the tool still proceeds
but puts the warning in `warnings`), and, once indexed, the receipt with the point actually used. Burns that
would quote below the gateway's `minCreditMicro` are refused (they would earn nothing). A burn is final.

### Budgets = SPL delegation

`beagle_open_budget` is `ApproveChecked(tokenAccount, mint, delegate = operator, owner, cap, decimals)`: the
gateway's operator may burn up to `cap` from the account as usage accrues (each draw carries a receipt hash in
its memo), never more, and the headroom `min(cap, token balance)` counts as credit right away. There is no
deadline: a budget lives until `beagle_close_budget` (`Revoke`) or until it is exhausted. SPL keeps **one
delegate per token account**, so a new approval **replaces** the previous cap rather than adding to it (the
result says which delegation it replaced). With a wallet the tool registers the account
(`POST /api/budgets/register { tokenAccount, workspace? }`) after the approval; without a wallet the result
includes the `register` body to post after sending.

**Who a budget funds** (SPEC §3.4, §5.9): a delegation funds the workspace of the token account **owner** (the
wallet that signed the approval). Only a key or session of the owner's workspace may register it for another
workspace; any other principal naming a `workspace` gets `403 not_owner`, and the gateway's budget scanner
registers unregistered delegations under the owner's workspace regardless. So a delegation signed by wallet A can
fund a different workspace W only when it is registered **by a key of A** naming `workspace: W`. The tool refuses
to approve (nothing sent) while the funded workspace differs from the signing wallet unless the call sets
`fundOtherWorkspace: true`, because with the usual configuration (an API key of W and `BEAGLE_WORKSPACE` /
`workspace` = W) the approval would land on chain and then be registered for A, giving W no headroom. The
working options are: open the budget from W's own wallet, or run the server with an API key of A and pass
`workspace: W` (unsigned path: post the `register` body with a key of A). When registration still fails with
`not_owner` after an executed approval, the result says so (`registerErrorCode: "not_owner"`,
`fundsWorkspace` = the owner) and that the delegation funds the owner's workspace until a key of the owner
registers it or `beagle_close_budget` revokes it; the tool never claims the scanner will fix it. A registration
failure for a same-workspace budget is harmless: the scanner registers it for the owner, which is the funded
workspace.

`beagle_close_budget` revokes the named `tokenAccount` (the budget id from `beagle_budgets`), else the signer's
account delegated to the operator (its open budget; `ambiguous_token_account` when there are several), else its
ATA-or-largest account, in which case the result says the Revoke changed nothing. Without a wallet the Revoke is
built for `payer`, else `BEAGLE_WORKSPACE`, else the owner of `tokenAccount` read from the chain: with only an
API key configured, `{ tokenAccount }` is enough.

### Unsigned transactions

Without `BEAGLE_AGENT_SECRET_KEY` (and always on the gateway's `/mcp`), the on-chain tools return
`{ unsigned: true, cluster, transactions: [{ base64, description }], feePayer, blockhash, lastValidBlockHeight }`:
legacy `Transaction`s with `feePayer = workspace` (or `payer`), a fresh blockhash from the RPC and no
signatures (`requireAllSignatures: false`). Deserialize with `Transaction.from(Buffer.from(base64, 'base64'))`,
sign with the fee payer and `sendRawTransaction` before `lastValidBlockHeight` passes; otherwise call the tool
again for a fresh blockhash. Pass `payer` when the signing wallet is not the workspace to credit (the memo then
names the workspace) and `tokenAccount` to burn from / delegate / revoke a specific account. SPL accepts only the
token account owner as the authority of a burn, approval or revoke, so a `tokenAccount` the signer does not own
is refused (`invalid_request` naming the owner) instead of producing a transaction that cannot land.

### Timing and timeouts

MCP clients drop a tool call after their request timeout (the SDK default is 60 s; Claude Desktop uses the
same). A purchase is confirmation + indexer lag, so `beagle_buy_compute` keeps its total time under a budget
(`callBudgetMs`, default 45 s, measured from the call start): once the burn is confirmed it polls
`/api/receipts` and `/api/balance` only until that budget or `creditWaitMs` (60 s, SPEC §6.1) runs out,
whichever is first, and returns `executed: true, credited: false` with the `signature` rather than letting the
client time out. While waiting it sends `notifications/progress` for clients that reset their timeout on
progress. `creditedMicro` comes from the indexed receipt (exact) or, when the receipt is not among the latest
rows yet but the key's workspace balance moved, from the balance delta (approximate); the balance poll compares
against the lowest balance seen, so a completion settling concurrently does not hide the credit. Both reads are
of the API key's own workspace: a burn credited to another workspace (memo `ws=` ≠ the key's workspace) is not
visible to the poll at all, and the result says the credit is not visible on this key's workspace.

If a call still times out on the client side, **the burn may have gone through**: check `beagle_balance`,
`beagle_usage` or the explorer link before retrying — never retry a purchase blindly. The same holds for
`beagle_complete`: a request the client gave up on may still have been served and charged; `beagle_usage`
lists it. A `blockhash_expired` error means the transaction was sent but not confirmed in time: it may still
land, so check the explorer before resending.

## Library

```ts
import { createBeagleMcpServer, createRestBeagleApi, createKeypairWalletExecutor } from '@beagle/mcp';

const api = createRestBeagleApi({ baseUrl: 'http://localhost:8787', apiKey: 'bgl_…' });
const config = await api.config();
const server = createBeagleMcpServer(api, {
  wallet: createKeypairWalletExecutor({
    secretKey: process.env.BEAGLE_AGENT_SECRET_KEY!, // base58, JSON byte array, Uint8Array or Keypair
    deployment: { cluster: config.cluster, mint: config.mint, decimals: config.decimals, tokenProgram: config.tokenProgram, operator: config.operator, memoProgram: config.memoProgram },
    rpcUrl: config.rpcUrl,
  }), // optional
  workspace: '…base58…', // optional default for the on-chain tools
  rpcUrl: config.rpcUrl, // optional: RPC of the unsigned path (default: the gateway's config.rpcUrl)
  callBudgetMs: 45_000, // optional: total time budget of beagle_buy_compute
});
await server.connect(transport);
```

`BeagleApi` (SPEC §6.2, plus `price()`, `priceHistory()`, `receipts()` and `registerBudget()`) is the only
dependency of the tools; the gateway passes an in-process implementation bound to the key's workspace.
`complete(req, options?)` may attach `beagle` metadata (cost, balance, provider, paidBy) to the completion; the
tools fall back to `balance()` when it is absent. `WalletExecutor` has `buyCompute({ workspace, tokens })`,
`openBudget({ cap })` (reporting the delegation it replaced) and `closeBudget({ tokenAccount? })` (reporting the
delegation it cleared; default: the account delegated to the operator); `createLazyWalletExecutor` wraps a wallet
whose construction needs the network (what the binary does; a `WalletError` thrown by the build passes through
with its own code) and `createAgentWallet(api, config)` is the binary's own wiring.
`buildUnsignedTransactions(input, blockhash)` / `prepareUnsignedTransactions(rpc, input)` build the same three
transactions for external signers; `resolveTokenAccount(rpc, …)` implements the ATA-or-largest rule (a funded
account beats an empty ATA) and `resolveDelegatedTokenAccount(rpc, …)` the delegated-account default of
`closeBudget`; both report the account `owner`.
The memo instruction targets the Memo program the gateway indexes, `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`
(Solana's Memo v2 program, `spl-memo` crate 3.x; `MEMO_PROGRAM_ID` from `@beagle/shared/addresses`). It is built by
hand on purpose: `@solana/spl-memo` 0.3.x exports `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH` as its
`MEMO_PROGRAM_ID`, which `solana-test-validator` does not ship and the indexer does not parse as `spl-memo`.

## Development

```sh
pnpm --filter @beagle/mcp build     # tsc → dist/
pnpm --filter @beagle/mcp typecheck
pnpm --filter @beagle/mcp test      # vitest: in-memory BeagleApi fake, SDK InMemoryTransport, fetch stub, scripted Connection fake
```
