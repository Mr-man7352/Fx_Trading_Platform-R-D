'use client';

import type { WsServerMessage } from '@fx/types';
import { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from './api-base';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface UseWsOptions {
  /** Channels to subscribe to on open, e.g. ['signals', 'backtests', 'risk.halt']. */
  channels: string[];
  /** Called for every `{type:'event'}` frame on a subscribed channel. */
  onEvent?: (channel: string, payload: unknown, at: string) => void;
  enabled?: boolean;
}

function wsUrl(token: string): string {
  const base = API_BASE_URL.replace(/^http/, 'ws');
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

/**
 * BE-014 — thin WebSocket subscription hook. Mints a bearer at `/api/token`,
 * opens `/ws?token=…`, (re)subscribes to `channels`, and reconnects with backoff
 * on drop. The API closes the socket with a `TOKEN_EXPIRED` frame at the token's
 * `exp`; we treat that like any disconnect and reconnect with a fresh token.
 */
export function useWs({ channels, onEvent, enabled = true }: UseWsOptions): WsStatus {
  const [status, setStatus] = useState<WsStatus>('closed');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const channelsKey = channels.join(',');

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    async function connect() {
      if (closed) return;
      setStatus('connecting');
      let token: string | undefined;
      try {
        const res = await fetch('/api/token', { cache: 'no-store' });
        token = res.ok ? ((await res.json()).token as string) : undefined;
      } catch {
        token = undefined;
      }
      if (closed || !token) {
        scheduleReconnect();
        return;
      }
      socket = new WebSocket(wsUrl(token));

      socket.onopen = () => {
        retry = 0;
        setStatus('open');
        for (const channel of channelsKey ? channelsKey.split(',') : []) {
          socket?.send(JSON.stringify({ type: 'subscribe', channel }));
        }
      };
      socket.onmessage = (ev) => {
        let msg: WsServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as WsServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'event') onEventRef.current?.(msg.channel, msg.payload, msg.at);
      };
      socket.onclose = () => {
        setStatus('closed');
        scheduleReconnect();
      };
      socket.onerror = () => socket?.close();
    }

    function scheduleReconnect() {
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retry, 15_000);
      retry += 1;
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [enabled, channelsKey]);

  return status;
}
