/** Presentational primitives: cards, buttons, badges, inputs, stats, states, code blocks. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { useCopy } from '../hooks/useCopy.js';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Card container with optional title / actions. */
export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string | undefined }) {
  return (
    <section className={cx('card', className)}>
      {title !== undefined || actions !== undefined ? (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title !== undefined ? <h2 className="card-title">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** Button variants. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Button with a variant, optional busy spinner and a `reason` tooltip when disabled. */
export function Button({
  variant = 'secondary',
  size,
  busy = false,
  reason,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm'; busy?: boolean; reason?: string | undefined }) {
  const isDisabled = disabled === true || busy;
  return (
    <button
      type="button"
      className={cx(`btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      disabled={isDisabled}
      aria-disabled={isDisabled}
      title={isDisabled && reason !== undefined ? reason : undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : null}
      {children}
    </button>
  );
}

/** Badge tones. */
export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'accent';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'border-line-strong text-muted',
  ok: 'border-ok/40 text-ok',
  warn: 'border-warn/40 text-warn',
  err: 'border-err/40 text-err',
  info: 'border-info/40 text-info',
  accent: 'border-accent/50 text-accent',
};

/** Small mono badge. */
export function Badge({ tone = 'neutral', children, className, title }: { tone?: BadgeTone; children: ReactNode; className?: string | undefined; title?: string | undefined }) {
  return (
    <span className={cx('badge', BADGE_TONES[tone], className)} title={title}>
      {children}
    </span>
  );
}

/** Coloured dot for health states. */
export function Dot({ tone, className }: { tone: BadgeTone; className?: string }) {
  const color = tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'err' ? 'bg-err' : tone === 'info' ? 'bg-info' : tone === 'accent' ? 'bg-accent' : 'bg-faint';
  return <span aria-hidden className={cx('inline-block h-2 w-2 rounded-full', color, className)} />;
}

/** Label + control + hint/error. */
export function Field({ label, hint, error, children, htmlFor }: { label: ReactNode; hint?: ReactNode | undefined; error?: string | undefined; children: ReactNode; htmlFor?: string | undefined }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error !== undefined ? (
        <p className="mt-1 text-xs text-err" role="alert">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p className="mt-1 text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  );
}

/** Text input. */
export function Input({ className, mono, ...rest }: InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }) {
  return <input className={cx('input', mono && 'font-mono', className)} {...rest} />;
}

/** Select input. */
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('input', className)} {...rest}>
      {children}
    </select>
  );
}

/** Segmented control. */
export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-lg border border-line-strong bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-md px-3 py-1 text-xs font-medium transition-colors', o.value === value ? 'bg-elevated text-fg' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Spinner. */
export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx('animate-spin text-muted', className)} width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Skeleton block for loading states. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('pulse rounded-md bg-elevated', className ?? 'h-4 w-24')} aria-hidden />;
}

/** Empty state. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm text-muted">{title}</p>
      {children !== undefined ? <div className="mt-3 text-sm">{children}</div> : null}
    </div>
  );
}

/** Inline note tones. */
export type NoteTone = 'info' | 'warn' | 'err' | 'ok';

const NOTE_TONES: Record<NoteTone, string> = {
  info: 'border-info/30 bg-info/5 text-fg',
  warn: 'border-warn/40 bg-warn/5 text-fg',
  err: 'border-err/40 bg-err/5 text-fg',
  ok: 'border-ok/40 bg-ok/5 text-fg',
};

/** Inline note / alert. */
export function Note({ tone = 'info', title, children, actions }: { tone?: NoteTone; title?: string | undefined; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div role={tone === 'err' ? 'alert' : 'status'} className={cx('rounded-lg border px-3 py-2 text-sm', NOTE_TONES[tone])}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {title !== undefined ? <p className="font-medium">{title}</p> : null}
          {children !== undefined ? <div className={cx('text-muted', title !== undefined && 'mt-0.5')}>{children}</div> : null}
        </div>
        {actions}
      </div>
    </div>
  );
}

/** KPI tile. */
export function Stat({ label, value, sub, mono = true }: { label: ReactNode; value: ReactNode; sub?: ReactNode | undefined; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-elevated/60 px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className={cx('mt-1 truncate text-lg font-semibold', mono && 'font-mono')}>{value}</p>
      {sub !== undefined ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
    </div>
  );
}

/** Copy-to-clipboard button. */
export function CopyButton({ text, label = 'Copy', size = 'sm', className }: { text: string; label?: string; size?: 'sm'; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button variant="ghost" size={size} className={className} onClick={() => void copy(text)} aria-label={`${label} to clipboard`}>
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** Code block with a copy button. */
export function Code({ code, lang, title }: { code: string; lang?: string | undefined; title?: string | undefined }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg">
      <div className="flex items-center justify-between border-b border-line px-3 py-1">
        <span className="font-mono text-[11px] text-faint">{title ?? lang ?? ''}</span>
        <CopyButton text={code} />
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-5 text-fg">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Definition list row. */
export function Row({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line/60 py-2 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="w-44 shrink-0 text-xs uppercase tracking-wider text-muted">{label}</dt>
      <dd className={cx('min-w-0 break-words text-sm', mono && 'font-mono')}>{children}</dd>
    </div>
  );
}

/** Page header. */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {lead !== undefined ? <p className="mt-1 max-w-2xl text-sm text-muted">{lead}</p> : null}
      </div>
      {actions}
    </header>
  );
}

/** Responsive table wrapper. */
export function TableWrap({ children }: { children: ReactNode }) {
  return <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">{children}</div>;
}
