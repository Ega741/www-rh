/**
 * Labelled form field with an error or hint line (create / launch / adopt forms).
 *
 * @module components/FormField
 */
import type { ReactNode } from 'react';

/** Label + control + error (or hint). */
export function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <span className="label">{label}</span>
      {children}
      {error !== undefined ? <p className="mt-1 text-[12px] text-danger">{error}</p> : hint !== undefined ? <p className="mt-1 text-[11px] text-mute">{hint}</p> : null}
    </div>
  );
}
