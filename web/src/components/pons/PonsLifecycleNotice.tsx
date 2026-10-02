/**
 * Mind-page notice for Pons minds whose account no longer receives the coin's creator fees
 * (SPEC §9.7): the creator left (`hasLeft`), or the recipient was moved away from the account.
 * Explains that the vault still pays for compute and links the takeover path (the adopt tab).
 *
 * @module components/pons/PonsLifecycleNotice
 */
import { Link } from 'react-router';
import { ponsLifecycle } from '../../lib/pons';
import type { MindDetail, PonsLive } from '../../lib/types';
import { AddressLink } from '../common';

/** See module docs. */
export function PonsLifecycleNotice({ mind, live }: { mind: MindDetail; live: PonsLive | null }) {
  if (mind.pons === null) return null;
  const recipient = live?.creatorFeeRecipient ?? null;
  const state = ponsLifecycle(mind.pons, live?.left ?? null, recipient);
  if (state !== 'left' && state !== 'recipient-moved') return null;
  return (
    <div className="space-y-1 rounded border border-amber/40 bg-amber/5 px-3 py-2 text-[12px] text-amber">
      <p>
        <span className="chip mr-2 border-amber/50 text-amber">{state === 'left' ? 'left' : 'not receiving fees'}</span>
        {state === 'left' ? 'The creator left this mind. ' : 'This mind’s account no longer receives the coin’s creator fees. '}
        Its Pons creator fees are redirected
        {recipient !== null ? (
          <>
            {' '}
            to <AddressLink address={recipient} />
          </>
        ) : (
          ' elsewhere'
        )}
        . The vault keeps its balance and still pays for compute (feeding still works), but the mind stays dormant.
      </p>
      <p className="text-dim">
        Anyone can take it over: prepare an adoption, have the current fee recipient hand the fees to your mind account, then activate. Your model,
        persona and account replace the current ones; the vault stays with the mind.{' '}
        <Link to={`/create?tab=adopt&token=${mind.token}`} className="whitespace-nowrap">
          take over this mind →
        </Link>
      </p>
    </div>
  );
}
