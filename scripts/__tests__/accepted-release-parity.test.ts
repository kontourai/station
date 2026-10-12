import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acceptedReleaseRules } from '../../packages/shared/src/accepted-release.mjs';
import {
  ACCEPTED_RELEASE_FILENAME,
  decideAgainstAcceptedRelease,
  recordAcceptedRelease,
} from '../../packages/shared/src/prebuilt-archive.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

/**
 * The accepted-release record (#187) is one implementation
 * (packages/shared/src/accepted-release.mjs) that install.sh carries as a
 * generated block. These cases run install.sh's own functions, cut out of
 * the shipped script with its generated blocks (check_accepted_release with
 * its exit and message handling, record_accepted_release), against the
 * shared module the Windows installer core and the server use: the same
 * records and offered versions must give the same decision, the same words
 * and the same file.
 */

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
const installSh = readFileSync(join(root, 'install.sh'), 'utf8');

function between(start: string, end: string): string {
  const from = installSh.indexOf(start);
  const to = installSh.indexOf(end, from);
  if (from < 0 || to < from)
    throw new Error(`install.sh no longer has ${start.trim()}`);
  return installSh.slice(from, to);
}

function shellFunctions(): string {
  const rings = /^RELEASE_RINGS_JSON=.*$/m.exec(installSh)?.[0];
  if (!rings) throw new Error('install.sh no longer has RELEASE_RINGS_JSON');
  return [
    rings,
    between(
      '# BEGIN GENERATED ACCEPTED RELEASE PROGRAM',
      '# END GENERATED ACCEPTED RELEASE PROGRAM',
    ),
    between('accepted_release_file() {\n', '# Downgrade protection'),
    // install.sh's own fail and explicit-request helpers, reduced to what
    // the functions above observe.
    `fail() { printf '%s\\n' "$1" >&2; exit 12; }`,
    'explicit_replacement_requested() { [ "$EXPLICIT" = 1 ]; }',
  ].join('\n');
}

type Decision = { action: string; message: string };

function shellCheck(
  installRoot: string,
  ring: string,
  version: string,
  explicit: boolean,
): Decision {
  const result = spawnSync(
    'sh',
    ['-c', `${shellFunctions()}\ncheck_accepted_release`],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        install_root: installRoot,
        release_channel: ring,
        release_version: version,
        EXPLICIT: explicit ? '1' : '0',
      },
    },
  );
  const out = result.stdout.trim();
  const err = result.stderr.trim();
  if (result.status === 12) return { action: 'refuse', message: err };
  if (result.status !== 0)
    return { action: `exit ${result.status}`, message: err };
  if (err) return { action: 'warn', message: err };
  if (out) return { action: 'note', message: out };
  return { action: 'ok', message: '' };
}

function shellRecord(installRoot: string, ring: string, version: string) {
  return spawnSync(
    'sh',
    ['-c', `${shellFunctions()}\nrecord_accepted_release`],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        install_root: installRoot,
        release_channel: ring,
        release_version: version,
      },
    },
  ).status;
}

function tsRecord(installRoot: string, ring: string, version: string) {
  try {
    recordAcceptedRelease(installRoot, ring, version);
    return 0;
  } catch {
    return 1;
  }
}

const mark = (releaseChannel: string, version: string) =>
  `${JSON.stringify({ schemaVersion: 1, releaseChannel, version })}\n`;

type Relation = 'absent' | 'not-older' | 'older' | 'incomparable' | 'invalid';

type Case = {
  ring: string;
  /** The record's text, or null for none. */
  existing: string | null;
  offered: string;
  /** What the record leaves (null: no file) and whether it refused. */
  recorded: string | null;
  refused?: boolean;
  relation: Relation;
  /** The record file's mode, or `symlink` / `foreign` for an unsafe file. */
  unsafe?: number | 'symlink' | 'foreign';
};

const CASES: Case[] = [
  {
    ring: 'stable',
    existing: null,
    offered: '1.2.3',
    recorded: '1.2.3',
    relation: 'absent',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.2.4',
    recorded: '1.3.0',
    relation: 'older',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.3.0',
    recorded: '1.3.0',
    relation: 'not-older',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.3.1',
    recorded: '1.3.1',
    relation: 'not-older',
  },
  // The first review's probes: another ring's shape never lowers a record.
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.2.4-preview.1',
    recorded: '1.3.0',
    refused: true,
    relation: 'incomparable',
  },
  {
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.1'),
    offered: '1.2.3',
    recorded: '1.2.4-preview.1',
    refused: true,
    relation: 'incomparable',
  },
  {
    // Another prerelease ring at the same X.Y.Z: unordered, never written.
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.3'),
    offered: '1.2.4-nightly.5',
    recorded: '1.2.4-preview.3',
    refused: true,
    relation: 'incomparable',
  },
  {
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.3'),
    offered: '1.2.4-preview.2',
    recorded: '1.2.4-preview.3',
    relation: 'older',
  },
  {
    // Numeric, not string, order: 10 > 9.
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.9'),
    offered: '1.2.4-preview.10',
    recorded: '1.2.4-preview.10',
    relation: 'not-older',
  },
  {
    ring: 'nightly',
    existing: mark('nightly', '1.2.4-nightly.5'),
    offered: '1.3.0-nightly.1',
    recorded: '1.3.0-nightly.1',
    relation: 'not-older',
  },
  // Nightly numbering moves from a build counter to a dated
  // YYYYMMDDBB number: a legacy record still reads, and a dated build
  // orders after it (and a replayed legacy build before a dated record).
  {
    ring: 'nightly',
    existing: mark('nightly', '0.1.11-nightly.247504'),
    offered: '0.1.11-nightly.2026101103',
    recorded: '0.1.11-nightly.2026101103',
    relation: 'not-older',
  },
  {
    ring: 'nightly',
    existing: mark('nightly', '0.1.11-nightly.2026101103'),
    offered: '0.1.11-nightly.247504',
    recorded: '0.1.11-nightly.2026101103',
    relation: 'older',
  },
  {
    ring: 'nightly',
    existing: mark('nightly', '0.1.11-nightly.2026101103'),
    offered: '0.1.11-nightly.2026101104',
    recorded: '0.1.11-nightly.2026101104',
    relation: 'not-older',
  },
  // Invalid records: refused by the check, replaced by the record.
  {
    ring: 'preview',
    existing: mark('nightly', '1.2.4-nightly.5'),
    offered: '1.0.0-preview.1',
    recorded: '1.0.0-preview.1',
    relation: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.2.4-preview.1'),
    offered: '1.0.0',
    recorded: '1.0.0',
    relation: 'invalid',
  },
  {
    ring: 'stable',
    existing: 'not json',
    offered: '1.0.0',
    recorded: '1.0.0',
    relation: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    unsafe: 0o644,
    offered: '1.0.0',
    recorded: '1.0.0',
    relation: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    unsafe: 'symlink',
    offered: '1.0.0',
    recorded: '1.0.0',
    relation: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    unsafe: 'foreign',
    offered: '1.0.0',
    recorded: '1.0.0',
    relation: 'invalid',
  },
];

const posix = typeof process.getuid === 'function';
const superuser = posix && process.getuid?.() === 0;

function canRun(c: Case): boolean {
  if (c.unsafe === undefined) return true;
  // Owner and mode are POSIX checks; another owner needs root to arrange.
  if (c.unsafe === 'foreign') return superuser;
  return posix;
}

function setUp(c: Case): string {
  const installRoot = makeTempDir('station-accepted-parity-');
  const path = join(installRoot, ACCEPTED_RELEASE_FILENAME);
  if (c.existing === null) return installRoot;
  if (c.unsafe === 'symlink') {
    const target = join(installRoot, 'elsewhere.json');
    writeFileSync(target, c.existing, { mode: 0o600 });
    symlinkSync(target, path);
    return installRoot;
  }
  writeFileSync(path, c.existing, { mode: 0o600 });
  chmodSync(path, typeof c.unsafe === 'number' ? c.unsafe : 0o600);
  if (c.unsafe === 'foreign') chownSync(path, 1, 1);
  return installRoot;
}

function recordedVersion(installRoot: string): string | null {
  const path = join(installRoot, ACCEPTED_RELEASE_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

const REFUSAL_WORDS: Record<Relation, RegExp | null> = {
  absent: null,
  'not-older': null,
  older:
    /^refusing Station v\S+: this install already accepted the newer signed release v\S+, so this manifest is stale or replayed/,
  incomparable:
    /^cannot compare Station v\S+ with v\S+, the newest release this install accepted/,
  invalid: /^cannot read the newest release this install accepted \(/,
};

describe('accepted-release record: install.sh and the shared module agree (#187)', () => {
  it.each(CASES.filter(canRun))(
    '$ring: record $existing ($unsafe), offered $offered',
    (c) => {
      for (const explicit of [false, true]) {
        const installRoot = setUp(c);
        const sh = shellCheck(installRoot, c.ring, c.offered, explicit);
        const ts = decideAgainstAcceptedRelease(
          installRoot,
          c.ring,
          c.offered,
          explicit,
        );
        // The same decision and the same words.
        expect(sh, `explicit=${explicit}`).toEqual(ts);
        const words = REFUSAL_WORDS[c.relation];
        if (!explicit) {
          expect(ts.action).toBe(words ? 'refuse' : 'ok');
          if (words) expect(ts.message).toMatch(words);
        } else {
          expect(ts.action).toBe(
            c.relation === 'invalid' ? 'warn' : words ? 'note' : 'ok',
          );
        }
      }
      for (const side of ['sh', 'ts'] as const) {
        const installRoot = setUp(c);
        const status =
          side === 'sh'
            ? shellRecord(installRoot, c.ring, c.offered)
            : tsRecord(installRoot, c.ring, c.offered);
        expect(status, side).toBe(c.refused ? 1 : 0);
        expect(recordedVersion(installRoot), side).toBe(c.recorded);
        if (c.unsafe === 'symlink')
          // The link itself was replaced; its target is untouched.
          expect(
            readFileSync(join(installRoot, 'elsewhere.json'), 'utf8'),
            side,
          ).toBe(c.existing);
        expect(
          readdirSync(installRoot).filter((name) => name.endsWith('.tmp')),
          side,
        ).toEqual([]);
        rmSync(installRoot, { recursive: true, force: true });
      }
    },
  );

  it('is not blocked by a staging file or link left at a process-id name', () => {
    // A killed run used to leave `<record>.<pid>.tmp`, and process ids repeat
    // (in containers especially), so every later run failed with EEXIST.
    const installRoot = makeTempDir('station-accepted-stage-leftover-');
    const record = join(installRoot, ACCEPTED_RELEASE_FILENAME);
    const target = join(installRoot, 'victim.txt');
    writeFileSync(target, 'untouched\n');
    writeFileSync(`${record}.${process.pid}.tmp`, 'left by a killed run\n');
    symlinkSync(target, `${record}.${process.ppid}.tmp`);
    recordAcceptedRelease(installRoot, 'stable', '1.2.3');
    expect(recordedVersion(installRoot)).toBe('1.2.3');
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    // The seed path too.
    rmSync(record);
    recordAcceptedRelease(installRoot, 'stable', '1.2.3', true);
    expect(recordedVersion(installRoot)).toBe('1.2.3');
  });

  it('never follows a link planted at the staging name', () => {
    // A fixed suffix stands in for the random one, so the link can be placed
    // exactly where the staging file would go.
    const rules = acceptedReleaseRules(
      { stable: { prerelease: false } },
      { closeSync, lstatSync, openSync, readFileSync, rmSync, writeFileSync },
      renameSync,
      () => Buffer.from('0123456789abcdef', 'hex'),
    );
    const installRoot = makeTempDir('station-accepted-stage-link-');
    const record = join(installRoot, ACCEPTED_RELEASE_FILENAME);
    const target = join(installRoot, 'victim.txt');
    writeFileSync(target, 'untouched\n');
    symlinkSync(target, `${record}.0123456789abcdef.tmp`);
    expect(() => rules.record(record, 'stable', '1.2.3', false)).toThrow(
      /EEXIST/,
    );
    expect(readFileSync(target, 'utf8')).toBe('untouched\n');
    expect(existsSync(record)).toBe(false);
  });
});
