import { describe, expect, it } from 'vitest';
import {
  ALIAS_DOCS,
  HEADER_DOCS,
  INSUFFICIENT_CREDIT_BODY,
  KEY_PLACEHOLDER,
  anthropicNodeSnippet,
  anthropicPythonSnippet,
  claudeCodeMcpCommand,
  curlMessagesSnippet,
  curlSnippet,
  mcpEnvSnippet,
  mcpHttpConfig,
  mcpStdioConfig,
  nodeOpenAiSnippet,
  openAiBaseUrl,
  pythonOpenAiSnippet,
  verifyReceiptSnippet,
} from './docs.js';

const BASE = 'https://beagle.example';

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
  it('reference tables are complete', () => {
    expect(HEADER_DOCS.map((h) => h.name)).toEqual(expect.arrayContaining(['x-beagle-difficulty', 'x-beagle-fallback', 'x-beagle-request-id', 'x-beagle-model', 'x-beagle-cost-micro', 'x-beagle-balance-micro', 'x-beagle-route']));
    expect(ALIAS_DOCS.map((a) => a.id)).toEqual(['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house']);
  });
});
