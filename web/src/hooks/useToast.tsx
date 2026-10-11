/** Toast notifications: a tiny context with auto-dismiss. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/** Toast severity. */
export type ToastKind = 'info' | 'success' | 'error' | 'warning';

/** One toast. */
export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

/** Input of `push`. */
export interface ToastInput {
  kind?: ToastKind;
  title: string;
  message?: string;
  /** Auto-dismiss delay in ms (default 6000; 0 keeps it until dismissed). */
  ttlMs?: number;
}

interface ToastApi {
  toasts: Toast[];
  push(input: ToastInput): number;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

/** Provides {@link useToast}. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (input: ToastInput): number => {
      const id = nextId.current++;
      const toast: Toast = { id, kind: input.kind ?? 'info', title: input.title, ...(input.message === undefined ? {} : { message: input.message }) };
      setToasts((list) => [...list.slice(-4), toast]);
      const ttl = input.ttlMs ?? 6000;
      if (ttl > 0) window.setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastApi>(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

/** Access the toast API. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === undefined) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
