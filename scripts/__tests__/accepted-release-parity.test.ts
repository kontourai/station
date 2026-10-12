import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCEPTED_RELEASE_FILENAME,
  compareWithAcceptedRelease,
  readAcceptedRelease,
  recordAcceptedRelease,
} from '../../packages/shared/src/prebuilt-archive.js';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

/**
 * The accepted-release mark (#187) has two implementations: install.sh's
 * `accepted_release_node` (it must stay one standalone file) and
 * prebuilt-archive.ts, which the Windows installer core and the server use.
 * The same marks and offered versions go through both; they must leave the
 * same file and report the same relation. install.sh's own functions are run
 * as written, cut out of the shipped script with its generated ring table.
 */

const root = resolve(import.meta.dirname, '../..');
const makeTempDir = trackTempDirs();
const installSh = readFileSync(join(root, 'install.sh'), 'utf8');

function shellFunctions(): string {
  const rings = /^RELEASE_RINGS_JSON=.*$/m.exec(installSh)?.[0];
  const start = installSh.indexOf('accepted_release_file() {\n');
  const end = installSh.indexOf('check_accepted_release() {\n');
  if (!rings || start < 0 || end < start)
    throw new Error('install.sh no longer has the accepted-release functions');
  return `${rings}\n${installSh.slice(start, end)}`;
}

function runShell(
  installRoot: string,
  ring: string,
  version: string,
  mode: 'check' | 'record',
) {
  const result = spawnSync(
    'sh',
    ['-c', `${shellFunctions()}\naccepted_release_node ${mode}`],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        install_root: installRoot,
        release_channel: ring,
        release_version: version,
      },
    },
  );
  return { status: result.status, stdout: result.stdout };
}

/** The TS side's answer in install.sh's `check` vocabulary. */
function tsCheck(installRoot: string, ring: string, version: string) {
  const mark = readAcceptedRelease(installRoot, ring);
  if (mark.state === 'invalid') return { status: 1, stdout: '' };
  if (mark.state === 'absent') return { status: 0, stdout: 'absent' };
  const relation = compareWithAcceptedRelease(ring, version, mark.version);
  return {
    status: 0,
    stdout:
      relation === 'not-older' ? relation : `${relation} v${mark.version}`,
  };
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

type Case = {
  ring: string;
  /** The mark's text, or null for none. */
  existing: string | null;
  offered: string;
  /** What the record leaves (null: no file) and whether it refused. */
  recorded: string | null;
  refused?: boolean;
  check: string;
  mode?: number;
};

const CASES: Case[] = [
  {
    ring: 'stable',
    existing: null,
    offered: '1.2.3',
    recorded: '1.2.3',
    check: 'absent',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.2.4',
    recorded: '1.3.0',
    check: 'older v1.3.0',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.3.0',
    recorded: '1.3.0',
    check: 'not-older',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.3.1',
    recorded: '1.3.1',
    check: 'not-older',
  },
  // The review's probes: another ring's shape never lowers a valid mark.
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    offered: '1.2.4-preview.1',
    recorded: '1.3.0',
    refused: true,
    check: 'incomparable v1.3.0',
  },
  {
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.1'),
    offered: '1.2.3',
    recorded: '1.2.4-preview.1',
    refused: true,
    check: 'incomparable v1.2.4-preview.1',
  },
  {
    // Another prerelease ring at the same X.Y.Z: unordered, never written.
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.3'),
    offered: '1.2.4-nightly.5',
    recorded: '1.2.4-preview.3',
    refused: true,
    check: 'incomparable v1.2.4-preview.3',
  },
  {
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.3'),
    offered: '1.2.4-preview.2',
    recorded: '1.2.4-preview.3',
    check: 'older v1.2.4-preview.3',
  },
  {
    // Numeric, not string, order: 10 > 9.
    ring: 'preview',
    existing: mark('preview', '1.2.4-preview.9'),
    offered: '1.2.4-preview.10',
    recorded: '1.2.4-preview.10',
    check: 'not-older',
  },
  {
    ring: 'nightly',
    existing: mark('nightly', '1.2.4-nightly.5'),
    offered: '1.3.0-nightly.1',
    recorded: '1.3.0-nightly.1',
    check: 'not-older',
  },
  // Invalid marks: refused by the check, replaced by the record.
  {
    ring: 'preview',
    existing: mark('nightly', '1.2.4-nightly.5'),
    offered: '1.0.0-preview.1',
    recorded: '1.0.0-preview.1',
    check: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.2.4-preview.1'),
    offered: '1.0.0',
    recorded: '1.0.0',
    check: 'invalid',
  },
  {
    ring: 'stable',
    existing: 'not json',
    offered: '1.0.0',
    recorded: '1.0.0',
    check: 'invalid',
  },
  {
    ring: 'stable',
    existing: mark('stable', '1.3.0'),
    mode: 0o644,
    offered: '1.0.0',
    recorded: '1.0.0',
    check: 'invalid',
  },
];

function setUp(c: Case): string {
  const installRoot = makeTempDir('station-accepted-parity-');
  const path = join(installRoot, ACCEPTED_RELEASE_FILENAME);
  if (c.existing !== null) {
    writeFileSync(path, c.existing, { mode: 0o600 });
    chmodSync(path, c.mode ?? 0o600);
  }
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

describe('accepted-release mark: install.sh and the shared module agree (#187)', () => {
  it.each(CASES)('$ring: mark $existing, offered $offered', (c) => {
    if (c.mode !== undefined && typeof process.getuid !== 'function') return;
    const expectedCheck =
      c.check === 'invalid'
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: c.check };
    for (const side of ['sh', 'ts'] as const) {
      const installRoot = setUp(c);
      const check =
        side === 'sh'
          ? runShell(installRoot, c.ring, c.offered, 'check')
          : tsCheck(installRoot, c.ring, c.offered);
      expect(check, side).toEqual(expectedCheck);
      const status =
        side === 'sh'
          ? runShell(installRoot, c.ring, c.offered, 'record').status
          : tsRecord(installRoot, c.ring, c.offered);
      expect(status, side).toBe(c.refused ? 1 : 0);
      expect(recordedVersion(installRoot), side).toBe(c.recorded);
      // No staging file is left behind either way.
      expect(
        readdirSync(installRoot).filter((name) => name.endsWith('.tmp')),
      ).toEqual([]);
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});
