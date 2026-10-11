/** Standard loading / error / empty handling around a TanStack query result. */
import type { ReactNode } from 'react';
import { describeError } from '../lib/errors.js';
import { Button, Empty, Note, Skeleton } from './ui.jsx';

/** The subset of a query result the guard needs. */
export interface GuardedQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch(): unknown;
}

/** Renders skeletons while pending, an error note with retry on failure, `empty` when `isEmpty(data)`. */
export function QueryGuard<T>({
  query,
  children,
  isEmpty,
  empty,
  skeleton,
}: {
  query: GuardedQuery<T>;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
}) {
  if (query.isPending) {
    return (
      <>
        {skeleton ?? (
          <div className="space-y-2" aria-busy="true" aria-live="polite">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
      </>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <Note
        tone="err"
        title="Could not load"
        actions={
          <Button size="sm" onClick={() => void query.refetch()}>
            Retry
          </Button>
        }
      >
        {query.isError ? describeError(query.error) : 'No data'}
      </Note>
    );
  }
  if (isEmpty !== undefined && isEmpty(query.data)) {
    return <>{empty ?? <Empty title="Nothing here yet" />}</>;
  }
  return <>{children(query.data)}</>;
}
