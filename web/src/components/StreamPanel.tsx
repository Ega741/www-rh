/**
 * Live browser view: frames from the WebSocket drawn on a canvas, the current URL in a
 * browser-like address bar, and the connection state. Falls back to polling `frame.jpg` while
 * no WebSocket frame has arrived.
 *
 * @module components/StreamPanel
 */
import { useEffect, useRef } from 'react';
import { clockTime, displayUrl, timeAgo } from '../format';
import { useLiveFrame } from '../hooks/useLiveFrame';
import { useNow } from '../hooks/useTick';
import type { StreamState } from '../lib/stream';
import type { MindDetail } from '../lib/types';

function decodeBase64Jpeg(data: string): Blob {
  const b64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : data;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

function ConnectionPill({ state, alive }: { state: StreamState['connection']; alive: boolean }) {
  const map = {
    open: alive ? (['live', 'text-danger', 'bg-danger animate-pulse'] as const) : (['connected', 'text-dim', 'bg-acid-dim'] as const),
    connecting: ['connecting', 'text-dim', 'bg-mute'],
    reconnecting: ['reconnecting', 'text-amber', 'bg-amber'],
    closed: ['offline', 'text-mute', 'bg-mute'],
    idle: ['offline', 'text-mute', 'bg-mute'],
  } as const;
  const [label, text, dot] = map[state];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider ${text}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/** Props of {@link StreamPanel}. */
export interface StreamPanelProps {
  mind: MindDetail;
  stream: StreamState;
}

/** See module docs. */
export function StreamPanel({ mind, stream }: StreamPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const now = useNow(1_000);
  const fallback = useLiveFrame(mind.token, { enabled: stream.frame === null, refresh: stream.frame === null && mind.status === 'alive' });
  const url = stream.currentUrl ?? mind.currentUrl;
  const status = mind.status;
  const frameAt = stream.frame?.at ?? fallback.loadedAt;

  useEffect(() => {
    const frame = stream.frame;
    if (frame === null) return undefined;
    let cancelled = false;
    let blob: Blob;
    try {
      blob = decodeBase64Jpeg(frame.jpegBase64);
    } catch {
      return undefined;
    }
    void createImageBitmap(blob)
      .then((bitmap) => {
        const canvas = canvasRef.current;
        if (cancelled || canvas === null) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
        bitmap.close();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [stream.frame]);

  return (
    <section className="panel overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-2">
        <span className="flex gap-1" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-line-2" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-2" />
          <span className="h-2.5 w-2.5 rounded-full bg-line-2" />
        </span>
        <div className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1 text-[12px] text-dim" title={url ?? undefined}>
          {url !== null ? (
            <a href={url} target="_blank" rel="noreferrer noopener" className="text-dim hover:text-fg">
              {displayUrl(url, 96)}
            </a>
          ) : (
            <span className="text-mute">about:blank</span>
          )}
        </div>
        <ConnectionPill state={stream.connection} alive={status === 'alive'} />
      </div>
      <div className="relative aspect-[16/10] bg-bg">
        {stream.frame !== null ? (
          <canvas ref={canvasRef} className="h-full w-full object-contain" aria-label={`Live view of ${mind.name}'s browser`} />
        ) : fallback.src !== null ? (
          <img src={fallback.src} alt={`Latest view of ${mind.name}'s browser`} className="h-full w-full object-contain" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-fg">
              {status === 'alive'
                ? 'The mind has not opened its browser yet.'
                : status === 'paused'
                  ? 'Paused by its creator.'
                  : 'The mind is asleep.'}
            </p>
            <p className="max-w-md text-dim">
              {status === 'alive'
                ? 'Frames appear here the moment its next thought starts.'
                : status === 'paused'
                  ? 'The stream resumes when the creator unpauses it.'
                  : 'Its vault cannot pay for compute right now. Feed it and it wakes up on the next scheduler pass.'}
            </p>
          </div>
        )}
        <div className="scanlines pointer-events-none absolute inset-0" />
        {frameAt !== null && (
          <span className="absolute right-2 bottom-2 rounded bg-bg/80 px-1.5 py-0.5 text-[11px] text-dim" title={clockTime(frameAt)}>
            frame {timeAgo(frameAt, now)}
          </span>
        )}
        {stream.lastError !== null && (
          <span className="absolute bottom-2 left-2 max-w-[70%] truncate rounded bg-bg/80 px-1.5 py-0.5 text-[11px] text-amber">{stream.lastError}</span>
        )}
      </div>
    </section>
  );
}
