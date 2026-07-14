import {
  DEFAULT_PLATFORM_SETTINGS,
  type PlatformSettings,
  PlatformSettingsSchema,
  type RiskSettings,
  type SettingsPatch,
  type SettingsResponse,
} from '@fx/types';

/**
 * BE-100 — settings persistence + effective-value resolution.
 *
 * Storage model: `platform_settings` is APPEND-ONLY (like the audit log) —
 * every PATCH inserts a new version row containing the FULL merged document;
 * the latest row is effective. Merging happens over the compiled defaults
 * (`DEFAULT_PLATFORM_SETTINGS`), so a partial historical row can never brick
 * a boot, and a bad write is rolled back by simply PATCHing again.
 *
 * Consumers ("next signal cycle uses new values" — AC):
 *   - signals worker: `entryGatePreFilter` (ADR-010 pre-filter) and
 *     `debateRounds*` (assembler config) are read per cycle via
 *     {@link CachedSettingsReader} (TTL ≤ 15 s ≪ H1 cadence).
 *   - risk gate: `perInstrumentDailyLossPct` + `weekendGapFlatten` overlay the
 *     env-derived RiskGateConfig per evaluation.
 * Knobs owned by Python (cluster lookback/threshold/cadence, session
 * multipliers) are persisted + surfaced here; the quant service reads them via
 * the settings table on its next scheduled pass (QN-048 owns the maths).
 */

/** The subset of PrismaClient this service touches (test-fake friendly). */
export interface SettingsDb {
  platformSettings: {
    findFirst(args: { orderBy: { version: 'desc' } }): Promise<{
      version: number;
      settings: unknown;
      updatedById: string | null;
      createdAt: Date;
    } | null>;
    create(args: { data: { settings: PlatformSettings; updatedById: string | null } }): Promise<{
      version: number;
      settings: unknown;
      updatedById: string | null;
      createdAt: Date;
    }>;
  };
}

/** Deep-merge a patch over the current document (risk-section granularity). */
export function mergeSettings(current: PlatformSettings, patch: SettingsPatch): PlatformSettings {
  const merged: PlatformSettings = {
    ...current,
    risk: { ...current.risk, ...(patch.risk ?? {}) } as RiskSettings,
  };
  // Re-validate the merged document — bounds are enforced HERE, server-side.
  return PlatformSettingsSchema.parse(merged);
}

/** Parse a stored row tolerantly: unknown/invalid rows fall back to defaults. */
export function parseStoredSettings(raw: unknown): PlatformSettings {
  const result = PlatformSettingsSchema.safeParse(raw);
  return result.success ? result.data : DEFAULT_PLATFORM_SETTINGS;
}

export class SettingsService {
  constructor(private readonly db: SettingsDb) {}

  /** Latest stored version merged over defaults (version 0 = defaults only). */
  async effective(): Promise<SettingsResponse> {
    const row = await this.db.platformSettings.findFirst({ orderBy: { version: 'desc' } });
    if (!row) {
      return {
        version: 0,
        settings: DEFAULT_PLATFORM_SETTINGS,
        updatedAt: null,
        updatedBy: null,
      };
    }
    return {
      version: row.version,
      settings: parseStoredSettings(row.settings),
      updatedAt: row.createdAt.toISOString(),
      updatedBy: row.updatedById,
    };
  }

  /** Validate + merge + append a new version. Throws ZodError on bad values. */
  async patch(patch: SettingsPatch, actorId: string | null): Promise<SettingsResponse> {
    const current = await this.effective();
    const merged = mergeSettings(current.settings, patch);
    const row = await this.db.platformSettings.create({
      data: { settings: merged, updatedById: actorId },
    });
    return {
      version: row.version,
      settings: merged,
      updatedAt: row.createdAt.toISOString(),
      updatedBy: row.updatedById,
    };
  }
}

// ── Worker-side cached reader (BE-100 "next cycle uses new values") ─────────

export interface SettingsReader {
  effective(): Promise<PlatformSettings>;
}

/** TTL-cached reader for hot paths (signals worker, risk gate). Fail-open to
 * the last good value (or defaults) — a DB blip never blocks a cycle. */
export class CachedSettingsReader implements SettingsReader {
  private cached: PlatformSettings = DEFAULT_PLATFORM_SETTINGS;
  private fetchedAt = 0;

  constructor(
    private readonly service: SettingsService,
    private readonly ttlMs: number = 15_000,
    private readonly now: () => number = Date.now,
  ) {}

  async effective(): Promise<PlatformSettings> {
    const age = this.now() - this.fetchedAt;
    if (age < this.ttlMs) return this.cached;
    try {
      const res = await this.service.effective();
      this.cached = res.settings;
      this.fetchedAt = this.now();
    } catch (err) {
      // Keep serving the last good value; refresh retries next call.
      console.warn('[settings] effective() read failed — serving cached/defaults:', err);
      this.fetchedAt = this.now(); // back off a full TTL, don't hammer a down DB
    }
    return this.cached;
  }
}
