/**
 * Compute settlement (SPEC §4.1 economics, R2): unsettled ledger lines are bundled into a draw
 * receipt whose canonical-JSON keccak is passed to `drawCompute(token, amountWei, receiptHash)`.
 * Never draws more than was spent (`amountWei` is floored), more than the vault holds, or more
 * than the remaining epoch cap (the largest whole-tick prefix that fits is settled).
 *
 * @module economics/settle
 */
import type { Address, Hex } from 'viem';
import type { DrawReceiptTick } from '@www-rh/shared';
import { buildDrawReceipt, receiptPayload } from '../canonical.js';
import { revertName, type LaunchpadReader, type LaunchpadWriter } from '../chain/launchpad.js';
import type { LedgerRow, Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { nowIso } from '../util.js';
import { usdToMicro } from './cost.js';
import type { EthUsdSource } from './ethUsd.js';

/** Outcome of {@link Settler.settle}. */
export type SettleResult =
  | { kind: 'skipped'; reason: 'nothing' | 'below-threshold' | 'cap' | 'busy' | 'zero-amount' }
  | { kind: 'settled'; receiptHash: Hex; amountWei: bigint; status: 'dry_run' | 'confirmed' | 'failed' | 'submitted'; txHash: Hex | null; error: string | null };

/** Settlement knobs. */
export interface SettlePolicy {
  drawThresholdUsd: number;
}

/** Callback fired after a receipt changes state (for the stream bus). */
export type ReceiptListener = (token: string) => void;

const MAX_LINES = 1_000;

/** Ledger lines grouped by tick, in tick order. */
function groupByTick(lines: readonly LedgerRow[]): LedgerRow[][] {
  const groups: LedgerRow[][] = [];
  for (const line of lines) {
    const last = groups[groups.length - 1];
    if (last !== undefined && (last[0] as LedgerRow).tick_id === line.tick_id) last.push(line);
    else groups.push([line]);
  }
  return groups;
}

function toReceiptTick(l: LedgerRow): DrawReceiptTick {
  return {
    tickId: l.tick_id,
    model: l.model,
    inputTokens: l.input_tokens,
    outputTokens: l.output_tokens,
    cacheReadTokens: l.cache_read_tokens,
    cacheWriteTokens: l.cache_write_tokens,
    costUsdMicro: l.cost_usd_micro,
  };
}

/**
 * Chooses the largest prefix of whole ticks whose draw amount fits `maxAmountWei`.
 * Exported for tests.
 */
export function selectSettlement(lines: readonly LedgerRow[], ethUsdPriceMicro: number, maxAmountWei: bigint | null): LedgerRow[] {
  const chosen: LedgerRow[] = [];
  let micro = 0n;
  for (const group of groupByTick(lines)) {
    const groupMicro = group.reduce((s, l) => s + BigInt(l.cost_usd_micro), 0n);
    const amount = ((micro + groupMicro) * 10n ** 18n) / BigInt(ethUsdPriceMicro);
    if (maxAmountWei !== null && amount > maxAmountWei) break;
    chosen.push(...group);
    micro += groupMicro;
  }
  return chosen;
}

/** Settles compute spend on-chain. */
export class Settler {
  readonly #busy = new Set<string>();

  constructor(
    private readonly repos: Repos,
    private readonly writer: LaunchpadWriter,
    private readonly reader: LaunchpadReader | null,
    private readonly ethUsd: EthUsdSource,
    private readonly policy: SettlePolicy,
    private readonly log: Logger,
    private readonly onReceipt: ReceiptListener = () => undefined,
  ) {}

  /** Remaining drawable amount (vault balance and epoch cap), or `null` when unknown (dry run / no RPC). */
  async #maxDrawable(token: Address): Promise<bigint | null> {
    if (this.writer.dryRun || this.reader === null) {
      const row = this.repos.minds.get(token);
      return row === undefined ? null : BigInt(row.mind_balance);
    }
    const [balance, limit, used, now] = await Promise.all([
      this.reader.mindBalance(token),
      this.reader.drawLimit(),
      this.reader.drawnInEpoch(token),
      this.reader.latestTimestamp(),
    ]);
    const epochOver = now >= used.epochStart + BigInt(limit.epochSeconds);
    const capLeft = epochOver ? limit.maxPerEpoch : limit.maxPerEpoch > used.drawn ? limit.maxPerEpoch - used.drawn : 0n;
    return balance < capLeft ? balance : capLeft;
  }

  /**
   * Settles `token`'s unreceipted spend when it reaches `DRAW_THRESHOLD_USD` (or always with
   * `force`, e.g. when the mind goes dormant).
   */
  async settle(token: string, opts: { force?: boolean } = {}): Promise<SettleResult> {
    const t = token.toLowerCase();
    if (this.#busy.has(t)) return { kind: 'skipped', reason: 'busy' };
    this.#busy.add(t);
    try {
      return await this.#settle(t, opts.force === true);
    } finally {
      this.#busy.delete(t);
    }
  }

  async #settle(token: string, force: boolean): Promise<SettleResult> {
    const lines = this.repos.compute.unreceipted(token, MAX_LINES);
    if (lines.length === 0) return { kind: 'skipped', reason: 'nothing' };
    const totalMicro = lines.reduce((s, l) => s + l.cost_usd_micro, 0);
    if (!force && totalMicro < usdToMicro(this.policy.drawThresholdUsd)) return { kind: 'skipped', reason: 'below-threshold' };

    const ethUsdPriceMicro = await this.ethUsd.priceMicro();
    const maxAmount = await this.#maxDrawable(token as Address);
    const chosen = selectSettlement(lines, ethUsdPriceMicro, maxAmount);
    if (chosen.length === 0) return { kind: 'skipped', reason: 'cap' };
    const receipt = buildDrawReceipt(token, chosen.map(toReceiptTick), ethUsdPriceMicro);
    const amountWei = BigInt(receipt.amountWei);
    if (amountWei === 0n) return { kind: 'skipped', reason: 'zero-amount' };
    const { json, receiptHash } = receiptPayload(receipt);
    const at = nowIso();
    const receiptId = this.repos.tx(() =>
      this.repos.compute.insertReceipt(
        {
          token,
          receipt_hash: receiptHash.toLowerCase(),
          receipt_json: json,
          amount_wei: receipt.amountWei,
          cost_usd_micro: chosen.reduce((s, l) => s + l.cost_usd_micro, 0),
          status: 'pending',
          tx_hash: null,
          error: null,
          created_at: at,
          updated_at: at,
        },
        chosen.map((l) => l.id),
      ),
    );

    let result: SettleResult;
    try {
      const outcome = await this.writer.drawCompute(token as Address, amountWei, receiptHash);
      if (outcome.kind === 'dry_run') {
        this.repos.compute.updateReceipt(receiptId, 'dry_run', null, null, nowIso());
        result = { kind: 'settled', receiptHash, amountWei, status: 'dry_run', txHash: null, error: null };
        this.log.info('draw receipt recorded (dry run, no transaction)', { token, receiptHash, amountWei });
      } else {
        this.repos.compute.updateReceipt(receiptId, 'submitted', outcome.hash, null, nowIso());
        this.onReceipt(token);
        const status = await this.writer.waitForReceipt(outcome.hash);
        if (status === 'success') {
          this.repos.compute.updateReceipt(receiptId, 'confirmed', outcome.hash, null, nowIso());
          result = { kind: 'settled', receiptHash, amountWei, status: 'confirmed', txHash: outcome.hash, error: null };
          this.log.info('compute drawn', { token, receiptHash, amountWei, tx: outcome.hash });
        } else {
          this.repos.tx(() => {
            this.repos.compute.updateReceipt(receiptId, 'failed', outcome.hash, 'transaction reverted', nowIso());
            this.repos.compute.releaseReceipt(receiptId);
          });
          result = { kind: 'settled', receiptHash, amountWei, status: 'failed', txHash: outcome.hash, error: 'transaction reverted' };
        }
      }
    } catch (err) {
      const error = revertName(err) ?? errorMessage(err);
      this.repos.tx(() => {
        this.repos.compute.updateReceipt(receiptId, 'failed', null, error, nowIso());
        this.repos.compute.releaseReceipt(receiptId);
      });
      this.log.warn('drawCompute failed; lines released for a later draw', { token, error });
      result = { kind: 'settled', receiptHash, amountWei, status: 'failed', txHash: null, error };
    }
    this.onReceipt(token);
    return result;
  }

  /**
   * Startup / periodic reconciliation: resolves `submitted` receipts by their transaction receipt
   * and fails + releases `pending` receipts older than `staleMs` that never reached the chain.
   */
  async reconcile(staleMs = 10 * 60_000, now = Date.now()): Promise<void> {
    for (const r of this.repos.compute.receiptsWithStatus('submitted')) {
      if (r.tx_hash === null) continue;
      try {
        const status = await this.writer.waitForReceipt(r.tx_hash as Hex);
        if (status === 'success') this.repos.compute.updateReceipt(r.id, 'confirmed', r.tx_hash, null, nowIso());
        else
          this.repos.tx(() => {
            this.repos.compute.updateReceipt(r.id, 'failed', r.tx_hash, 'transaction reverted', nowIso());
            this.repos.compute.releaseReceipt(r.id);
          });
      } catch (err) {
        this.log.debug('receipt reconciliation pending', { receipt: r.receipt_hash, error: errorMessage(err) });
      }
    }
    for (const r of this.repos.compute.receiptsWithStatus('pending')) {
      if (now - Date.parse(r.created_at) < staleMs) continue;
      this.repos.tx(() => {
        this.repos.compute.updateReceipt(r.id, 'failed', null, 'never submitted (runner restarted)', nowIso());
        this.repos.compute.releaseReceipt(r.id);
      });
    }
  }
}
