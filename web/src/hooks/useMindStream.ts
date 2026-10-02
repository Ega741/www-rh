/**
 * Subscribes to one mind's WebSocket stream and exposes the reduced {@link StreamState}.
 * Trades and status changes also invalidate the related REST queries.
 *
 * @module hooks/useMindStream
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useReducer } from 'react';
import type { Address } from 'viem';
import { WS_BASE } from '../config';
import { initialStreamState, streamReducer, type StreamState } from '../lib/stream';
import { queryKeys } from '../queries';
import { MindSocket, mindStreamUrl } from '../ws';

/** Live stream state for `token` (idle when `token` is undefined). */
export function useMindStream(token: Address | undefined): StreamState {
  const [state, dispatch] = useReducer(streamReducer, initialStreamState);
  const queryClient = useQueryClient();

  useEffect(() => {
    dispatch({ type: 'reset' });
    if (token === undefined) return undefined;
    const socket = new MindSocket({
      url: mindStreamUrl(WS_BASE, token),
      onState: (s) => dispatch({ type: 'connection', state: s }),
      onMessage: (message) => {
        dispatch({ type: 'message', message, receivedAt: Date.now() });
        if (message.type === 'trade') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.mind(token) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.trades(token) });
        } else if (message.type === 'status') {
          void queryClient.invalidateQueries({ queryKey: queryKeys.mind(token) });
        } else if (message.type === 'memory' && message.memory.anchorTx !== null) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.memories(token) });
        }
      },
    });
    socket.start();
    return () => socket.stop();
  }, [token, queryClient]);

  return state;
}
