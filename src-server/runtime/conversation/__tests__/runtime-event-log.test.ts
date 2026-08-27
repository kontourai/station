import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Off by default so every other test in this file sees the real filesystem.
const readdirOrder = vi.hoisted(() => ({ reverse: false }));

vi.mock('node:fs/promises', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  return {
    ...actual,
    default: actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const entries = await actual.readdir(...args);
      return readdirOrder.reverse
        ? ([...entries].reverse() as typeof entries)
        : entries;
    },
  };
});

import { RuntimeEventLog } from '../runtime-event-log.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe('RuntimeEventLog startup discovery', () => {
  it('reports bounded file metadata without parsing persisted event lines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    const invalidLine = '{this is intentionally not json}\n';
    await writeFile(join(events, 'events-2026-07-11.ndjson'), invalidLine);
    await writeFile(
      join(events, 'events-2026-07-12.ndjson'),
      invalidLine.repeat(10_000),
    );
    await writeFile(
      join(events, 'events-2026-07-13.ndjson'),
      invalidLine.repeat(20_000),
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Pin the clock like every other test in this file. The fixture day names
    // are fixed, so reading the real clock made this assertion a function of
    // the calendar rather than of the retention contract: on 2026-08-10 UTC the
    // 2026-07-11 file turned exactly 30 days old, tripped the 30-day retention
    // boundary, and this test began failing on pristine main for everyone.
    await new RuntimeEventLog(events, logger, {
      now: () => new Date('2026-07-13T22:00:00.000Z'),
    }).loadRecentEvents();

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Discovered persisted event logs',
      {
        fileCount: 3,
        recentFileCount: 2,
        recentBytes: invalidLine.length * 10_000 + invalidLine.length * 20_000,
        retainedBytes: invalidLine.length * 30_001,
        removedFileCount: 0,
        removedBytes: 0,
        retentionDays: 30,
        retentionMaxBytes: 256 * 1024 * 1024,
      },
    );
  });

  it('removes expired files while protecting the active UTC day', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    await writeFile(join(events, 'events-2026-05-01.ndjson'), 'expired\n');
    await writeFile(join(events, 'events-2026-06-14.ndjson'), 'boundary\n');
    await writeFile(join(events, 'events-2026-07-13.ndjson'), 'active\n');
    await writeFile(join(events, 'audit-export.ndjson'), 'unmanaged\n');
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await new RuntimeEventLog(events, logger, {
      now: () => new Date('2026-07-13T22:00:00.000Z'),
    }).loadRecentEvents();

    expect((await readdir(events)).sort()).toEqual([
      'audit-export.ndjson',
      'events-2026-06-14.ndjson',
      'events-2026-07-13.ndjson',
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      'Discovered persisted event logs',
      expect.objectContaining({ removedFileCount: 1, removedBytes: 8 }),
    );
  });

  it('removes oldest closed-day files to enforce the byte ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    await writeFile(join(events, 'events-2026-07-11.ndjson'), '1'.repeat(10));
    await writeFile(join(events, 'events-2026-07-12.ndjson'), '2'.repeat(10));
    await writeFile(join(events, 'events-2026-07-13.ndjson'), '3'.repeat(10));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await new RuntimeEventLog(events, logger, {
      retention: { maxAgeDays: 30, maxBytes: 20 },
      now: () => new Date('2026-07-13T22:00:00.000Z'),
    }).loadRecentEvents();

    expect(await readdir(events)).toEqual([
      'events-2026-07-12.ndjson',
      'events-2026-07-13.ndjson',
    ]);
  });

  it('queries retained event history after pruning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    await writeFile(
      join(events, 'events-2026-07-12.ndjson'),
      `${JSON.stringify({
        timestamp: '2026-07-12T12:00:00.000Z',
        userId: 'user-1',
      })}\n`,
    );
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = new RuntimeEventLog(events, logger, {
      now: () => new Date('2026-07-13T22:00:00.000Z'),
    });

    await log.loadRecentEvents();
    await expect(
      log.queryEvents(
        Date.parse('2026-07-12T00:00:00.000Z'),
        Date.parse('2026-07-13T00:00:00.000Z'),
        'user-1',
      ),
    ).resolves.toEqual([
      { timestamp: '2026-07-12T12:00:00.000Z', userId: 'user-1' },
    ]);
  });

  it('returns rows chronologically even when readdir does not', async () => {
    // `readdir` guarantees no ordering. APFS returns these sorted, so on this
    // machine the bug is invisible; ext4/overlayfs — what the shipped
    // container runs on — hash-orders them. Since a bounded query tail-slices
    // this array, enumeration order decides WHICH rows survive.
    //
    // So force the unsorted case. An earlier version of this test wrote the
    // files in reverse creation order and asserted the result was lexical,
    // which cannot fail on a filesystem that sorts anyway — it read as
    // coverage while proving nothing. The reason given for not mocking
    // (`vi.spyOn` cannot redefine an ESM namespace export) was true and
    // beside the point: the sibling receipt-chain-read-order test mocks the
    // whole module for exactly this, which is what this now does.
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    const days = ['2026-07-10', '2026-07-11', '2026-07-12'];
    for (const day of days) {
      await writeFile(
        join(events, `events-${day}.ndjson`),
        `${JSON.stringify({
          timestamp: `${day}T12:00:00.000Z`,
          userId: 'user-1',
        })}\n`,
      );
    }

    readdirOrder.reverse = true;
    try {
      const log = new RuntimeEventLog(events, {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      });
      const rows = await log.queryEvents(
        Date.parse('2026-07-01T00:00:00.000Z'),
        Date.parse('2026-07-31T00:00:00.000Z'),
        'user-1',
      );
      expect(rows.map((row) => row.timestamp)).toEqual(
        days.map((day) => `${day}T12:00:00.000Z`),
      );
    } finally {
      readdirOrder.reverse = false;
    }
  });

  it('reapplies retention after the UTC day rolls over without a restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    let now = new Date('2026-07-12T23:59:00.000Z');
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = new RuntimeEventLog(events, logger, {
      retention: { maxAgeDays: 1, maxBytes: 1024 },
      now: () => now,
    });

    await log.persist({ timestamp: now.toISOString() });
    now = new Date('2026-07-13T00:01:00.000Z');
    await log.persist({ timestamp: now.toISOString() });

    expect(await readdir(events)).toEqual(['events-2026-07-13.ndjson']);
  });

  it('persists the current event when best-effort retention fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    await mkdir(join(events, 'events-2026-05-01.ndjson'));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const log = new RuntimeEventLog(events, logger, {
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    await log.persist({ timestamp: '2026-07-13T12:00:00.000Z' });

    expect(await readdir(events)).toContain('events-2026-07-13.ndjson');
    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to apply monitoring event retention',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it('allows concurrent runtimes to prune the same expired file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'station-runtime-events-'));
    roots.push(root);
    const events = join(root, 'monitoring');
    await mkdir(events);
    await writeFile(join(events, 'events-2026-05-01.ndjson'), 'expired\n');
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const options = {
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    };

    await Promise.all([
      new RuntimeEventLog(events, logger, options).loadRecentEvents(),
      new RuntimeEventLog(events, logger, options).loadRecentEvents(),
    ]);

    expect(await readdir(events)).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
