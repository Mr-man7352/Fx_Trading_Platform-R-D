'use client';

import { create } from 'zustand';
import type { WsStatus } from '@/lib/use-ws';

/**
 * FE-120 — shared realtime-connection state. The single global WS subscription
 * (RealtimeProvider) writes here; the reconnect banner and any tile that wants
 * a stale-data indicator read from it (AC: "disconnect ⇒ reconnect banner +
 * stale indicator on tiles").
 */
interface ConnectionState {
  status: WsStatus;
  /** Set once the FIRST connection succeeds — gates the reconnect banner so a
   * cold page load doesn't flash "reconnecting". */
  hasConnected: boolean;
  lastEventAt: string | null;
  setStatus(status: WsStatus): void;
  markEvent(at: string): void;
}

export const useConnection = create<ConnectionState>((set) => ({
  status: 'closed',
  hasConnected: false,
  lastEventAt: null,
  setStatus: (status) =>
    set((s) => ({ status, hasConnected: s.hasConnected || status === 'open' })),
  markEvent: (at) => set({ lastEventAt: at }),
}));
