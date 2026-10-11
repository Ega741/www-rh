/** Toast viewport (bottom-right, stacked). */
import { useToast, type ToastKind } from '../hooks/useToast.jsx';

const TONE: Record<ToastKind, string> = {
  info: 'border-info/40',
  success: 'border-ok/50',
  error: 'border-err/50',
  warning: 'border-warn/50',
};

/** Renders the active toasts. */
export function Toasts() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-end gap-2 p-4 sm:inset-x-auto sm:right-0 sm:w-96" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={`pointer-events-auto w-full rounded-lg border bg-elevated px-3 py-2 text-sm shadow-lg ${TONE[t.kind]}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-medium">{t.title}</p>
              {t.message !== undefined ? <p className="mt-0.5 break-words text-xs text-muted">{t.message}</p> : null}
            </div>
            <button type="button" className="text-muted hover:text-fg" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
