/**
 * Small presentational primitives shared across routes.
 *
 * @module components/common
 */
import { useState, type ReactNode } from 'react';
import { shortAddress, shortHash } from '../format';
import { addressUrl, txUrl } from '../lib/chain';
import type { CurvePhaseName, MindStatusName } from '../lib/types';
import type { TxFlow } from '../hooks/useTxFlow';

/** Status dot + label (W3: paused is shown as "paused by creator"). */
export function StatusBadge({ status, compact = false }: { status: MindStatusName; compact?: boolean }) {
  const label = status === 'alive' ? 'alive' : status === 'paused' ? 'paused by creator' : 'sleeping';
  const dot =
    status === 'alive'
      ? 'bg-acid animate-pulse-dot'
      : status === 'paused'
        ? 'bg-amber'
        : 'bg-mute';
  const title =
    status === 'alive'
      ? 'The mind is running: browsing, thinking and remembering.'
      : status === 'paused'
        ? 'The creator paused this mind. Its vault is untouched until it resumes.'
        : 'Dormant: the vault cannot pay for compute right now. Feeding the mind (or trading its coin) wakes it up.';
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" title={title}>
      <span className={`inline-block h-2 w-2 rounded-full ${dot}`} />
      {!compact && <span className={status === 'alive' ? 'text-acid' : status === 'paused' ? 'text-amber' : 'text-dim'}>{label}</span>}
    </span>
  );
}

/** Curve phase chip. */
export function PhaseBadge({ phase }: { phase: CurvePhaseName }) {
  const cls = phase === 'graduated' ? 'text-violet border-violet/40' : phase === 'complete' ? 'text-amber border-amber/40' : 'text-dim';
  const label = phase === 'graduated' ? 'graduated' : phase === 'complete' ? 'curve complete' : 'bonding';
  return <span className={`chip ${cls}`}>{label}</span>;
}

/** Progress bar (0..100). */
export function ProgressBar({ percent, tone = 'acid' }: { percent: number; tone?: 'acid' | 'amber' | 'violet' }) {
  const p = Math.max(0, Math.min(100, percent));
  const color = tone === 'amber' ? 'bg-amber' : tone === 'violet' ? 'bg-violet' : 'bg-acid';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full ${color} transition-[width] duration-500`} style={{ width: `${p}%` }} />
    </div>
  );
}

/** External link opening in a new tab; renders plain text when `href` is null. */
export function ExternalLink({ href, children, className = '' }: { href: string | null; children: ReactNode; className?: string }) {
  if (href === null) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
    </a>
  );
}

/** Address with explorer link. */
export function AddressLink({ address, label, chars = 4 }: { address: string; label?: string; chars?: number }) {
  return (
    <ExternalLink href={addressUrl(address)} className="tabular-nums">
      {label ?? shortAddress(address, chars)}
    </ExternalLink>
  );
}

/** Transaction hash with explorer link. */
export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <ExternalLink href={txUrl(hash)} className="tabular-nums">
      {label ?? shortHash(hash)}
    </ExternalLink>
  );
}

/** Copy-to-clipboard button. */
export function CopyButton({ value, label = 'copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="text-[11px] text-mute hover:text-fg"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'copied' : label}
    </button>
  );
}

/** Bordered panel with a header row. */
export function Panel({ title, right, children, className = '' }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <span>{title}</span>
        {right}
      </header>
      {children}
    </section>
  );
}

/** Empty state copy block. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-fg">{title}</p>
      {children !== undefined && <div className="mt-1 text-dim">{children}</div>}
    </div>
  );
}

/** Inline status line for a {@link TxFlow}. */
export function TxStatus({ tx, labels = {} }: { tx: TxFlow; labels?: Partial<Record<'signing' | 'pending' | 'confirmed', string>> }) {
  if (tx.phase === 'idle' && tx.error === null) return null;
  return (
    <div className="mt-2 space-y-0.5 text-[12px]">
      {tx.phase === 'signing' && <p className="text-dim">{labels.signing ?? 'Confirm in your wallet…'}</p>}
      {tx.phase === 'pending' && (
        <p className="text-dim">
          {labels.pending ?? 'Waiting for confirmation…'} {tx.hash !== undefined && <TxLink hash={tx.hash} />}
        </p>
      )}
      {tx.phase === 'confirmed' && (
        <p className="text-acid">
          {labels.confirmed ?? 'Confirmed.'} {tx.hash !== undefined && <TxLink hash={tx.hash} />}
        </p>
      )}
      {tx.error !== null && <p className="text-danger">{tx.error}</p>}
    </div>
  );
}

/** Coin avatar: metadata image or a generated monogram. */
export function MindAvatar({ image, symbol, size = 40 }: { image: string | null; symbol: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const src = image !== null ? resolveImage(image) : null;
  if (src !== null && !broken) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded border border-line object-cover"
        style={{ width: size, height: size }}
        onError={() => setBroken(true)}
        loading="lazy"
      />
    );
  }
  const hue = [...symbol].reduce((h, c) => (h * 31 + (c.codePointAt(0) ?? 0)) % 360, 7);
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded border border-line text-[11px] font-bold"
      style={{ width: size, height: size, background: `hsl(${hue} 45% 14%)`, color: `hsl(${hue} 80% 70%)` }}
      aria-hidden
    >
      {symbol.slice(0, 3).toUpperCase()}
    </div>
  );
}

/** Resolves `ipfs://` image references through a public gateway; passes http(s)/data: through. */
export function resolveImage(image: string): string | null {
  if (image.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${image.slice('ipfs://'.length)}`;
  if (/^https?:\/\//.test(image) || image.startsWith('data:image/')) return image;
  return null;
}
