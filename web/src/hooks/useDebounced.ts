/**
 * Debounced copy of a value (quote reads while typing).
 *
 * @module hooks/useDebounced
 */
import { useEffect, useState } from 'react';

/** Returns `value` after it stopped changing for `delayMs`. */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
