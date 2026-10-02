/**
 * Canonical JSON (R2, RFC 8785-style) and keccak / sha256 helpers used for every hash the runner
 * publishes: metadata (`sha256`, R1), memory anchor batches and draw receipts (`keccak256`, R2).
 *
 * The implementation lives in `@www-rh/shared` so the web app and third parties compute
 * byte-identical hashes; this module re-exports it and adds runner-side builders that turn
 * database rows into the exact objects that are hashed and served.
 *
 * @module canonical
 */
import {
  canonicalJson,
  hashDrawReceipt,
  hashMemoryBatch,
  type DrawReceipt,
  type DrawReceiptTick,
  type MemoryBatch,
  type MemoryBatchItem,
} from '@www-rh/shared';
import type { Hex } from 'viem';

export {
  bytesToBase64,
  canonicalBytes,
  canonicalJson,
  compareCodePoints,
  hashDrawReceipt,
  hashMemoryBatch,
  hashMemoryItem,
  hashMetadata,
  keccakCanonical,
  metadataDataUri,
  personaHashOf,
  sha256Canonical,
  type CanonicalValue,
} from '@www-rh/shared';

/** Builds the anchor batch object (R2) for consecutive memories of `token`. */
export function buildMemoryBatch(token: string, memories: readonly MemoryBatchItem[]): MemoryBatch {
  if (memories.length === 0) throw new RangeError('a memory batch needs at least one memory');
  const sorted = [...memories].sort((a, b) => a.seq - b.seq);
  sorted.forEach((m, i) => {
    if (i > 0 && m.seq !== (sorted[i - 1] as MemoryBatchItem).seq + 1) throw new RangeError('memory batch seqs must be consecutive');
  });
  return {
    token: token.toLowerCase(),
    fromSeq: (sorted[0] as MemoryBatchItem).seq,
    toSeq: (sorted[sorted.length - 1] as MemoryBatchItem).seq,
    memories: sorted.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, url: m.url, createdAt: m.createdAt })),
  };
}

/**
 * Builds a draw receipt (R2) for ledger lines of `token`:
 * `amountWei = floor(Σ costUsdMicro · 1e18 / ethUsdPriceMicro)` (never draws more than was spent).
 */
export function buildDrawReceipt(token: string, ticks: readonly DrawReceiptTick[], ethUsdPriceMicro: number): DrawReceipt {
  if (ticks.length === 0) throw new RangeError('a draw receipt needs at least one tick');
  if (!Number.isSafeInteger(ethUsdPriceMicro) || ethUsdPriceMicro <= 0) throw new RangeError('ethUsdPriceMicro must be a positive integer');
  const sorted = [...ticks].sort((a, b) => a.tickId - b.tickId || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const totalMicro = sorted.reduce((sum, t) => sum + BigInt(t.costUsdMicro), 0n);
  return {
    token: token.toLowerCase(),
    fromTickId: (sorted[0] as DrawReceiptTick).tickId,
    toTickId: (sorted[sorted.length - 1] as DrawReceiptTick).tickId,
    ticks: sorted.map((t) => ({
      tickId: t.tickId,
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      costUsdMicro: t.costUsdMicro,
    })),
    ethUsdPriceMicro,
    amountWei: ((totalMicro * 10n ** 18n) / BigInt(ethUsdPriceMicro)).toString(10),
  };
}

/** Convenience: canonical string + keccak of a memory batch. */
export function anchorPayload(batch: MemoryBatch): { json: string; contentHash: Hex } {
  return { json: canonicalJson(batch), contentHash: hashMemoryBatch(batch) };
}

/** Convenience: canonical string + keccak of a draw receipt. */
export function receiptPayload(receipt: DrawReceipt): { json: string; receiptHash: Hex } {
  return { json: canonicalJson(receipt), receiptHash: hashDrawReceipt(receipt) };
}
