/**
 * Settlement (SPEC §5.7): `upstreamCost = costMicroUsd(usage, price)`; `charged = markup(cost)` for
 * credit-paid requests and only the fee `ceilDiv(cost · BYOK_FEE_BPS, 10_000)` for BYOK (0 by
 * default, so BYOK consumes no credit, SPEC §0); one ledger debit (`ref_type='usage'`,
 * `ref_id=requestId`), reservation released, `usage` row written — always, also for failed requests.
 *
 * @module metering/settle
 */
import { applyMarkupBps, BPS_DENOMINATOR, ceilDiv, costMicroUsd } from '@beagle/shared/credit';
import type { ModelSpec, Provider, Tier } from '@beagle/shared/models';
import type { Repos, UsageRow } from '../db/repos.js';
import type { Usage } from '../translate/internal.js';

/** Who paid. */
export type PaidBy = 'credit' | 'byok';

/** Everything a settlement needs to know about the request. */
export interface SettleInput {
  requestId: string;
  workspace: string;
  apiKeyId: string | null;
  endpoint: string;
  requestedModel: string;
  /** Served model (undefined when no candidate was ever called). */
  model: ModelSpec | undefined;
  paidBy: PaidBy | undefined;
  tier: Tier | undefined;
  usage: Usage;
  status: 'ok' | 'error';
  httpStatus: number;
  errorCode: string | null;
  latencyMs: number;
  routeReasons: string[];
  stream: boolean;
  difficulty: number | null;
  reservationId: string | undefined;
  createdAt: number;
}

/** Result of {@link SettlementService.settle}. */
export interface Settlement {
  upstreamCostMicro: bigint;
  chargedMicro: bigint;
  /** Ledger balance after the debit. */
  balanceMicro: bigint;
  row: UsageRow;
}

/** Computes charges and writes the ledger / usage rows. */
export class SettlementService {
  constructor(
    private readonly repos: Repos,
    private readonly fees: { markupBps: number; byokFeeBps: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The marked-up charge for `usage` on `model`. */
  charge(usage: Usage, model: ModelSpec, paidBy: PaidBy): { upstreamCostMicro: bigint; chargedMicro: bigint; markupBps: number } {
    const upstreamCostMicro = costMicroUsd(usage, model.price);
    if (paidBy === 'credit') return { upstreamCostMicro, chargedMicro: applyMarkupBps(upstreamCostMicro, this.fees.markupBps), markupBps: this.fees.markupBps };
    const fee = this.fees.byokFeeBps === 0 || upstreamCostMicro === 0n ? 0n : ceilDiv(upstreamCostMicro * BigInt(this.fees.byokFeeBps), BPS_DENOMINATOR);
    return { upstreamCostMicro, chargedMicro: fee, markupBps: this.fees.byokFeeBps };
  }

  /** Settles one request in a single transaction. */
  settle(input: SettleInput): Settlement {
    const provider: Provider | null = input.model?.provider ?? null;
    const charge =
      input.model === undefined || input.paidBy === undefined
        ? { upstreamCostMicro: 0n, chargedMicro: 0n, markupBps: 0 }
        : this.charge(input.usage, input.model, input.paidBy);
    const now = this.now();
    return this.repos.transaction(() => {
      if (input.reservationId !== undefined) this.repos.reservations.delete(input.reservationId);
      if (charge.chargedMicro > 0n) {
        this.repos.workspaces.ensure(input.workspace, now);
        this.repos.ledger.insert({
          workspace: input.workspace,
          kind: 'debit',
          amountMicro: -charge.chargedMicro,
          refType: 'usage',
          refId: input.requestId,
          memo: input.model?.id ?? null,
          createdAt: now,
        });
      }
      const row: UsageRow = {
        id: input.requestId,
        workspace: input.workspace.toLowerCase(),
        apiKeyId: input.apiKeyId,
        endpoint: input.endpoint,
        requestedModel: input.requestedModel,
        servedModel: input.model?.id ?? null,
        provider,
        tier: input.tier ?? input.model?.tier ?? null,
        paidBy: input.paidBy ?? null,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cacheReadTokens: input.usage.cacheReadTokens,
        cacheWriteTokens: input.usage.cacheWriteTokens,
        upstreamCostMicro: charge.upstreamCostMicro,
        chargedMicro: charge.chargedMicro,
        status: input.status,
        httpStatus: input.httpStatus,
        errorCode: input.errorCode,
        latencyMs: input.latencyMs,
        routeReasons: input.routeReasons,
        stream: input.stream,
        difficulty: input.difficulty,
        drawId: null,
        priceJson: input.model === undefined ? null : JSON.stringify(input.model.price),
        markupBps: charge.markupBps,
        createdAt: input.createdAt,
      };
      this.repos.usage.insert(row);
      const balanceMicro = this.repos.ledger.balance(input.workspace);
      return { upstreamCostMicro: charge.upstreamCostMicro, chargedMicro: charge.chargedMicro, balanceMicro, row };
    });
  }
}
