/** Providers (TanStack Query, toasts, Solana wallet, session) and the data router (SPEC §7 routes). */
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { RouteError } from './components/ErrorBoundary.jsx';
import { Layout } from './components/Layout.jsx';
import { AppShell } from './components/SessionGate.jsx';
import { SessionProvider } from './hooks/useSession.jsx';
import { ToastProvider } from './hooks/useToast.jsx';
import { SolanaProviders } from './providers/SolanaProviders.jsx';
import { Docs } from './routes/Docs.jsx';
import { Landing } from './routes/Landing.jsx';
import { Models } from './routes/Models.jsx';
import { NotFound } from './routes/NotFound.jsx';
import { Budgets } from './routes/app/Budgets.jsx';
import { Credits } from './routes/app/Credits.jsx';
import { Keys } from './routes/app/Keys.jsx';
import { Overview } from './routes/app/Overview.jsx';
import { Providers } from './routes/app/Providers.jsx';
import { Receipt } from './routes/app/Receipt.jsx';
import { Upgrades } from './routes/app/Upgrades.jsx';
import { Usage } from './routes/app/Usage.jsx';

/** Shared query client. Query keys hold only strings/numbers (bigint lives in the data). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

/** The route tree. */
export const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    ErrorBoundary: RouteError,
    children: [
      { index: true, Component: Landing },
      { path: 'models', Component: Models },
      { path: 'docs', Component: Docs },
      {
        path: 'app',
        Component: AppShell,
        children: [
          { index: true, Component: Overview },
          { path: 'credits', Component: Credits },
          { path: 'keys', Component: Keys },
          { path: 'usage', Component: Usage },
          { path: 'receipts/:id', Component: Receipt },
          { path: 'providers', Component: Providers },
          { path: 'upgrades', Component: Upgrades },
          { path: 'budgets', Component: Budgets },
        ],
      },
      { path: '*', Component: NotFound },
    ],
  },
]);

/** Root component. */
export function App() {
  return (
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <SolanaProviders>
            <SessionProvider>
              <RouterProvider router={router} />
            </SessionProvider>
          </SolanaProviders>
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>
  );
}
