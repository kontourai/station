// @vitest-environment node

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServerLogReader,
  DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES,
} from '../server-log-reader.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-log-reader-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureEntry {
  level: string;
  timestamp: string;
  msg: string;
  [key: string]: unknown;
}

/** Appends fixture lines to `server-<date>.ndjson`, one JSON object per
 * line, mirroring the shape `server-log-store.ts` durably writes. */
function writeDay(
  directory: string,
  date: string,
  lines: readonly (FixtureEntry | string)[],
): void {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `server-${date}.ndjson`);
  const text = `${lines
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')}\n`;
  writeFileSync(path, text, 'utf8');
}

function entry(
  level: string,
  isoTime: string,
  msg: string,
  extra: Record<string, unknown> = {},
): FixtureEntry {
  return { level, timestamp: isoTime, msg, pid: 123, ...extra };
}

describe('ServerLogReader — empty directory', () => {
  it('returns an honest empty result for a missing/empty log directory', async () => {
    const directory = join(createTempDir(), 'does-not-exist');
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result).toEqual({
      entries: [],
      truncated: false,
      scannedFiles: 0,
      unreadableFiles: 0,
      oldestScannedDay: null,
      skippedMalformedLines: 0,
      scanBudgetExhausted: false,
    });
  });
});

describe('ServerLogReader — minimum level filtering', () => {
  it('excludes entries below the requested minimum severity', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('trace', '2026-08-01T00:00:01.000Z', 'trace line'),
      entry('debug', '2026-08-01T00:00:02.000Z', 'debug line'),
      entry('info', '2026-08-01T00:00:03.000Z', 'info line'),
      entry('warn', '2026-08-01T00:00:04.000Z', 'warn line'),
      entry('error', '2026-08-01T00:00:05.000Z', 'error line'),
      entry('fatal', '2026-08-01T00:00:06.000Z', 'fatal line'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ level: 'warn' });

    expect(result.entries.map((e) => e.msg)).toEqual([
      'warn line',
      'error line',
      'fatal line',
    ]);
  });
});

describe('ServerLogReader — since/until', () => {
  it('bounds entries to the [since, until] window, inclusive', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T10:00:00.000Z', 'too early'),
      entry('info', '2026-08-01T12:00:00.000Z', 'lower bound'),
      entry('info', '2026-08-01T13:00:00.000Z', 'in range'),
      entry('info', '2026-08-01T14:00:00.000Z', 'upper bound'),
      entry('info', '2026-08-01T16:00:00.000Z', 'too late'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({
      since: '2026-08-01T12:00:00.000Z',
      until: '2026-08-01T14:00:00.000Z',
    });

    expect(result.entries.map((e) => e.msg)).toEqual([
      'lower bound',
      'in range',
      'upper bound',
    ]);
  });
});

describe('ServerLogReader — q substring filter', () => {
  it('matches case-insensitively over the redacted rendering', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'connecting to DATABASE'),
      entry('info', '2026-08-01T00:00:02.000Z', 'unrelated message'),
      entry('info', '2026-08-01T00:00:03.000Z', 'database connection closed'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ q: 'database' });

    expect(result.entries.map((e) => e.msg)).toEqual([
      'connecting to DATABASE',
      'database connection closed',
    ]);
  });

  describe('is never an oracle over pre-redaction content (station#1896 review round 2, HIGH #1)', () => {
    it('returns ZERO matches when q is the exact secret value that redaction hides', async () => {
      const directory = createTempDir();
      const seededSecret = 'sk-live-abcdefghijklmnopqrstuvwxyz01';
      writeDay(directory, '2026-08-01', [
        entry('info', '2026-08-01T00:00:01.000Z', 'config loaded', {
          config: { apiKey: seededSecret },
        }),
      ]);
      const reader = createServerLogReader({ directory });

      // The entry exists and would match on `msg` alone...
      const byMsg = await reader.query({ q: 'config loaded' });
      expect(byMsg.entries).toHaveLength(1);

      // ...but querying for the exact secret text must find nothing: the
      // response never contained it (it renders as [REDACTED]), so a
      // caller cannot use `q` to confirm/extract the value character by
      // character via match/no-match.
      const bySecret = await reader.query({ q: seededSecret });
      expect(bySecret.entries).toHaveLength(0);

      // A prefix of the secret is equally unrecoverable.
      const byPrefix = await reader.query({ q: seededSecret.slice(0, 10) });
      expect(byPrefix.entries).toHaveLength(0);
    });

    it('q="[REDACTED]" matches any entry that had a field redacted — sane, documented semantics', async () => {
      const directory = createTempDir();
      writeDay(directory, '2026-08-01', [
        entry('info', '2026-08-01T00:00:01.000Z', 'config loaded', {
          config: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz01' },
        }),
        entry('info', '2026-08-01T00:00:02.000Z', 'nothing secret here'),
      ]);
      const reader = createServerLogReader({ directory });

      const result = await reader.query({ q: '[REDACTED]' });

      expect(result.entries.map((e) => e.msg)).toEqual(['config loaded']);
    });
  });
});

describe('ServerLogReader — tail semantics', () => {
  it('returns the LAST N matches, in chronological order (not the first N)', async () => {
    const directory = createTempDir();
    // 10 sequential entries; last-N (limit 3) must be 8,9,10 — chronological
    // — which only equals the first-N (1,2,3) if the fixture is symmetric.
    // It deliberately is not, so a first-N regression is caught.
    const lines = Array.from({ length: 10 }, (_, i) =>
      entry(
        'info',
        `2026-08-01T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
        `line ${i + 1}`,
      ),
    );
    writeDay(directory, '2026-08-01', lines);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ limit: 3 });

    expect(result.entries.map((e) => e.msg)).toEqual([
      'line 8',
      'line 9',
      'line 10',
    ]);
    expect(result.truncated).toBe(true);
  });

  it('is not truncated when every match fits within the limit', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'one'),
      entry('info', '2026-08-01T00:00:02.000Z', 'two'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ limit: 200 });

    expect(result.entries).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });
});

describe('ServerLogReader — chronological ordering under multi-writer interleave (station#1896 review round 2, MEDIUM #5)', () => {
  it('sorts the returned window by parsed timestamp, not raw append/scan order', async () => {
    const directory = createTempDir();
    // Deliberately written OUT of timestamp order — simulates two
    // processes/instances interleaving writes to the same day file.
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:03.000Z', 'third'),
      entry('info', '2026-08-01T00:00:01.000Z', 'first'),
      entry('info', '2026-08-01T00:00:02.000Z', 'second'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries.map((e) => e.msg)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('ServerLogReader — limit default and hard cap', () => {
  it('defaults to 200 when no limit is given', async () => {
    const directory = createTempDir();
    const lines = Array.from({ length: 250 }, (_, i) =>
      entry(
        'info',
        new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
        `line ${i + 1}`,
      ),
    );
    writeDay(directory, '2026-08-01', lines);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries).toHaveLength(200);
    expect(result.entries[199].msg).toBe('line 250');
    expect(result.truncated).toBe(true);
  });

  it('clamps a requested limit above 1000 down to the hard cap', async () => {
    const directory = createTempDir();
    const lines = Array.from({ length: 1005 }, (_, i) =>
      entry(
        'info',
        new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
        `line ${i + 1}`,
      ),
    );
    writeDay(directory, '2026-08-01', lines);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ limit: 5000 });

    expect(result.entries).toHaveLength(1000);
    expect(result.entries[999].msg).toBe('line 1005');
    expect(result.truncated).toBe(true);
  });
});

describe('ServerLogReader — malformed-line counting', () => {
  it('skips and counts lines that are not valid JSON or lack level/timestamp', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'good line one'),
      '{not valid json',
      JSON.stringify({ msg: 'missing level and timestamp' }),
      JSON.stringify({ level: 'info', msg: 'missing timestamp' }),
      JSON.stringify({
        level: 'bogus',
        timestamp: '2026-08-01T00:00:02.000Z',
        msg: 'bad level',
      }),
      entry('info', '2026-08-01T00:00:03.000Z', 'good line two'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries.map((e) => e.msg)).toEqual([
      'good line one',
      'good line two',
    ]);
    expect(result.skippedMalformedLines).toBe(4);
  });
});

describe('ServerLogReader — unreadable files (station#1896 review round 2, HIGH #2)', () => {
  it('counts an unopenable day and forces truncated:true rather than silently shrinking coverage', async () => {
    if (process.platform === 'win32') return; // chmod is a no-op for regular files on Windows
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root bypasses permission bits

    const directory = createTempDir();
    writeDay(directory, '2026-07-30', [
      entry('info', '2026-07-30T00:00:01.000Z', 'oldest readable'),
    ]);
    const unreadablePath = join(directory, 'server-2026-07-31.ndjson');
    writeFileSync(
      unreadablePath,
      `${JSON.stringify(entry('info', '2026-07-31T00:00:01.000Z', 'middle unreadable'))}\n`,
      'utf8',
    );
    chmodSync(unreadablePath, 0o000);
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'newest readable'),
    ]);

    try {
      const reader = createServerLogReader({ directory });
      const result = await reader.query();

      expect(result.entries.map((e) => e.msg)).toEqual([
        'oldest readable',
        'newest readable',
      ]);
      expect(result.unreadableFiles).toBe(1);
      expect(result.truncated).toBe(true);
    } finally {
      chmodSync(unreadablePath, 0o600);
    }
  });
});

describe('ServerLogReader — redaction on egress (station#1922)', () => {
  it('redacts a secret-named field nested inside the entry (redactDeep)', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'config loaded', {
        config: { apiKey: 'sk-live-abcdefghijklmnopqrstuvwxyz01' },
      }),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries).toHaveLength(1);
    const config = result.entries[0].config as Record<string, unknown>;
    expect(config.apiKey).toBe('[REDACTED]');
    expect(JSON.stringify(result.entries[0])).not.toContain(
      'sk-live-abcdefghijklmnopqrstuvwxyz01',
    );
  });

  it('redacts a connection-string secret embedded in err.message free text', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('error', '2026-08-01T00:00:01.000Z', 'db connect failed', {
        err: {
          message:
            'connection failed: postgres://dbuser:sup3rSecret@db.internal:5432/station',
          stack: 'Error: connection failed\n    at connect (db.js:42:9)',
        },
      }),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries).toHaveLength(1);
    const err = result.entries[0].err as Record<string, unknown>;
    expect(err.message).not.toContain('dbuser:sup3rSecret');
    expect(err.message).toBe('connection failed: [REDACTED_URL]');
    expect(JSON.stringify(result.entries[0])).not.toContain('sup3rSecret');
  });

  it('redacts a connection-string password that itself contains an unescaped @ (station#1896 review round 2, HIGH #3)', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('error', '2026-08-01T00:00:01.000Z', 'db connect failed', {
        err: {
          message:
            'connection failed: postgres://dbuser:p@ssw0rd@db.internal:5432/station',
        },
      }),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.entries).toHaveLength(1);
    const err = result.entries[0].err as Record<string, unknown>;
    expect(err.message).not.toContain('p@ssw0rd');
    expect(err.message).not.toContain('ssw0rd');
    expect(err.message).toBe('connection failed: [REDACTED_URL]');
  });

  it('query({ redact: false }) returns the stored secret bytes (local-operator path)', async () => {
    const directory = createTempDir();
    const canary = 'local-operator-canary-material';
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'config loaded', {
        config: { apiKey: canary },
      }),
    ]);
    const reader = createServerLogReader({ directory });

    const redacted = await reader.query();
    expect(JSON.stringify(redacted.entries[0])).not.toContain(canary);
    expect((redacted.entries[0].config as Record<string, unknown>).apiKey).toBe(
      '[REDACTED]',
    );

    const local = await reader.query({ redact: false });
    expect((local.entries[0].config as Record<string, unknown>).apiKey).toBe(
      canary,
    );
    expect(JSON.stringify(local.entries[0])).toContain(canary);
  });

  it('q matches the rendering the caller will receive, not the other one', async () => {
    const directory = createTempDir();
    const canary = 'local-operator-canary-material';
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'config loaded', {
        config: { apiKey: canary },
      }),
    ]);
    const reader = createServerLogReader({ directory });

    expect((await reader.query({ q: canary })).entries).toHaveLength(0);
    expect(
      (await reader.query({ q: canary, redact: false })).entries,
    ).toHaveLength(1);
  });
});

describe('ServerLogReader — multi-day scan with early stop', () => {
  it('stops scanning older files once enough matches are found', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-07-30', [
      entry('info', '2026-07-30T00:00:01.000Z', 'day one'),
    ]);
    writeDay(directory, '2026-07-31', [
      entry('info', '2026-07-31T00:00:01.000Z', 'day two'),
    ]);
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'day three a'),
      entry('info', '2026-08-01T00:00:02.000Z', 'day three b'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ limit: 2 });

    expect(result.entries.map((e) => e.msg)).toEqual([
      'day three a',
      'day three b',
    ]);
    expect(result.scannedFiles).toBe(1);
    expect(result.oldestScannedDay).toBe('2026-08-01');
    expect(result.truncated).toBe(true);
  });

  it('scans across multiple days when the newest day alone cannot satisfy the limit', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-07-31', [
      entry('info', '2026-07-31T00:00:01.000Z', 'day two'),
    ]);
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'day three'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query({ limit: 2 });

    expect(result.entries.map((e) => e.msg)).toEqual(['day two', 'day three']);
    expect(result.scannedFiles).toBe(2);
    expect(result.oldestScannedDay).toBe('2026-07-31');
    // Exactly 2 matches exist across the whole store and both were
    // returned — genuinely complete, not just cut off at the cap.
    expect(result.truncated).toBe(false);
  });
});

describe('ServerLogReader — scan budget (station#1896 review round 2, HIGH #4)', () => {
  it('exposes the default budget as a named, importable constant', () => {
    expect(DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES).toBe(32 * 1024 * 1024);
  });

  it('stops reading and reports scanBudgetExhausted + truncated once the byte budget runs out, still returning the newest matches', async () => {
    const directory = createTempDir();
    // Each line is well over 100 bytes; a handful of them blow past a
    // deliberately tiny injected budget.
    const lines = Array.from({ length: 20 }, (_, i) =>
      entry(
        'info',
        new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
        `padded line number ${i + 1} with extra filler text to grow the byte size of this fixture line well past one hundred bytes`,
      ),
    );
    writeDay(directory, '2026-08-01', lines);
    // Small enough to guarantee only the last few lines are readable
    // before the budget is spent, generous enough to read at least one.
    const reader = createServerLogReader({ directory, scanBudgetBytes: 200 });

    const result = await reader.query({ limit: 20 });

    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.entries.length).toBeLessThan(20);
    expect(result.entries[result.entries.length - 1].msg).toBe(
      'padded line number 20 with extra filler text to grow the byte size of this fixture line well past one hundred bytes',
    );
    expect(result.scanBudgetExhausted).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('does not report the budget as exhausted when everything fits comfortably within it', async () => {
    const directory = createTempDir();
    writeDay(directory, '2026-08-01', [
      entry('info', '2026-08-01T00:00:01.000Z', 'small'),
    ]);
    const reader = createServerLogReader({ directory });

    const result = await reader.query();

    expect(result.scanBudgetExhausted).toBe(false);
    expect(result.truncated).toBe(false);
  });
});
