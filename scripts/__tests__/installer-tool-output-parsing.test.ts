/**
 * Regression guard for #984.
 *
 * npm exports `FORCE_COLOR=3` into every script it runs, so anything a Station
 * script spawns inherits "colour is on" even when its stdout is a pipe being
 * parsed rather than a terminal being read. `node -p` prints strings verbatim
 * but renders every other result through `util.inspect`, which honours that
 * variable — so the dogfood installer's `node -p 'Number(...)'` major-version
 * probe returned `"\e[33m24\e[39m"` and the installer failed its own
 * validity guard with "node returned an invalid major version: 24".
 *
 * That single variable had already produced a second silent failure (the e2e
 * tally parse fixed in #981), and both survived for months because the symptom
 * reads as environmental. So this guard executes the *real* installer line —
 * extracted from `ops/dogfood/install-macos.zsh`, never a copy that could drift
 * out of step with it — under `FORCE_COLOR=3`, and asserts the parse still
 * yields a bare integer.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALLER_PATH = path.join(REPO_ROOT, 'ops/dogfood/install-macos.zsh');
const SUBPROCESS_TIMEOUT_MS = 15_000;
const ESCAPE = '\u001B';
const ANY_ESCAPE = new RegExp(ESCAPE);
const SGR_ESCAPE = new RegExp(`${ESCAPE}\\[\\d+m`);

/** The installer line that captures the Node major version, verbatim. */
function nodeMajorAssignment(installer: string): string {
  const line = installer
    .split('\n')
    .find((candidate) => candidate.startsWith('NODE_MAJOR="$('));
  expect(
    line,
    'install-macos.zsh no longer assigns NODE_MAJOR from a command substitution — update this guard alongside it',
  ).toBeDefined();
  return line as string;
}

/**
 * Pull the capture and its validity check straight out of the installer, so the
 * guard can never pass against a fixed copy while the shipped script regresses.
 */
function extractNodeMajorPreflight(installer: string): string {
  const lines = installer.split('\n');
  const assignment = lines.indexOf(nodeMajorAssignment(installer));
  const validity = lines[assignment + 1];
  expect(
    validity,
    'the NODE_MAJOR validity guard must directly follow its assignment',
  ).toContain('"$NODE_MAJOR" == <->');
  return `${lines[assignment]}\n${validity}`;
}

describe('installer tool-output parsing survives inherited colour', () => {
  it.skipIf(process.platform !== 'darwin')(
    'reads the Node major version as data, not as a rendered value, under FORCE_COLOR=3',
    () => {
      const preflight = extractNodeMajorPreflight(
        readFileSync(INSTALLER_PATH, 'utf8'),
      );
      const script = [
        'set -euo pipefail',
        'fail() { print -u2 "PREFLIGHT-FAILED: $1"; exit 1; }',
        preflight,
        'print -rn -- "$NODE_MAJOR"',
      ].join('\n');

      const result = spawnSync('/bin/zsh', ['-c', script], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        env: {
          ...process.env,
          NODE: process.execPath,
          // The whole point: reproduce what npm hands every script it runs.
          FORCE_COLOR: '3',
        },
      });

      const diagnostic = [result.error?.message, result.stderr]
        .filter(Boolean)
        .join('\n');
      expect(result.status, diagnostic).toBe(0);
      expect(result.stdout, diagnostic).not.toMatch(ANY_ESCAPE);
      expect(result.stdout).toMatch(/^\d+$/);
      expect(result.stdout).toBe(process.versions.node.split('.')[0]);
    },
  );

  it('keeps the version probe off the colourising `node -p` rendering path', () => {
    const assignment = nodeMajorAssignment(
      readFileSync(INSTALLER_PATH, 'utf8'),
    );
    expect(assignment).toContain('process.stdout.write');
    expect(assignment).not.toContain(' -p ');
  });

  it('proves the trap is still live, so the guard above cannot pass vacuously', () => {
    const result = spawnSync(
      process.execPath,
      ['-p', 'Number(process.versions.node.split(".")[0])'],
      {
        encoding: 'utf8',
        timeout: SUBPROCESS_TIMEOUT_MS,
        env: { ...process.env, FORCE_COLOR: '3' },
      },
    );
    expect(result.status).toBe(0);
    // If this ever fails, `node -p` stopped colourising numeric results. The
    // fix above remains correct either way; retire this control rather than
    // treating it as a defect.
    expect(result.stdout).toMatch(SGR_ESCAPE);
    expect(result.stdout.trim()).not.toMatch(/^\d+$/);
  });
});
