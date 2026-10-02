/**
 * "Feed the mind": sends ETH to the coin's mind vault via `fundMind(token)` on the launchpad
 * (curve mode) or the registry (Pons mode; same MindCore selector). Vault ETH can only ever be
 * spent on the mind's compute (D4/D5).
 *
 * @module components/FeedMind
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Address } from 'viem';
import { useWriteContract } from 'wagmi';
import { CORE_ADDRESS, TARGET_CHAIN } from '../config';
import { formatEth, formatRunway, formatUsd, parseAmount, weiToEth } from '../format';
import { useTxFlow } from '../hooks/useTxFlow';
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';
import { queryKeys } from '../queries';
import { ChainGuard } from './ChainGuard';
import { TxStatus } from './common';

const PRESETS = ['0.001', '0.01', '0.05', '0.1'] as const;

/** Props of {@link FeedMind}. */
export interface FeedMindProps {
  token: Address;
  symbol: string;
  /** ETH/USD for the "≈ $" hint, when known. */
  ethUsd?: number | null;
  /** Current burn rate for the "≈ runway added" hint. */
  burnUsdPerHour?: number | null;
  compact?: boolean;
  onFunded?: () => void;
}

/** Amount input + presets + fundMind transaction. */
export function FeedMind({ token, symbol, ethUsd = null, burnUsdPerHour = null, compact = false, onFunded }: FeedMindProps) {
  const [amount, setAmount] = useState(compact ? '0.001' : '0.01');
  const queryClient = useQueryClient();
  const write = useWriteContract();
  const tx = useTxFlow({
    onConfirmed: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.compute(token) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.mind(token) });
      onFunded?.();
    },
  });
  const wei = parseAmount(amount);
  const valid = wei !== null && wei > 0n;
  const usd = valid && ethUsd !== null ? weiToEth(wei) * ethUsd : null;
  const hours = usd !== null && burnUsdPerHour !== null && burnUsdPerHour > 0 ? usd / burnUsdPerHour : null;

  function submit() {
    if (!valid || CORE_ADDRESS === null) return;
    void tx.run(() =>
      write.mutateAsync({
        address: CORE_ADDRESS as Address,
        abi: launchpadAbi,
        functionName: 'fundMind',
        args: [token],
        value: wei,
        chainId: TARGET_CHAIN.id,
      }),
    );
  }

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button key={p} type="button" className={`chip hover:text-fg ${amount === p ? 'border-acid/60 text-acid' : ''}`} onClick={() => setAmount(p)}>
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Amount in ETH</span>
          <input
            className={`field pr-11 ${!valid && amount !== '' ? 'field-error' : ''} ${compact ? 'py-1' : ''}`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.01"
          />
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[11px] text-mute">ETH</span>
        </label>
        <ChainGuard action="feed" inline>
          <button type="button" className={`btn btn-primary shrink-0 ${compact ? 'btn-sm' : ''}`} disabled={!valid || tx.busy} onClick={submit}>
            {tx.busy ? 'Feeding…' : 'Feed'}
          </button>
        </ChainGuard>
      </div>
      {!compact && (
        <p className="text-[11px] text-dim">
          {valid ? `Sends ${formatEth(wei)}` : 'Enter an amount'}
          {usd !== null && ` (≈ ${formatUsd(usd)})`} to ${symbol}'s vault
          {hours !== null && `, about ${formatRunway(hours)} of thinking at the current burn`}. Vault ETH can only pay for this mind's compute.
        </p>
      )}
      <TxStatus tx={tx} labels={{ confirmed: 'Fed. The mind thanks you.' }} />
    </div>
  );
}
