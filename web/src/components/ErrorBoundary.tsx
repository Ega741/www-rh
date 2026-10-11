/** Render-error boundary and the react-router route error element. */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, isRouteErrorResponse, useRouteError } from 'react-router';
import { describeError } from '../lib/errors.js';
import { Button } from './ui.jsx';

interface State {
  error: unknown;
}

/** Catches render errors below it and shows a recoverable panel. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === undefined) return this.props.children;
    return (
      <ErrorPanel title="Something broke" message={describeError(this.state.error)}>
        <Button onClick={() => this.setState({ error: undefined })}>Try again</Button>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </ErrorPanel>
    );
  }
}

/** Generic full-width error panel. */
export function ErrorPanel({ title, message, children }: { title: string; message: string; children?: ReactNode }) {
  return (
    <div className="mx-auto my-16 max-w-lg px-4 text-center" role="alert">
      <p className="font-mono text-xs uppercase tracking-widest text-err">error</p>
      <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
      <p className="mt-2 break-words text-sm text-muted">{message}</p>
      {children !== undefined ? <div className="mt-6 flex justify-center gap-2">{children}</div> : null}
    </div>
  );
}

/** `errorElement` of the data router. */
export function RouteError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) {
    return (
      <ErrorPanel title={error.status === 404 ? 'Page not found' : `HTTP ${error.status}`} message={error.statusText || 'The router could not render this page.'}>
        <Link className="btn-secondary" to="/">
          Home
        </Link>
      </ErrorPanel>
    );
  }
  return (
    <ErrorPanel title="Something broke" message={describeError(error)}>
      <Link className="btn-secondary" to="/">
        Home
      </Link>
      <Button variant="ghost" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </ErrorPanel>
  );
}
