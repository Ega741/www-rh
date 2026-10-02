/**
 * Mind memory (`docs/SPEC.md` §4.1 `memory/`): `remember`, `recall`, `recent`; contiguous per-mind
 * `seq` from 1; `content_hash = memoryContentHash(item)`. Whenever a mind has
 * `ANCHOR_EVERY_N_MEMORIES` unanchored memories, the next contiguous batch is hashed
 * (`anchorBatchHash`), an `anchors` row is inserted (`pending`, or `dry_run`) and
 * `anchorMemory(token, toSeq, contentHash, uri)` is queued.
 *
 * @module memory/memory
 */
import type { Address } from 'viem';
import { anchorBatchHash, anchorBatchUri, memoryContentHash, type AnchorBatch, type AnchorMemoryItem, type Memory } from '@www-rh/shared';
import type { TxQueue } from '../chain/txQueue.js';
import type { MemoryRow, MemoryWithAnchor, Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { StreamBus } from '../stream/bus.js';

/** The hashed item of a memory row. */
export function memoryItem(row: Pick<MemoryRow, 'seq' | 'kind' | 'content' | 'url' | 'created_at'>): AnchorMemoryItem {
  return { seq: row.seq, kind: row.kind, content: row.content, url: row.url, createdAt: new Date(row.created_at).toISOString() };
}

/** Memory DTO (§5). */
export function memoryDto(row: MemoryRow | MemoryWithAnchor): Memory {
  return {
    seq: row.seq,
    kind: row.kind,
    content: row.content,
    url: row.url,
    createdAt: new Date(row.created_at).toISOString(),
    contentHash: row.content_hash as `0x${string}`,
    anchorTx: ('anchor_tx' in row ? row.anchor_tx : null) as `0x${string}` | null,
  };
}

/** Builds the §3.2 anchor batch for `rows` (contiguous seqs). */
export function buildAnchorBatch(token: string, rows: readonly MemoryRow[]): AnchorBatch {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  sorted.forEach((r, i) => {
    if (i > 0 && r.seq !== (sorted[i - 1] as MemoryRow).seq + 1) throw new RangeError('anchor batch seqs must be contiguous');
  });
  return {
    token: token.toLowerCase() as `0x${string}`,
    fromSeq: (sorted[0] as MemoryRow).seq,
    toSeq: (sorted[sorted.length - 1] as MemoryRow).seq,
    memories: sorted.map(memoryItem),
  };
}

/** Memory store + anchoring. */
export class MemoryService {
  readonly #anchoring = new Set<string>();
  readonly #jobs = new Set<Promise<void>>();
  #stopped = false;

  constructor(
    private readonly repos: Repos,
    private readonly bus: StreamBus,
    private readonly queue: TxQueue,
    private readonly opts: { anchorEvery: number },
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores a memory, broadcasts it and triggers anchoring when a batch is full. */
  remember(token: string, kind: 'note' | 'finding', content: string, url: string | null, tickId: number | null): Memory {
    const key = token.toLowerCase();
    const row = this.repos.tx(() => {
      const seq = this.repos.memories.lastSeq(key) + 1;
      const createdAt = this.now();
      const contentHash = memoryContentHash(memoryItem({ seq, kind, content, url, created_at: createdAt }));
      return this.repos.memories.insert({ token: key, seq, kind, content, url, created_at: createdAt, content_hash: contentHash, tick_id: tickId });
    });
    const dto = memoryDto(row);
    this.bus.publish(key, { type: 'memory', memory: dto });
    this.#background(key);
    return dto;
  }

  /** Starts {@link maybeAnchor} in the background (tracked so {@link stop} can wait for it). */
  #background(token: string): void {
    if (this.#stopped) return;
    const job = this.maybeAnchor(token)
      .catch((err: unknown) => this.log.warn('anchoring failed', { token, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => this.#jobs.delete(job));
    this.#jobs.add(job);
  }

  /** Stops starting anchor batches and waits for the running ones (shutdown, before the DB closes). */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#jobs]);
  }

  /**
   * Live mode after a dry-run period: memories of `dry_run` anchors are released (the rows stay as
   * history) and anchored on-chain. Returns the affected tokens.
   */
  releaseDryRunForLive(): string[] {
    const tokens = this.repos.tx(() => this.repos.memories.releaseDryRunAnchors());
    if (tokens.length > 0) this.log.warn('live mode: memories of dry-run anchors will be anchored on-chain', { minds: tokens.length });
    for (const t of tokens) this.#background(t);
    return tokens;
  }

  /** FTS / LIKE recall. */
  recall(token: string, query: string, limit: number): Memory[] {
    return this.repos.memories.search(token.toLowerCase(), query, limit).map(memoryDto);
  }

  /** The last `n` memories, newest first. */
  recent(token: string, n: number): Memory[] {
    return this.repos.memories.recent(token.toLowerCase(), n).map(memoryDto);
  }

  /** Anchors every full batch of unanchored memories of `token`. */
  async maybeAnchor(token: string): Promise<void> {
    const key = token.toLowerCase();
    if (this.#anchoring.has(key)) return;
    this.#anchoring.add(key);
    try {
      for (;;) {
        if (this.#stopped) return;
        const rows = this.repos.memories.unanchored(key, this.opts.anchorEvery);
        if (rows.length < this.opts.anchorEvery) return;
        const batch = buildAnchorBatch(key, rows);
        const contentHash = anchorBatchHash(batch);
        const uri = anchorBatchUri(key, batch.fromSeq, batch.toSeq);
        const at = this.now();
        const status = this.queue.dryRun ? 'dry_run' : 'pending';
        const id = this.repos.tx(() =>
          this.repos.memories.insertAnchor({ token: key, from_seq: batch.fromSeq, to_seq: batch.toSeq, content_hash: contentHash, uri, status, tx_hash: null, error: null, created_at: at, updated_at: at }),
        );
        if (status === 'dry_run') {
          this.log.info('anchor recorded (dry run)', { token: key, uri, contentHash });
          continue;
        }
        const outcome = await this.queue.enqueue({ functionName: 'anchorMemory', args: [key as Address, BigInt(batch.toSeq), contentHash, uri] }, `anchor ${uri}`);
        if (outcome.kind === 'confirmed') this.repos.memories.updateAnchor(id, 'confirmed', outcome.hash, null, this.now());
        else if (outcome.kind === 'dry_run') this.repos.memories.updateAnchor(id, 'dry_run', null, null, this.now());
        else if (outcome.kind === 'unknown' || (outcome.kind === 'failed' && outcome.hash !== null)) {
          // may still be mined: stays pending (confirmed by the indexed MemoryAnchored log, or reconciled at startup)
          this.repos.memories.updateAnchor(id, 'pending', outcome.hash, outcome.error, this.now());
          return;
        } else {
          this.repos.tx(() => {
            this.repos.memories.updateAnchor(id, 'failed', outcome.kind === 'reverted' ? outcome.hash : null, outcome.kind === 'reverted' ? 'transaction reverted' : outcome.error, this.now());
            this.repos.memories.releaseAnchor(id);
          });
          return; // retry on the next memory
        }
      }
    } finally {
      this.#anchoring.delete(key);
    }
  }

  /**
   * Startup reconciliation, before any new anchor is sent: `pending` anchors with an indexed
   * `MemoryAnchored(token, toSeq)` log become `confirmed`; the others are released and re-sent.
   */
  reconcile(): void {
    for (const a of this.repos.memories.anchorsWithStatus('pending')) {
      const log = this.repos.facts.anchorLog(a.token, a.to_seq);
      if (log !== undefined && log.content_hash === a.content_hash) {
        this.repos.memories.updateAnchor(a.id, 'confirmed', log.tx_hash, null, this.now());
      } else {
        this.repos.tx(() => {
          this.repos.memories.updateAnchor(a.id, 'failed', null, 'not anchored before restart', this.now());
          this.repos.memories.releaseAnchor(a.id);
        });
      }
    }
  }
}
