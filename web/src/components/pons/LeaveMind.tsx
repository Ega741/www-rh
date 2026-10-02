/**
 * Creator tool "Leave" (SPEC §9.2 / §9.5, Pons mode): `registry.leave(token, newRecipient)` hands
 * the Pons creator-fee recipient from the mind account to `newRecipient` and puts the mind to
 * sleep. Two-step: open → confirm (checkbox) → send. The vault keeps its balance for compute.
 *
 * @module components/pons/LeaveMind
 */
import { useState } from 'react';
import type { Address } from 'viem';
import { useConnection, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { useTxFlow } from '../../hooks/useTxFlow';
import { leaveRecipientError, ponsMindRegistryAbi } from '../../lib/pons';
import type { MindDetail, PonsLive } from '../../lib/types';
import { ChainGuard } from '../ChainGuard';
import { AddressLink, TxStatus } from '../common';

/** See module docs. */
export function LeaveMind({ mind, live, onChanged }: { mind: MindDetail; live: PonsLive | null; onChanged: () => void }) {
  const { address } = useConnection();
  const write = useWriteContract();
  const [open, setOpen] = useState(false);
  const [recipient, setRecipient] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const tx = useTxFlow({
    onConfirmed: () => {
      setOpen(false);
      setConfirmed(false);
      onChanged();
    },
  });
  const account = mind.pons?.account ?? live?.account ?? null;
  const feeRecipient = live?.creatorFeeRecipient ?? null;
  const receiving = account !== null && feeRecipient !== null && feeRecipient.toLowerCase() === account.toLowerCase();
  const target = recipient.trim() === '' && address !== undefined ? address : recipient;
  const error = leaveRecipientError(target, account);

  if (account === null) return null;
  if (feeRecipient !== null && !receiving) {
    return (
      <div className="space-y-1 border-t border-line pt-3 text-[12px] text-dim">
        <p className="label">leave</p>
        <p>
          The mind no longer receives this coin&apos;s Pons creator fees (recipient now <AddressLink address={feeRecipient} />). Its vault keeps whatever it
          holds and still pays for compute; feeding still works.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="label">leave</p>
      {!open ? (
        <>
          <p className="text-[12px] text-dim">
            Hand this coin&apos;s Pons creator fees back from the mind account to a wallet of your choice. The mind goes to sleep; its vault stays
            locked for compute.
          </p>
          <button type="button" className="btn btn-sm w-full" onClick={() => setOpen(true)} disabled={REGISTRY_ADDRESS === null || feeRecipient === null}>
            Leave…
          </button>
        </>
      ) : (
        <div className="space-y-2 rounded border border-danger/40 bg-danger/5 p-2">
          <label className="block">
            <span className="label">new fee recipient</span>
            <input
              className={`field py-1 ${recipient !== '' && error !== null ? 'field-error' : ''}`}
              value={recipient}
              placeholder={address ?? '0x…'}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={tx.busy}
            />
          </label>
          {error !== null && recipient !== '' && <p className="text-[12px] text-danger">{error}</p>}
          <label className="flex items-start gap-2 text-[12px] text-dim">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={tx.busy} />
            <span>
              I understand: future creator fees of ${mind.symbol} go to {error === null ? <AddressLink address={target} /> : 'that address'}, the mind
              becomes dormant, and its vault balance stays locked for compute (nothing is withdrawn).
            </span>
          </label>
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm flex-1" onClick={() => setOpen(false)} disabled={tx.busy}>
              cancel
            </button>
            <div className="flex-1">
              <ChainGuard action="leave" compact>
                <button
                  type="button"
                  className="btn btn-danger btn-sm w-full"
                  disabled={!confirmed || error !== null || tx.busy}
                  onClick={() =>
                    void tx.run(() =>
                      write.mutateAsync({
                        address: REGISTRY_ADDRESS as Address,
                        abi: ponsMindRegistryAbi,
                        functionName: 'leave',
                        args: [mind.token, target.trim() as Address],
                        chainId: TARGET_CHAIN.id,
                      }),
                    )
                  }
                >
                  {tx.busy ? 'Leaving…' : 'Leave'}
                </button>
              </ChainGuard>
            </div>
          </div>
        </div>
      )}
      <TxStatus tx={tx} labels={{ confirmed: 'Left. The mind is dormant and no longer receives creator fees.' }} />
    </div>
  );
}
