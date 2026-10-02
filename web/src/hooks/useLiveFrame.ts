/**
 * Live thumbnail: loads `GET /api/minds/:token/frame.jpg` and, while `refresh` is set, re-fetches
 * it every 5 s (SPEC §7). Each new frame is preloaded off-screen and swapped in only after it
 * decoded; a 404 hides the image.
 *
 * @module hooks/useLiveFrame
 */
import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { frameUrl } from '../api';
import { useTick } from './useTick';

/** Frame refresh period for thumbnails. */
export const THUMBNAIL_REFRESH_MS = 5_000;

/** Options of {@link useLiveFrame}. */
export interface LiveFrameOptions {
  /** Load at all (e.g. the card is in view). */
  enabled: boolean;
  /** Keep refreshing every 5 s (e.g. the mind is alive); otherwise load once. */
  refresh: boolean;
}

/** Latest successfully loaded frame URL, or `null` while none exists / after a 404. */
export function useLiveFrame(token: Address, { enabled, refresh }: LiveFrameOptions): { src: string | null; loadedAt: number | null } {
  const tick = useTick(THUMBNAIL_REFRESH_MS);
  const [state, setState] = useState<{ src: string | null; loadedAt: number | null }>({ src: null, loadedAt: null });
  const cycle = refresh ? tick : 0;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const candidate = frameUrl(token, Date.now());
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!cancelled) setState({ src: candidate, loadedAt: Date.now() });
    };
    img.onerror = () => {
      if (!cancelled) setState({ src: null, loadedAt: null });
    };
    img.src = candidate;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [token, enabled, cycle]);

  return state;
}
