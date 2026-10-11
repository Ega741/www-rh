/** Usage summary windows (`GET /api/usage/summary?window=`). */

/** Allowed windows. */
export const USAGE_WINDOWS = ['24h', '7d', '30d'] as const;
/** One of {@link USAGE_WINDOWS}. */
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** `true` when `v` is a {@link UsageWindow}. */
export function isUsageWindow(v: string | null | undefined): v is UsageWindow {
  return v === '24h' || v === '7d' || v === '30d';
}

/** Human label. */
export function windowLabel(w: UsageWindow): string {
  switch (w) {
    case '24h':
      return 'Last 24 hours';
    case '7d':
      return 'Last 7 days';
    case '30d':
      return 'Last 30 days';
  }
}
