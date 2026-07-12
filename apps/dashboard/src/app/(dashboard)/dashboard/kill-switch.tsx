'use client';

import { KillSwitchButton } from '@fx/ui';

/**
 * Client wrapper for <KillSwitchButton> (server pages can't pass callbacks).
 * The API exists since Step 3.3 (BE-072): `POST /settings/kill-switch` with
 * `{ action: 'activate', reason, twoFactorCode? }`. Wiring it here needs the
 * authenticated api-client session (Phase 5, FE-033/BE-030) — until then the
 * dashboard has no token source, so this stays a visible no-op and operators
 * use the API directly (see PHASE3_TESTING_GUIDE.md §D).
 */
export function KillSwitch({ compact = false }: { compact?: boolean }) {
  return (
    <KillSwitchButton
      compact={compact}
      onConfirm={async () => {
        // FE-033 (Phase 5): await api.killSwitch.activate({ reason, twoFactorCode });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }}
    />
  );
}
