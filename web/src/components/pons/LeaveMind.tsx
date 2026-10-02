/**
 * Creator tool "Leave" (SPEC §9.7, Pons mode): `registry.leave(token, newRecipient)` first harvests
 * the fees earned so far into the vault (same sweeps + claim as `harvest`), then hands the Pons
 * creator-fee recipient from the mind account to `newRecipient`, marks the mind as left and puts it
 * to sleep. The recipient must not be zero, the registry or any mind account (`InvalidRecipient`;
 * checked here with `registry.tokenOf`). Two-step: open → confirm (checkbox) → send. Once left,
 * the mind stays dormant until someone takes it over through an adoption.
 *
 * @module components/pons/LeaveMind
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { zeroAddress, type Address } from 'viem';
import { useConnection, useReadContract, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { useDebounced } from '../../hooks/useDebounced';
import { useTxFlow } from '../../hooks/useTxFlow';
import { checkLeaveRecipient, parseRecipient, ponsMindRegistryAbi } from '../../lib/pons';
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
  const left = live?.left ?? mind.pons?.left ?? false;
  const receiving = account !== null && feeRecipient !== null && feeRecipient.toLowerCase() === account.toLowerCase();
  const target = recipient.trim() === '' && address !== undefined ? address : recipient;
  const settled = useDebounced(target, 250);
  const candidate = parseRecipient(settled);
  const typing = candidate !== parseRecipient(target);
  const tokenOf = useReadContract({
    address: REGISTRY_ADDRESS ?? zeroAddress,
    abi: ponsMindRegistryAbi,
    functionName: 'tokenOf',
    args: [candidate ?? zeroAddress],
    chainId: TARGET_CHAIN.id,
    query: { enabled: open && candidate !== null && REGISTRY_ADDRESS !== null, staleTime: 60_000, retry: false },
  });
  const check = checkLeaveRecipient(target, {
    account,
    registry: REGISTRY_ADDRESS,
    recipientTokenOf: typing || candidate === null ? undefined : tokenOf.isError ? null : tokenOf.data,
  });
  const takeoverLink = (
    <Link to={`/create?tab=adopt&token=${mind.token}`} className="whitespace-nowrap">
      take it over
    </Link>
  );

  if (account === null) return null;
  if (left || (feeRecipient !== null && !receiving)) {
    return (
      <div className="space-y-1 border-t border-line pt-3 text-[12px] text-dim">
        <p className="label">leave</p>
        <p>
          {left ? 'You left this mind: ' : 'The mind no longer receives this coin’s Pons creator fees: '}
          {feeRecipient !== null ? (
            <>
              they go to <AddressLink address={feeRecipient} />.
            </>
          ) : (
            'they go elsewhere.'
          )}{' '}
          Its vault keeps whatever it holds and still pays for compute; feeding still works. The mind stays dormant (resuming does not wake it) until someone,
          you included, {takeoverLink}: prepare an adoption, hand the fees to that account, activate.
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
            Hand this coin&apos;s Pons creator fees from the mind account to a wallet of your choice. Fees earned so far are harvested into the vault
            first, so they keep paying for compute. The mind then goes dormant until someone takes it over.
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
              className={`field py-1 ${target.trim() !== '' && check.status === 'invalid' ? 'field-error' : ''}`}
              value={recipient}
              placeholder={address ?? '0x…'}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={tx.busy}
              spellCheck={false}
            />
          </label>
          {check.status === 'invalid' && target.trim() !== '' && <p className="text-[12px] text-danger">{check.message}</p>}
          {check.status === 'checking' && <p className="text-[12px] text-mute">Checking that the address is not a mind account…</p>}
          {check.status === 'ok' && check.warning !== null && <p className="text-[12px] text-amber">{check.warning}</p>}
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-dim">
            <li>Creator fees earned so far are swept and claimed into the mind&apos;s vault first (as a harvest); nothing is withdrawn.</li>
            <li>From then on the coin&apos;s Pons creator fees go to the new recipient, not to the mind.</li>
            <li>The mind becomes dormant and stays dormant: resuming does not wake it. It comes back only through an adoption (takeover), by anyone.</li>
            <li>The recipient cannot be the zero address, the registry or any mind account.</li>
          </ul>
          <label className="flex items-start gap-2 text-[12px] text-dim">
            <input type="checkbox" className="mt-0.5" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={tx.busy} />
            <span>
              I understand: future creator fees of ${mind.symbol} go to {check.status === 'ok' ? <AddressLink address={check.recipient} /> : 'that address'}, the
              mind becomes dormant, and its vault (including the fees harvested now) stays locked for compute.
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
                  disabled={!confirmed || check.status !== 'ok' || tx.busy}
                  onClick={() => {
                    if (check.status !== 'ok') return;
                    void tx.run(() =>
                      write.mutateAsync({
                        address: REGISTRY_ADDRESS as Address,
                        abi: ponsMindRegistryAbi,
                        functionName: 'leave',
                        args: [mind.token, check.recipient],
                        chainId: TARGET_CHAIN.id,
                      }),
                    );
                  }}
                >
                  {tx.busy ? 'Harvesting and leaving…' : 'Leave'}
                </button>
              </ChainGuard>
            </div>
          </div>
        </div>
      )}
      <TxStatus tx={tx} labels={{ confirmed: 'Left. Earned fees went to the vault; the mind is dormant and no longer receives creator fees.' }} />
    </div>
  );
}
