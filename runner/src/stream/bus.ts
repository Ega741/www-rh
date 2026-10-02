/**
 * In-process stream bus keyed by mind (`docs/SPEC.md` §4.1 `stream/`): frames, thoughts, actions,
 * memories, status, budget and trades. The WS server subscribes per connection; the last frame of
 * each mind is kept for `hello` and `frame.jpg`.
 *
 * @module stream/bus
 */
import type { WsFrameData, WsServerMessage } from '@www-rh/shared';

/** A bus listener. */
export type BusListener = (message: WsServerMessage) => void;

/** Per-mind publish/subscribe. */
export class StreamBus {
  readonly #listeners = new Map<string, Set<BusListener>>();
  readonly #frames = new Map<string, WsFrameData>();

  /** Publishes `message` to the subscribers of `token`. */
  publish(token: string, message: WsServerMessage): void {
    const set = this.#listeners.get(token.toLowerCase());
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(message);
      } catch {
        // a broken subscriber must not affect the others
      }
    }
  }

  /** Subscribes to `token`; returns an unsubscribe function. */
  subscribe(token: string, listener: BusListener): () => void {
    const key = token.toLowerCase();
    let set = this.#listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(key);
    };
  }

  /** Number of subscribers of `token`. */
  subscribers(token: string): number {
    return this.#listeners.get(token.toLowerCase())?.size ?? 0;
  }

  /** Stores the last frame of `token` and broadcasts it. */
  publishFrame(token: string, frame: WsFrameData): void {
    this.#frames.set(token.toLowerCase(), frame);
    this.publish(token, { type: 'frame', ...frame });
  }

  /** The last frame of `token`, or `null`. */
  lastFrame(token: string): WsFrameData | null {
    return this.#frames.get(token.toLowerCase()) ?? null;
  }
}
