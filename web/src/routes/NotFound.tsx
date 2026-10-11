/** 404 route. */
import { Link } from 'react-router';

/** Shown for unknown paths. */
export function NotFound() {
  return (
    <div className="mx-auto my-16 max-w-md text-center">
      <p className="font-mono text-6xl font-semibold text-accent">404</p>
      <h1 className="mt-3 text-xl font-semibold">There is nothing here</h1>
      <p className="mt-2 text-sm text-muted">The page you asked for does not exist. Try the dashboard or the docs.</p>
      <div className="mt-6 flex justify-center gap-2">
        <Link to="/app" className="btn-primary">
          Open the app
        </Link>
        <Link to="/docs" className="btn-secondary">
          Docs
        </Link>
      </div>
    </div>
  );
}
