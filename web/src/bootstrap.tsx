/** Mounts the app. Imported dynamically by `main.tsx` after the Buffer polyfill is in place. */
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import '@solana/wallet-adapter-react-ui/styles.css';
import './styles.css';

/** Renders `<App />` into `#root`. */
export function bootstrap(): void {
  const root = document.getElementById('root');
  if (root === null) throw new Error('#root not found');
  createRoot(root).render(<App />);
}
