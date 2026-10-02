import { describe, expect, it } from 'vitest';
import { initialStreamState, streamReducer, type StreamState } from './lib/stream';
import { WS_CLOSE_TRY_AGAIN_LATER, WS_CLOSE_UNKNOWN_TOKEN, backoffDelay, mindStreamUrl, parseWsMessage, type WsMessage } from './ws';

const TOKEN = '0x00000000000000000000000000000000000000aa';
const TX = `0x${'ab'.repeat(32)}`;

describe('parseWsMessage', () => {
  it('rejects malformed payloads and unknown types', () => {
    expect(parseWsMessage('not json')).toBeNull();
    expect(parseWsMessage('[1,2]')).toBeNull();
    expect(parseWsMessage(JSON.stringify({ type: 'nope' }))).toBeNull();
    expect(parseWsMessage(JSON.stringify({ type: 'frame' }))).toBeNull();
    expect(parseWsMessage(JSON.stringify({ type: 'thought', delta: true }))).toBeNull();
  });

  it('parses hello with a SPEC frame object and paused status', () => {
    const at = '2026-10-02T10:00:00.000Z';
    const msg = parseWsMessage(
      JSON.stringify({ type: 'hello', token: TOKEN.toUpperCase().replace('0X', '0x'), status: 'paused', phase: 'complete', frame: { jpegBase64: 'AAAA', url: 'https://a.example/', at }, at }),
    );
    expect(msg).toEqual({
      type: 'hello',
      token: TOKEN,
      status: 'paused',
      phase: 'complete',
      frame: { jpegBase64: 'AAAA', url: 'https://a.example/', at: Date.parse(at) },
      currentUrl: 'https://a.example/',
    });
    expect(parseWsMessage({ type: 'hello', token: TOKEN, status: 'alive', phase: 'bonding', frame: null, at })).toMatchObject({ frame: null, currentUrl: null });
  });

  it('accepts the legacy hello.lastFrame and both thoughtSaved spellings', () => {
    expect(parseWsMessage({ type: 'hello', token: TOKEN, status: 'alive', phase: 'bonding', lastFrame: 'BBBB', currentUrl: 'https://b.example/' }, 7)).toMatchObject({
      frame: { jpegBase64: 'BBBB', url: 'https://b.example/', at: 7 },
    });
    const thought = { id: 3, tickId: 2, kind: 'summary', text: 'Read two papers.', createdAt: '2026-10-02T10:00:00.000Z' };
    expect(parseWsMessage({ type: 'thoughtSaved', thought })).toMatchObject({ type: 'thoughtSaved', thought: { id: 3, kind: 'summary' } });
    expect(parseWsMessage({ type: 'thought_saved', thought })).toMatchObject({ type: 'thoughtSaved' });
  });

  it('parses frames with ISO timestamps', () => {
    const msg = parseWsMessage(JSON.stringify({ type: 'frame', jpegBase64: '/9j/4AAQ', url: 'https://example.org/', at: '2026-10-02T10:00:00.000Z' }));
    expect(msg).toEqual({ type: 'frame', jpegBase64: '/9j/4AAQ', url: 'https://example.org/', at: Date.parse('2026-10-02T10:00:00.000Z') });
  });

  it('parses R7 thought deltas with kind', () => {
    const msg = parseWsMessage(JSON.stringify({ type: 'thought', tickId: 7, kind: 'thinking', text: 'hm', delta: true, at: 1_700_000_000_000 }));
    expect(msg).toEqual({ type: 'thought', tickId: 7, kind: 'thinking', text: 'hm', delta: true, at: 1_700_000_000_000 });
    const final = parseWsMessage(JSON.stringify({ type: 'thought', tickId: 7, text: 'done', delta: false, at: 1 }), 5);
    expect(final).toMatchObject({ kind: 'text', delta: false, at: 1_000 });
  });

  it('parses actions, stringifying object inputs', () => {
    expect(parseWsMessage({ type: 'action', tool: 'browse_navigate', input: { url: 'https://a.b' }, at: 1_700_000_000_000 })).toEqual({
      type: 'action',
      tool: 'browse_navigate',
      input: '{"url":"https://a.b"}',
      tickId: null,
      at: 1_700_000_000_000,
    });
  });

  it('parses budget with decimal-string wei and trades with R11 names', () => {
    expect(parseWsMessage({ type: 'budget', balanceWei: '1000000000000000000', balanceUsd: 3000, burnUsdPerHour: 1.5, at: 1_700_000_000_000 })).toMatchObject({
      type: 'budget',
      balanceWei: 10n ** 18n,
      burnUsdPerHour: 1.5,
      runwayHours: null,
    });
    const trade = parseWsMessage({
      type: 'trade',
      trade: { txHash: TX, logIndex: 3, blockNumber: 10, timestamp: '2026-10-02T10:00:00Z', trader: TOKEN, isBuy: true, ethAmountWei: '5', tokenAmount: '6', feeWei: '1', priceWei: '7' },
    });
    expect(trade).toMatchObject({ type: 'trade', trade: { ethAmountWei: 5n, tokenAmount: 6n, feeWei: 1n, priceWei: 7n, isBuy: true } });
  });

  it('parses memory (kind note|finding), status, pong and error', () => {
    expect(parseWsMessage({ type: 'memory', memory: { seq: 4, kind: 'finding', content: 'x', createdAt: '2026-10-02T10:00:00Z' } })).toMatchObject({
      type: 'memory',
      memory: { seq: 4, kind: 'finding', anchorTx: null, url: null },
    });
    expect(parseWsMessage({ type: 'memory', memory: { kind: 'note' } })).toBeNull();
    expect(parseWsMessage({ type: 'status', status: 'dormant', phase: 'graduated', at: 1 })).toMatchObject({ status: 'dormant', phase: 'graduated' });
    expect(parseWsMessage({ type: 'pong' })).toEqual({ type: 'pong' });
    expect(parseWsMessage({ type: 'error', message: 'too many viewers' })).toEqual({ type: 'error', message: 'too many viewers' });
  });
});

describe('stream URL and backoff', () => {
  it('appends the token query (R10)', () => {
    expect(mindStreamUrl('ws://localhost:5173/ws', TOKEN as `0x${string}`)).toBe(`ws://localhost:5173/ws?token=${TOKEN}`);
  });

  it('grows exponentially, caps, and waits at least 10 s after 1013', () => {
    const opts = { min: 1_000, max: 30_000, random: 0.5 };
    expect(backoffDelay(0, opts)).toBe(1_000);
    expect(backoffDelay(3, opts)).toBe(8_000);
    expect(backoffDelay(10, opts)).toBe(30_000);
    expect(backoffDelay(0, { ...opts, code: WS_CLOSE_TRY_AGAIN_LATER })).toBe(10_000);
    expect(backoffDelay(5, { ...opts, code: WS_CLOSE_UNKNOWN_TOKEN })).toBe(3_000);
  });
});

describe('streamReducer', () => {
  const run = (messages: WsMessage[], from: StreamState = initialStreamState) =>
    messages.reduce((s, message, i) => streamReducer(s, { type: 'message', message, receivedAt: 1000 + i }), from);

  it('assembles thought deltas into blocks and finalises with the full text', () => {
    const s = run([
      { type: 'thought', tickId: 1, kind: 'thinking', text: 'Let me ', delta: true, at: 1 },
      { type: 'thought', tickId: 1, kind: 'thinking', text: 'look.', delta: true, at: 2 },
      { type: 'thought', tickId: 1, kind: 'text', text: 'Hello', delta: true, at: 3 },
      { type: 'thought', tickId: 1, kind: 'thinking', text: 'Let me look.', delta: false, at: 4 },
      { type: 'thought', tickId: 1, kind: 'text', text: 'Hello world', delta: false, at: 5 },
      { type: 'thought', tickId: 1, kind: 'text', text: 'Second', delta: true, at: 6 },
    ]);
    expect(s.blocks.map((b) => [b.kind, b.text, b.final])).toEqual([
      ['thinking', 'Let me look.', true],
      ['text', 'Hello world', true],
      ['text', 'Second', false],
    ]);
  });

  it('accepts a final message without preceding deltas once (no duplicates)', () => {
    const msg: WsMessage = { type: 'thought', tickId: 2, kind: 'text', text: 'Summary.', delta: false, at: 1 };
    const s = run([msg, msg]);
    expect(s.blocks).toHaveLength(1);
    expect(s.blocks[0]).toMatchObject({ text: 'Summary.', final: true });
  });

  it('tracks frames, url, status, budget, actions, memories and trades', () => {
    const s = run([
      { type: 'hello', token: null, status: 'alive', phase: 'bonding', frame: { jpegBase64: 'AAA', url: 'https://a.example/', at: 1 }, currentUrl: 'https://a.example/' },
      { type: 'thoughtSaved', thought: { id: 1, tickId: 1, kind: 'aloud', text: 'hi', createdAt: 1 } },
      { type: 'frame', jpegBase64: 'BBB', url: 'https://b.example/', at: 9 },
      { type: 'action', tool: 'browse_click', input: '3', tickId: 1, at: 10 },
      { type: 'action', tool: 'browse_read', input: '', tickId: 1, at: 11 },
      { type: 'status', status: 'dormant', phase: 'bonding', at: 12 },
      { type: 'budget', balanceWei: 5n, balanceUsd: 1, burnUsdPerHour: 0.5, runwayHours: 2, at: 13 },
      { type: 'memory', memory: { seq: 1, kind: 'note', content: 'a', url: null, createdAt: 1, contentHash: null, anchorTx: null, anchorUri: null } },
      { type: 'memory', memory: { seq: 1, kind: 'note', content: 'a', url: null, createdAt: 1, contentHash: null, anchorTx: `0x${'11'.repeat(32)}`, anchorUri: null } },
      { type: 'error', message: 'oops' },
    ]);
    expect(s.frame).toEqual({ jpegBase64: 'BBB', url: 'https://b.example/', at: 9 });
    expect(s.currentUrl).toBe('https://b.example/');
    expect(s.status).toBe('dormant');
    expect(s.budget?.balanceWei).toBe(5n);
    expect(s.actions.map((a) => a.tool)).toEqual(['browse_read', 'browse_click']);
    expect(s.memories).toHaveLength(1);
    expect(s.memories[0]?.anchorTx).not.toBeNull();
    expect(s.lastError).toBe('oops');
    expect(s.savedThoughts.map((t) => t.text)).toEqual(['hi']);
    expect(streamReducer(s, { type: 'reset' })).toBe(initialStreamState);
  });

  it('records connection state', () => {
    expect(streamReducer(initialStreamState, { type: 'connection', state: 'open' }).connection).toBe('open');
  });
});
