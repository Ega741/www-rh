#!/usr/bin/env node
// Deterministic OpenAI-compatible chat completions server for tests and the Solana e2e flow (scripts/solana-e2e.sh).
// Env: MOCK_PORT (9999), MOCK_FAIL_RATE (0..1 → random 500s), MOCK_STATUS (force an HTTP status),
//      MOCK_DELAY_MS (0), MOCK_MODELS (comma list; default openai/gpt-oss-20b,openai/gpt-oss-120b).
import { createServer } from 'node:http';

const port = Number(process.env.MOCK_PORT ?? 9999);
const failRate = Number(process.env.MOCK_FAIL_RATE ?? 0);
const forceStatus = process.env.MOCK_STATUS ? Number(process.env.MOCK_STATUS) : 0;
const delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
const models = (process.env.MOCK_MODELS ?? 'openai/gpt-oss-20b,openai/gpt-oss-120b').split(',');

const approxTokens = (s) => Math.max(1, Math.ceil(s.length / 4));
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join(' ') : '');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })) }));
    return;
  }
  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error', code: 'not_found' } }));
    return;
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid json', type: 'invalid_request_error', code: null } }));
    return;
  }
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const status = forceStatus || (failRate > 0 && Math.random() < failRate ? 500 : 0);
  if (status) {
    res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '1' } : {}) });
    res.end(JSON.stringify({ error: { message: `mock forced ${status}`, type: status === 429 ? 'rate_limit_error' : 'server_error', code: null } }));
    return;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  const promptText = messages.map((m) => textOf(m?.content)).join('\n') + JSON.stringify(body.tools ?? '');
  const reply = ('echo: ' + textOf(lastUser?.content ?? '')).slice(0, 200) || 'echo:';
  const usage = { prompt_tokens: approxTokens(promptText), completion_tokens: approxTokens(reply), total_tokens: 0 };
  usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  const id = 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10);
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : models[0];

  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
    send(chunk({ role: 'assistant', content: '' }));
    const words = reply.split(' ');
    const parts = [words.slice(0, 1).join(' '), ' ' + words.slice(1, 3).join(' '), ' ' + words.slice(3).join(' ')].filter((p) => p.trim().length > 0 || p.length > 0);
    for (const p of parts) send(chunk({ content: p }));
    send(chunk({}, 'stop'));
    if (body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
    usage,
  }));
});

server.listen(port, '127.0.0.1', () => console.log(`mock-provider listening on http://127.0.0.1:${port}/v1 (models: ${models.join(', ')})`));
