/**
 * Graduation grace window of one coin (SPEC §2.3 rule 3): while the curve is `Complete` it reads
 * `completedAt(token)` and `graduationGrace()`, ticks once a second for the countdown, and says
 * when sells are open again (`now >= completedAt + grace`). It also notices a Complete → Bonding
 * transition (`CurveReopened`, from chain, REST or WS-triggered refetches) for a one-line notice.
 *
 * @module hooks/useGraduationWindow
 */
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';
import { useEffect, useState } from 'react';
import { zeroAddress, type Address } from 'viem';
import { useReadContract } from 'wagmi';
import { LAUNCHPAD_ADDRESS, TARGET_CHAIN } from '../config';
import { graceWindow, initialReopenTracker, trackReopen, type GraceWindow } from '../lib/grace';
import type { CurvePhaseName } from '../lib/types';
import { useNow } from './useTick';

/** Return value of {@link useGraduationWindow}. */
export interface GraduationWindow {
  /** Window state; `unknown` unless the curve is `Complete` and both reads arrived. */
  window: GraceWindow;
  /** Current `graduationGrace()` in seconds, once read. */
  graceSeconds: number | null;
  /** Current time used for {@link window} (ms). */
  now: number;
  /** `Complete` and past the grace: the sell form and `quoteSell` are enabled (buys stay off). */
  sellsOpen: boolean;
  /** The curve went Complete → Bonding while this page watched it (non-zero `completedAt` before). */
  reopened: boolean;
}

/** See module docs. */
export function useGraduationWindow(token: Address, phase: CurvePhaseName): GraduationWindow {
  const complete = phase === 'complete';
  const enabled = complete && LAUNCHPAD_ADDRESS !== null;
  const [tracker, setTracker] = useState(initialReopenTracker);
  const base = { address: LAUNCHPAD_ADDRESS ?? zeroAddress, abi: launchpadAbi, chainId: TARGET_CHAIN.id } as const;

  // A fresh cache scope per completion: after a reopen and a new buy-out, the previous
  // completion's timestamp is never shown.
  const completedAt = useReadContract({
    ...base,
    functionName: 'completedAt',
    args: [token],
    scopeKey: `completion-${tracker.completions}`,
    query: { enabled, refetchInterval: 30_000 },
  });
  // The owner may change the grace; it applies to curves already waiting.
  const grace = useReadContract({ ...base, functionName: 'graduationGrace', query: { enabled, refetchInterval: 60_000 } });

  useEffect(() => {
    setTracker((prev) => trackReopen(prev, { token, phase, completedAt: completedAt.data }));
  }, [token, phase, completedAt.data]);

  const now = useNow(1_000, complete);
  // Trust the reads only once the tracker has caught up with this token's `Complete` phase.
  const trusted = complete && tracker.token === token && tracker.phase === 'complete';
  const win: GraceWindow = trusted ? graceWindow(completedAt.data, grace.data, now) : { state: 'unknown' };
  return {
    window: win,
    graceSeconds: grace.data ?? null,
    now,
    sellsOpen: win.state === 'expired',
    reopened: tracker.token === token && tracker.reopened && phase === 'bonding',
  };
}
