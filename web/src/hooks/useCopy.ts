/** Clipboard helper with a textarea fallback and a transient "copied" flag. */
import { useCallback, useEffect, useRef, useState } from 'react';

/** Writes `text` to the clipboard; resolves `false` when neither method is available. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** `copy(text)` plus a `copied` flag that resets after `resetMs`. */
export function useCopy(resetMs = 1800): { copied: boolean; copy: (text: string) => Promise<boolean> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      setCopied(ok);
      window.clearTimeout(timer.current);
      if (ok) timer.current = window.setTimeout(() => setCopied(false), resetMs);
      return ok;
    },
    [resetMs],
  );
  return { copied, copy };
}
