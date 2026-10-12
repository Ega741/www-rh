import { describe, expect, it } from 'vitest';
import { quoteUsdMicro } from '@beagle/shared/credit';
import {
  BUDGET_DOC,
  CREDIT_DOC,
  INSUFFICIENT_CREDIT_BODY,
  KEY_PLACEHOLDER,
  MCP_BIN_PATH,
  REPO_PLACEHOLDER,
  claudeCodeMcpCommand,
  curlMessagesSnippet,
  curlSnippet,
  mcpBinPath,
  mcpEnvSnippet,
  mcpHttpConfig,
  mcpStdioConfig,
  nodeOpenAiSnippet,
  openAiBaseUrl,
  priceHistorySnippet,
  pythonOpenAiSnippet,
  splTokenBudgetSnippet,
  splTokenBurnSnippet,
  verifyReceiptSnippet,
} from './docs.js';

const BASE = 'https://beagle.example';
const CTX = { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8899', mint: 'HBJrfAHGsn7WQYk4FaBXv3wA7fVRL4ctSriSdj3UiDND', operator: 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ', decimals: 6, symbol: 'BEAGLE' };

describe('docs snippets', () => {
  it('fill the base URL and the key placeholder', () => {
    expect(curlSnippet(BASE)).toContain(`${BASE}/v1/chat/completions`);
    expect(curlSnippet(BASE)).toContain(KEY_PLACEHOLDER);
    expect(curlMessagesSnippet(BASE)).toContain('anthropic-version');
    expect(pythonOpenAiSnippet(BASE)).toContain(`base_url="${openAiBaseUrl(BASE)}"`);
    expect(nodeOpenAiSnippet(BASE)).toContain(`baseURL: "${BASE}/v1"`);
    expect(verifyReceiptSnippet(BASE, 'req_1')).toContain(`${BASE}/api/receipts/req_1`);
    expect(verifyReceiptSnippet(BASE, 'req_1')).toContain('const { receipt, hash } = await res.json()');
    expect(verifyReceiptSnippet(BASE, 'req_1')).toContain('receiptHash(receipt) === hash');
  });
  it('MCP configs point at the local build with the Solana agent key', () => {
    const cfg = JSON.parse(mcpStdioConfig(BASE)) as { mcpServers: { beagle: { command: string; args: string[]; env: Record<string, string> } } };
    expect(cfg.mcpServers.beagle.command).toBe('node');
    expect(cfg.mcpServers.beagle.args).toEqual([`${REPO_PLACEHOLDER}/${MCP_BIN_PATH}`]);
    expect(cfg.mcpServers.beagle.env).toEqual({ BEAGLE_API_URL: BASE, BEAGLE_API_KEY: KEY_PLACEHOLDER });
    expect(mcpBinPath('/srv/beagle')).toBe('/srv/beagle/packages/mcp/dist/bin.js');
    expect(claudeCodeMcpCommand(BASE)).toContain(`-- node ${REPO_PLACEHOLDER}/${MCP_BIN_PATH}`);
    const http = JSON.parse(mcpHttpConfig(BASE)) as { mcpServers: { beagle: { url: string } } };
    expect(http.mcpServers.beagle.url).toBe(`${BASE}/mcp`);
    const env = mcpEnvSnippet(BASE, CTX.rpcUrl);
    expect(env).toContain('BEAGLE_AGENT_SECRET_KEY');
    expect(env).toContain(`BEAGLE_RPC_URL=${CTX.rpcUrl}`);
    expect(env).not.toMatch(/PRIVATE_KEY|0x\.\.\./);
    expect(env).toContain(`node ${MCP_BIN_PATH}`);
  });
  it('chain snippets name the deployment, with placeholders when unknown', () => {
    expect(splTokenBurnSnippet(CTX)).toContain(`--token ${CTX.mint}`);
    expect(splTokenBurnSnippet(CTX)).toContain('beagle:v1 ws=<workspace>');
    expect(splTokenBurnSnippet({ ...CTX, mint: undefined })).toContain('--token <mint>');
    expect(splTokenBudgetSnippet(CTX)).toContain(`approve <token-account> 500 ${CTX.operator}`);
    expect(splTokenBudgetSnippet(CTX)).toContain('/api/budgets/register');
    expect(splTokenBudgetSnippet({ ...CTX, operator: undefined })).toContain('500 <operator>');
    expect(splTokenBudgetSnippet(CTX)).toContain('revoke <token-account>');
    expect(priceHistorySnippet(BASE)).toContain(`${BASE}/api/price/history?limit=100`);
  });
  it('the credit doc matches the shared quote math', () => {
    expect(quoteUsdMicro(1_000_000_000n, 10n ** 16n, 6)).toBe(10_000_000n);
    expect(CREDIT_DOC.example).toContain('10_000_000 µUSD');
    expect(CREDIT_DOC.formula).toContain('10^(decimals + 12)');
    expect(CREDIT_DOC.memo).toBe('beagle:v1 ws=<workspace public key>');
    expect(BUDGET_DOC.open).toContain('ApproveChecked');
    expect(BUDGET_DOC.close).toContain('Revoke');
  });
  it('402 body is the gateway shape', () => {
    const body = JSON.parse(INSUFFICIENT_CREDIT_BODY) as { error: { code: string; type: string } };
    expect(body.error.code).toBe('insufficient_credit');
    expect(body.error.type).toBe('insufficient_credit');
  });
});
