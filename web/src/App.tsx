/**
 * Providers (wagmi, TanStack Query) and the router.
 *
 * @module App
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { WagmiProvider } from 'wagmi';
import { Layout } from './components/Layout';
import { Create } from './routes/Create';
import { Home } from './routes/Home';
import { Mind } from './routes/Mind';
import { NotFound } from './routes/NotFound';
import { wagmiConfig } from './wagmi';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: 2,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <Home /> },
      { path: 'create', element: <Create /> },
      { path: 'mind/:token', element: <Mind /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

/** Root component. */
export function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </WagmiProvider>
  );
}
