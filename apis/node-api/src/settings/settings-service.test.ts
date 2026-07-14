import { DEFAULT_PLATFORM_SETTINGS, type PlatformSettings } from '@fx/types';
import { describe, expect, it } from 'vitest';
import {
  CachedSettingsReader,
  mergeSettings,
  parseStoredSettings,
  type SettingsDb,
  SettingsService,
} from './settings-service.js';

/** BE-100 — merge/validate/version semantics with a fake DB. */

function fakeDb() {
  const rows: Array<{
    version: number;
    settings: unknown;
    updatedById: string | null;
    createdAt: Date;
  }> = [];
  const db: SettingsDb = {
    platformSettings: {
      async findFirst() {
        return rows[rows.length - 1] ?? null;
      },
      async create({ data }) {
        const row = {
          version: rows.length + 1,
          settings: data.settings,
          updatedById: data.updatedById,
          createdAt: new Date('2026-07-13T10:00:00Z'),
        };
        rows.push(row);
        return row;
      },
    },
  };
  return { db, rows };
}

describe('mergeSettings (BE-100)', () => {
  it('overlays a partial risk patch over the current document', () => {
    const merged = mergeSettings(DEFAULT_PLATFORM_SETTINGS, {
      risk: { entryGatePreFilter: 0.55, debateRoundsHighEntropy: 1 },
    });
    expect(merged.risk.entryGatePreFilter).toBe(0.55);
    expect(merged.risk.debateRoundsHighEntropy).toBe(1);
    // untouched keys keep defaults
    expect(merged.risk.perInstrumentDailyLossPct).toBe(0.02);
    expect(merged.risk.clusterLookbackDays).toBe(60);
  });

  it('enforces bounds server-side (authoritative contract)', () => {
    expect(() =>
      mergeSettings(DEFAULT_PLATFORM_SETTINGS, { risk: { entryGatePreFilter: 0.3 } }),
    ).toThrow(); // below 0.5 min
    expect(() =>
      mergeSettings(DEFAULT_PLATFORM_SETTINGS, { risk: { perInstrumentDailyLossPct: 0.5 } }),
    ).toThrow(); // above 0.1 max
  });
});

describe('parseStoredSettings', () => {
  it('falls back to defaults on unknown/corrupt rows (never bricks a boot)', () => {
    expect(parseStoredSettings(null)).toEqual(DEFAULT_PLATFORM_SETTINGS);
    expect(parseStoredSettings({ risk: { entryGatePreFilter: 99 } })).toEqual(
      DEFAULT_PLATFORM_SETTINGS,
    );
  });
});

describe('SettingsService', () => {
  it('returns version 0 defaults before any write', async () => {
    const { db } = fakeDb();
    const service = new SettingsService(db);
    const res = await service.effective();
    expect(res.version).toBe(0);
    expect(res.settings).toEqual(DEFAULT_PLATFORM_SETTINGS);
    expect(res.updatedAt).toBeNull();
  });

  it('appends a new version per patch; latest wins', async () => {
    const { db, rows } = fakeDb();
    const service = new SettingsService(db);
    await service.patch({ risk: { entryGatePreFilter: 0.6 } }, 'user-1');
    const second = await service.patch({ risk: { weekendGapFlatten: false } }, 'user-1');
    expect(rows).toHaveLength(2); // append-only, no updates
    expect(second.version).toBe(2);
    // second patch merged over the FIRST patch's result, not defaults
    expect(second.settings.risk.entryGatePreFilter).toBe(0.6);
    expect(second.settings.risk.weekendGapFlatten).toBe(false);
  });
});

describe('CachedSettingsReader (BE-100 "next cycle uses new values")', () => {
  it('serves cache within TTL and refreshes after it', async () => {
    const { db } = fakeDb();
    const service = new SettingsService(db);
    let clock = 0;
    const reader = new CachedSettingsReader(service, 1000, () => clock);

    clock = 2000; // first read: cache is stale (fetchedAt=0)
    const first = await reader.effective();
    expect(first.risk.entryGatePreFilter).toBe(0.5);

    await service.patch({ risk: { entryGatePreFilter: 0.7 } }, null);
    clock = 2500; // within TTL — still old value
    expect((await reader.effective()).risk.entryGatePreFilter).toBe(0.5);
    clock = 3100; // TTL passed — picks up the new version
    expect((await reader.effective()).risk.entryGatePreFilter).toBe(0.7);
  });

  it('fail-open: a DB error serves the last good value', async () => {
    let shouldThrow = false;
    const { db } = fakeDb();
    const service = new SettingsService({
      platformSettings: {
        findFirst: (args) => {
          if (shouldThrow) throw new Error('db down');
          return db.platformSettings.findFirst(args);
        },
        create: db.platformSettings.create,
      },
    });
    await service.patch({ risk: { entryGatePreFilter: 0.65 } }, null);
    let clock = 1000;
    const reader = new CachedSettingsReader(service, 100, () => clock);
    const good: PlatformSettings = await reader.effective();
    expect(good.risk.entryGatePreFilter).toBe(0.65);

    shouldThrow = true;
    clock = 5000;
    expect((await reader.effective()).risk.entryGatePreFilter).toBe(0.65); // cached, no throw
  });
});
