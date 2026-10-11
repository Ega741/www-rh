/**
 * Usage receipts (SPEC §5.7): `UsageReceipt` built from a `usage` row plus `hash = receiptHash(receipt)`.
 * The price snapshot stored with the row makes the hash stable across catalog updates.
 *
 * @module metering/receipts
 */
import { ModelPriceSchema, type ModelPrice } from '@beagle/shared/models';
import { receiptHash } from '@beagle/shared/canonical';
import type { UsageReceiptWire } from '@beagle/shared/api';
import type { UsageRow } from '../db/repos.js';

/** Builds the wire receipt for a settled row, or `undefined` when no model served it. */
export function buildReceipt(row: UsageRow): { receipt: UsageReceiptWire; hash: `0x${string}` } | undefined {
  if (row.servedModel === null || row.provider === null || row.paidBy === null) return undefined;
  let price: ModelPrice | undefined;
  if (row.priceJson !== null) {
    try {
      const parsed = ModelPriceSchema.safeParse(JSON.parse(row.priceJson));
      if (parsed.success) {
        price = {
          inputPerM: parsed.data.inputPerM,
          outputPerM: parsed.data.outputPerM,
          ...(parsed.data.cacheReadPerM === undefined ? {} : { cacheReadPerM: parsed.data.cacheReadPerM }),
          ...(parsed.data.cacheWritePerM === undefined ? {} : { cacheWritePerM: parsed.data.cacheWritePerM }),
        };
      }
    } catch {
      price = undefined;
    }
  }
  if (price === undefined) return undefined;
  const receipt: UsageReceiptWire = {
    v: 1,
    requestId: row.id,
    workspace: row.workspace,
    createdAt: row.createdAt,
    endpoint: row.endpoint,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    provider: row.provider,
    paidBy: row.paidBy,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    },
    price,
    upstreamCostMicro: row.upstreamCostMicro.toString(),
    markupBps: row.markupBps,
    chargedMicro: row.chargedMicro.toString(),
    routeReasons: row.routeReasons,
  };
  return { receipt, hash: receiptHash(receipt) };
}
