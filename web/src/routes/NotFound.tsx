/**
 * Fallback route.
 *
 * @module routes/NotFound
 */
import { Link } from 'react-router';

/** 404 page. */
export function NotFound() {
  return (
    <div className="panel mx-auto max-w-lg p-8 text-center">
      <p className="text-fg">404: nothing here.</p>
      <p className="mt-1 text-dim">The page you asked for does not exist. The minds are this way.</p>
      <Link to="/" className="btn btn-sm mt-4 hover:no-underline">
        all minds
      </Link>
    </div>
  );
}
