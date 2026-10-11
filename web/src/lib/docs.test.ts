import { describe, expect, it } from 'vitest';
import type { UsageReceiptWire } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import {
  ALIAS_DOCS,
  HEADER_DOCS,
  INSUFFICIENT_CREDIT_BODY,
  KEY_PLACEHOLDER,
  MCP_BIN_PATH,
  MCP_BUILD_COMMAND,
  REPO_PLACEHOLDER,
  anthropicNodeSnippet,
  anthropicPythonSnippet,
  claudeCodeMcpCommand,
  curlMessagesSnippet,
  curlSnippet,
  mcpBinPath,
  mcpEnvSnippet,
  mcpHttpConfig,
  mcpStdioConfig,
  nodeOpenAiSnippet,
  openAiBaseUrl,
  pythonOpenAiSnippet,
  verifyReceiptSnippet,
} from './docs.js';

const BASE = 'https://beagle.example';

/** A receipt shaped like `gateway/src/metering/receipts.ts` builds it (wire form, bigints as strings). */
const RECEIPT: UsageReceiptWire = {
  v: 1,
  requestId: 'req_0b1a4c6e-9c0e-4a1d-8f61-2d1b3c4d5e6f',
  workspace: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  createdAt: 1_760_000_000_000,
  endpoint: '/v1/chat/completions',
  requestedModel: 'beagle/auto',
  servedModel: 'house/gpt-oss-20b',
  provider: 'house',
  paidBy: 'credit',
  usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 },
  price: { inputPerM: 100_000, outputPerM: 400_000 },
  upstreamCostMicro: '28',
  markupBps: 2000,
  chargedMicro: '34',
  routeReasons: ['alias:auto', 'tier:house'],
};
const HASH = receiptHash(RECEIPT);

/**
 * Runs the "verify locally" snippet as the user would: the import line is dropped (the module is
 * injected), `fetch` returns `body`, and the line the snippet prints is returned.
 */
async function runVerifySnippet(body: unknown): Promise<string> {
  const code = verifyReceiptSnippet(BASE, RECEIPT.requestId)
    .split('\n')
    .filter((line) => !line.startsWith('import ') && !line.startsWith('//'))
    .join('\n');
  const AsyncFunction = Object.getPrototypeOf(async function () {
    /* marker */
  }).constructor as new (...args: string[]) => (...fnArgs: unknown[]) => Promise<void>;
  const printed: string[] = [];
  const fetchStub = async (url: string, init: { headers: Record<string, string> }) => {
    expect(url).toBe(`${BASE}/api/receipts/${RECEIPT.requestId}`);
    expect(init.headers.Authorization).toBe(`Bearer ${KEY_PLACEHOLDER}`);
    return { json: async () => JSON.parse(JSON.stringify(body)) as unknown };
  };
  await new AsyncFunction('receiptHash', 'fetch', 'console', code)(receiptHash, fetchStub, { log: (s: string) => printed.push(s) });
  expect(printed).toHaveLength(1);
  return printed[0] as string;
}

describe('docs snippets', () => {
  it('point at the gateway', () => {
    expect(openAiBaseUrl(BASE)).toBe(`${BASE}/v1`);
    expect(curlSnippet(BASE)).toContain(`${BASE}/v1/chat/completions`);
    expect(curlSnippet(BASE)).toContain('beagle/auto');
    expect(curlMessagesSnippet(BASE)).toContain(`${BASE}/v1/messages`);
    expect(pythonOpenAiSnippet(BASE)).toContain(`base_url="${BASE}/v1"`);
    expect(nodeOpenAiSnippet(BASE)).toContain(`baseURL: "${BASE}/v1"`);
    expect(anthropicNodeSnippet(BASE)).toContain(`baseURL: "${BASE}"`);
    expect(anthropicPythonSnippet(BASE)).toContain(`base_url="${BASE}"`);
    expect(mcpEnvSnippet(BASE)).toContain(`BEAGLE_API_URL=${BASE}`);
    expect(claudeCodeMcpCommand(BASE)).toContain('claude mcp add beagle');
    expect(verifyReceiptSnippet(BASE, 'req_1')).toContain(`${BASE}/api/receipts/req_1`);
  });
  it('MCP configs are valid JSON with the env vars', () => {
    const stdio = JSON.parse(mcpStdioConfig(BASE)) as { mcpServers: { beagle: { env: Record<string, string> } } };
    expect(stdio.mcpServers.beagle.env).toEqual({ BEAGLE_API_URL: BASE, BEAGLE_API_KEY: KEY_PLACEHOLDER });
    const http = JSON.parse(mcpHttpConfig(BASE)) as { mcpServers: { beagle: { url: string } } };
    expect(http.mcpServers.beagle.url).toBe(`${BASE}/mcp`);
    const body = JSON.parse(INSUFFICIENT_CREDIT_BODY) as { error: { code: string } };
    expect(body.error.code).toBe('insufficient_credit');
  });
  it('MCP snippets launch the local binary (the package is not published to npm)', () => {
    expect(MCP_BIN_PATH).toBe('packages/mcp/dist/bin.js');
    expect(mcpBinPath()).toBe(`${REPO_PLACEHOLDER}/packages/mcp/dist/bin.js`);
    expect(mcpBinPath('/srv/beagle')).toBe('/srv/beagle/packages/mcp/dist/bin.js');
    const stdio = JSON.parse(mcpStdioConfig(BASE)) as { mcpServers: { beagle: { command: string; args: string[] } } };
    expect(stdio.mcpServers.beagle.command).toBe('node');
    expect(stdio.mcpServers.beagle.args).toEqual([mcpBinPath()]);
    expect(claudeCodeMcpCommand(BASE)).toMatch(/-- node \S*packages\/mcp\/dist\/bin\.js$/);
    const shell = mcpEnvSnippet(BASE);
    expect(shell).toContain(MCP_BUILD_COMMAND);
    expect(shell.trimEnd().split('\n').at(-1)).toBe('node packages/mcp/dist/bin.js');
    for (const snippet of [mcpStdioConfig(BASE), claudeCodeMcpCommand(BASE), shell]) {
      // no `npx -y @beagle/mcp` and no bare `beagle-mcp`: neither resolves without a published package
      expect(snippet).not.toMatch(/npx|\bbeagle-mcp\b/);
    }
  });
  it('reference tables are complete', () => {
    expect(HEADER_DOCS.map((h) => h.name)).toEqual(expect.arrayContaining(['x-beagle-difficulty', 'x-beagle-fallback', 'x-beagle-request-id', 'x-beagle-model', 'x-beagle-cost-micro', 'x-beagle-balance-micro', 'x-beagle-route', 'x-beagle-credits-url']));
    const creditsUrl = HEADER_DOCS.find((h) => h.name === 'x-beagle-credits-url');
    expect(creditsUrl?.direction).toBe('response');
    expect(creditsUrl?.text).toMatch(/402/);
    expect(ALIAS_DOCS.map((a) => a.id)).toEqual(['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house']);
  });
});

describe('verify-locally snippet', () => {
  it('imports receiptHash from the checkout, not from an npm package', () => {
    const snippet = verifyReceiptSnippet(BASE, RECEIPT.requestId);
    expect(snippet).toContain(`from "${REPO_PLACEHOLDER}/packages/shared/dist/canonical.js"`);
    expect(snippet).toContain('const { receipt, hash } = await res.json();');
    expect(snippet).toContain('receiptHash(receipt) === hash');
  });
  it('verifies the SPEC §5.9 shape { receipt, hash }', async () => {
    expect(await runVerifySnippet({ receipt: RECEIPT, hash: HASH })).toBe('receipt verified');
  });
  it('verifies the gateway wire body { receipt, hash, ...receipt } (dashboard.ts spreads the receipt too)', async () => {
    expect(await runVerifySnippet({ receipt: RECEIPT, hash: HASH, ...RECEIPT })).toBe('receipt verified');
  });
  it('reports a tampered receipt', async () => {
    const forged = { ...RECEIPT, chargedMicro: '1' };
    expect(await runVerifySnippet({ receipt: forged, hash: HASH, ...forged })).toBe('MISMATCH');
  });
});
