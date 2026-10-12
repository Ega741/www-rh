/** Progress of a transaction flow (burn + memo, approve → register, revoke). */
import type { FlowState, StepState } from '../lib/steps.js';
import { TxLink } from './Hash.jsx';
import { Dot, Spinner } from './ui.jsx';

function StepIcon({ status }: { status: StepState['status'] }) {
  switch (status) {
    case 'signing':
    case 'pending':
      return <Spinner size={14} className="text-accent" />;
    case 'confirmed':
      return <Dot tone="ok" />;
    case 'failed':
      return <Dot tone="err" />;
    case 'skipped':
      return <Dot tone="neutral" />;
    case 'idle':
      return <span className="inline-block h-2 w-2 rounded-full border border-line-strong" aria-hidden />;
  }
}

function statusText(s: StepState): string {
  switch (s.status) {
    case 'idle':
      return 'waiting';
    case 'skipped':
      return 'not needed';
    case 'signing':
      return 'confirm in wallet…';
    case 'pending':
      return 'confirming on chain…';
    case 'confirmed':
      return 'confirmed';
    case 'failed':
      return s.error ?? 'failed';
  }
}

/** Renders the steps of `flow`. */
export function StepList({ flow }: { flow: FlowState }) {
  if (flow.steps.length === 0) return null;
  return (
    <ol className="space-y-2" aria-live="polite">
      {flow.steps.map((s, i) => (
        <li key={s.id} className="flex items-start gap-3 rounded-lg border border-line bg-elevated/50 px-3 py-2 text-sm">
          <span className="mt-1.5 flex w-4 justify-center">
            <StepIcon status={s.status} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              <span className="mr-2 font-mono text-xs text-faint">{i + 1}</span>
              {s.label}
            </p>
            <p className={`text-xs ${s.status === 'failed' ? 'text-err' : 'text-muted'}`}>
              {statusText(s)}
              {s.signature !== undefined ? (
                <>
                  {' · '}
                  <TxLink signature={s.signature} />
                </>
              ) : null}
            </p>
            {s.logs !== undefined && s.logs.length > 0 ? (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-faint">program logs</summary>
                <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg p-2 text-[11px] leading-4 text-muted">{s.logs.join('\n')}</pre>
              </details>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
