'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import { type ReactNode, useState } from 'react';
import { Toaster } from 'sonner';

/**
 * FE-006 / FE-120 — client providers: NextAuth session, TanStack Query for
 * server-state, and the Sonner toaster the WS layer pushes signal/fill/halt
 * notifications into (FE-120).
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster theme="dark" position="top-right" richColors closeButton />
      </QueryClientProvider>
    </SessionProvider>
  );
}
