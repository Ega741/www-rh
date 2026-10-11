/** App shell: header with nav + wallet button, config/chain banners, outlet, footer, toasts. */
import { NavLink, Outlet, Link } from 'react-router';
import { config } from '../config.js';
import { ChainGuardBanner } from './ChainGuardBanner.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { Toasts } from './Toasts.jsx';
import { Note } from './ui.jsx';
import { WalletButton } from './WalletButton.jsx';

const NAV = [
  { to: '/models', label: 'Models' },
  { to: '/docs', label: 'Docs' },
  { to: '/app', label: 'App' },
] as const;

function navClass({ isActive }: { isActive: boolean }): string {
  return `rounded-md px-2.5 py-1.5 text-sm transition-colors ${isActive ? 'bg-elevated text-fg' : 'text-muted hover:text-fg'}`;
}

/** Root layout of every route. */
export function Layout() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-4">
            <Link to="/" className="flex items-center gap-2 font-mono text-base font-semibold tracking-tight">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent font-bold text-accent-fg">B</span>
              <span className="hidden sm:inline">beagle</span>
            </Link>
            <nav className="flex items-center gap-1" aria-label="Primary">
              {NAV.map((n) => (
                <NavLink key={n.to} to={n.to} className={navClass}>
                  {n.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <WalletButton />
        </div>
      </header>
      {config.errors.length > 0 ? (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3">
          <Note tone="err" title="Configuration problem">
            <ul className="list-disc pl-4">
              {config.errors.map((e) => (
                <li key={e} className="font-mono text-xs">
                  {e}
                </li>
              ))}
            </ul>
          </Note>
        </div>
      ) : null}
      <ChainGuardBanner />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-faint">
          <span>
            Beagle · compute for agents on <span className="font-mono">{config.chain.name}</span> (chain {config.chainId})
          </span>
          <span className="font-mono">burn becomes compute</span>
        </div>
      </footer>
      <Toasts />
    </div>
  );
}
