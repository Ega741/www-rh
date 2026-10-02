/**
 * `IntersectionObserver` visibility of an element (used to refresh only visible thumbnails).
 *
 * @module hooks/useInView
 */
import { useEffect, useState, type RefObject } from 'react';

/** Whether the referenced element is (roughly) in the viewport. Defaults to `true` without IO support. */
export function useInView(ref: RefObject<Element | null>, rootMargin = '200px'): boolean {
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) setInView(entry.isIntersecting);
    }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return inView;
}
