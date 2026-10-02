/**
 * Live thumbnail: re-fetches `GET /api/minds/:token/frame.jpg` every 5 s (SPEC §7), preloading
 * each new frame off-screen and swapping only after it decoded, so a 404 or a slow frame never
 * blanks the current image.
 *
 * @module hooks/useLiveFrame
 */
import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { frameUrl } from '../api';
import { useTick } from './useTick';

/** Frame refresh period for thumbnails. */
export const THUMBNAIL_REFRESH_MS = 5_000;

/** Latest successfully loaded frame URL (or `null` while none exists). */
export function useLiveFrame(token: Address, enabled: boolean): { src: string | null; loadedAt: number | null } {
  const tick = useTick(THUMBNAIL_REFRESH_MS);
  const [state, setState] = useState<{ src: string | null; loadedAt: number | null }>({ src: null, loadedAt: null });

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const candidate = frameUrl(token, Date.now());
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!cancelled) setState({ src: candidate, loadedAt: Date.now() });
    };
    img.src = candidate;
    return () => {
      cancelled = true;
      img.onload = null;
    };
  }, [token, enabled, tick]);

  return state;
}
