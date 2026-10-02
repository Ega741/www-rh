/**
 * Pure reducer that turns the WebSocket message stream into UI state: the latest frame, the
 * current URL, live thought blocks assembled from deltas (R7), the action log, and live
 * memories / trades / status / budget.
 *
 * @module lib/stream
 */
import type { SocketState, WsMessage } from '../ws';
import type { CurvePhaseName, Memory, MindStatusName, Trade } from './types';

/** One assembled thought block (a `text` or `thinking` content block of a tick). */
export interface ThoughtBlock {
  id: number;
  tickId: number;
  kind: 'text' | 'thinking';
  text: string;
  /** `true` once the final `delta:false` message arrived. */
  final: boolean;
  at: number;
}

/** One tool call from the action log. */
export interface ActionEntry {
  id: number;
  tool: string;
  input: string;
  tickId: number | null;
  at: number;
}

/** Live stream state for one mind. */
export interface StreamState {
  connection: SocketState | 'idle';
  frame: { jpegBase64: string; url: string | null; at: number } | null;
  currentUrl: string | null;
  status: MindStatusName | null;
  phase: CurvePhaseName | null;
  budget: { balanceWei: bigint; balanceUsd: number; burnUsdPerHour: number; runwayHours: number | null; at: number } | null;
  /** Oldest first. */
  blocks: ThoughtBlock[];
  /** Newest first. */
  actions: ActionEntry[];
  /** Newest first. */
  memories: Memory[];
  /** Newest first. */
  trades: Trade[];
  lastError: string | null;
  lastMessageAt: number | null;
  nextId: number;
}

/** Events accepted by {@link streamReducer}. */
export type StreamEvent =
  | { type: 'connection'; state: SocketState }
  | { type: 'message'; message: WsMessage; receivedAt: number }
  | { type: 'reset' };

/** Caps for the in-memory lists. */
export const STREAM_LIMITS = { blocks: 40, actions: 80, memories: 50, trades: 50 } as const;

/** Initial (empty) stream state. */
export const initialStreamState: StreamState = {
  connection: 'idle',
  frame: null,
  currentUrl: null,
  status: null,
  phase: null,
  budget: null,
  blocks: [],
  actions: [],
  memories: [],
  trades: [],
  lastError: null,
  lastMessageAt: null,
  nextId: 1,
};

function applyThought(state: StreamState, msg: Extract<WsMessage, { type: 'thought' }>): StreamState {
  const blocks = state.blocks.slice();
  let openIndex = -1;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const b = blocks[i];
    if (b !== undefined && b.tickId === msg.tickId && b.kind === msg.kind && !b.final) {
      openIndex = i;
      break;
    }
  }
  let nextId = state.nextId;
  if (msg.delta) {
    const open = blocks[openIndex];
    if (open !== undefined) {
      blocks[openIndex] = { ...open, text: open.text + msg.text, at: msg.at };
    } else {
      blocks.push({ id: nextId, tickId: msg.tickId, kind: msg.kind, text: msg.text, final: false, at: msg.at });
      nextId += 1;
    }
  } else {
    const open = blocks[openIndex];
    if (open !== undefined) {
      blocks[openIndex] = { ...open, text: msg.text, final: true, at: msg.at };
    } else {
      const last = blocks[blocks.length - 1];
      const duplicate = last !== undefined && last.final && last.tickId === msg.tickId && last.kind === msg.kind && last.text === msg.text;
      if (!duplicate) {
        blocks.push({ id: nextId, tickId: msg.tickId, kind: msg.kind, text: msg.text, final: true, at: msg.at });
        nextId += 1;
      }
    }
  }
  return { ...state, blocks: blocks.slice(-STREAM_LIMITS.blocks), nextId };
}

/** Reduces one stream event into the next state. Pure. */
export function streamReducer(state: StreamState, event: StreamEvent): StreamState {
  if (event.type === 'reset') return initialStreamState;
  if (event.type === 'connection') return { ...state, connection: event.state };
  const msg = event.message;
  const base = { ...state, lastMessageAt: event.receivedAt };
  switch (msg.type) {
    case 'hello':
      return {
        ...base,
        status: msg.status,
        phase: msg.phase,
        currentUrl: msg.currentUrl ?? base.currentUrl,
        frame: msg.lastFrame !== null && base.frame === null ? { jpegBase64: msg.lastFrame, url: msg.currentUrl, at: event.receivedAt } : base.frame,
        lastError: null,
      };
    case 'frame':
      return { ...base, frame: { jpegBase64: msg.jpegBase64, url: msg.url, at: msg.at }, currentUrl: msg.url ?? base.currentUrl };
    case 'thought':
      return applyThought(base, msg);
    case 'action':
      return {
        ...base,
        actions: [{ id: base.nextId, tool: msg.tool, input: msg.input, tickId: msg.tickId, at: msg.at }, ...base.actions].slice(0, STREAM_LIMITS.actions),
        nextId: base.nextId + 1,
      };
    case 'memory':
      return {
        ...base,
        memories: [msg.memory, ...base.memories.filter((m) => m.seq !== msg.memory.seq)].slice(0, STREAM_LIMITS.memories),
      };
    case 'status':
      return { ...base, status: msg.status, phase: msg.phase };
    case 'budget':
      return {
        ...base,
        budget: { balanceWei: msg.balanceWei, balanceUsd: msg.balanceUsd, burnUsdPerHour: msg.burnUsdPerHour, runwayHours: msg.runwayHours, at: msg.at },
      };
    case 'trade': {
      const key = `${msg.trade.txHash}:${msg.trade.logIndex}`;
      return {
        ...base,
        trades: [msg.trade, ...base.trades.filter((t) => `${t.txHash}:${t.logIndex}` !== key)].slice(0, STREAM_LIMITS.trades),
      };
    }
    case 'pong':
      return base;
    case 'error':
      return { ...base, lastError: msg.message };
    default:
      return base;
  }
}
