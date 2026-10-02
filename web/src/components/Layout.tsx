/**
 * App shell: header (brand, nav, wallet), routed content, footer (chain, launchpad, runner health).
 *
 * @module components/Layout
 */
import { NavLink, Outlet, ScrollRestoration } from 'react-router';
import { CORE_ADDRESS, CORE_LABEL, TARGET_CHAIN, VENUE } from '../config';
import { useHealth } from '../queries';
import { WalletButton } from './WalletButton';
import { AddressLink } from './common';

function navClass({ isActive }: { isActive: boolean }): string {
  return `px-2 py-1 rounded hover:no-underline ${isActive ? 'text-acid' : 'text-dim hover:text-fg'}`;
}

function RunnerHealth() {
  const health = useHealth();
  if (health.isPending) return <span className="text-mute">runner: checking…</span>;
  if (health.isError || health.data === undefined) return <span className="text-danger">runner: unreachable</span>;
  const h = health.data;
  const lag = h.headBlock !== null && h.lastIndexedBlock !== null ? h.headBlock - h.lastIndexedBlock : null;
  return (
    <span className={h.ok ? 'text-dim' : 'text-amber'}>
      runner: {h.ok ? 'ok' : 'degraded'}
      {h.activeMinds !== null && ` · ${h.activeMinds} thinking`}
      {lag !== null && lag > 50 && ` · indexer ${lag} blocks behind`}
      {h.dryRun === true && ' · dry run'}
      {h.chainId !== null && h.chainId !== TARGET_CHAIN.id && ` · chain mismatch (${h.chainId})`}
      {h.venue !== null && h.venue !== VENUE && ` · venue mismatch (runner: ${h.venue})`}
    </span>
  );
}

/** Root layout. */
export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2 text-fg hover:no-underline">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-acid">
              <span className="h-1.5 w-1.5 rounded-full bg-acid" />
            </span>
            <span className="font-bold tracking-tight">
              www<span className="text-acid">/</span>rh
            </span>
          </NavLink>
          <span className="hidden text-[11px] text-mute md:inline">every coin has a mind</span>
          <nav className="ml-2 flex items-center gap-1 text-[13px]">
            <NavLink to="/" end className={navClass}>
              minds
            </NavLink>
            <NavLink to="/create" className={navClass}>
              create
            </NavLink>
          </nav>
          <div className="ml-auto">
            <WalletButton />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">
        <Outlet />
      </main>
      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-3 text-[11px] text-mute">
          <span>
            {TARGET_CHAIN.name} · chain {TARGET_CHAIN.id}
          </span>
          <span>
            {VENUE === 'pons' ? 'venue pons · ' : ''}
            {CORE_LABEL} {CORE_ADDRESS !== null ? <AddressLink address={CORE_ADDRESS} /> : <span className="text-amber">not configured</span>}
          </span>
          <RunnerHealth />
          <span className="ml-auto">minds run on Claude; their compute is paid from their own vaults</span>
        </div>
      </footer>
      <ScrollRestoration />
    </div>
  );
}
