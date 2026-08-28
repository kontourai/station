import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

/**
 * Drives the SARIF policy gate as a real child process so its EXIT STATUS and
 * printed verdicts are proven, not just its pure decision functions — a
 * rejection path that has never executed is unproven (`process.exitCode = 1`
 * only takes effect at process exit).
 */

const POLICY = 'scripts/codeql-sarif-policy.mjs';
const FIXTURES = 'scripts/__tests__/fixtures/codeql-sarif';

const directories: string[] = [];

function temporaryFile(name: string, content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'station-sarif-cli-'));
  directories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, content);
  return path;
}

function runPolicy(args: string[]) {
  const result = spawnSync(process.execPath, [POLICY, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('CodeQL SARIF policy CLI', () => {
  test('exits 0 on the clean fixture and reports the zero verdict', () => {
    const run = runPolicy([`--input=${FIXTURES}/pinned-codeql-clean.sarif`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('0 blocking, 0 baselined, 0 advisory');
  });

  test('exits 1 with the blocked verdict on an unbaselined error result', () => {
    const run = runPolicy([`--input=${FIXTURES}/pinned-codeql-finding.sarif`]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'CodeQL SARIF policy blocked 1 error-level result(s)',
    );
    expect(run.stderr).toContain('js/request-forgery');
  });

  test('bounds the advisory report past the summary cap', () => {
    const document = JSON.parse(
      readFileSync(`${FIXTURES}/pinned-codeql-finding.sarif`, 'utf8'),
    );
    const warning = document.runs[0].results[1];
    document.runs[0].results = Array.from({ length: 25 }, () => warning);
    const input = temporaryFile(
      'many-advisories.sarif',
      `${JSON.stringify(document)}\n`,
    );
    const run = runPolicy([`--input=${input}`]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      'Reported 25 advisory (warning/note) result(s)',
    );
    expect(run.stdout).toContain('… 5 additional result(s) omitted.');
  });

  test('a stale baseline entry exits 1 by default and 0 with a printed warning under warn mode', () => {
    const baseline = temporaryFile(
      'stale-baseline.json',
      JSON.stringify({
        findings: [
          { rule: 'js/gone', path: 'src/removed.ts', lineHash: 'dead:1' },
        ],
      }),
    );
    const args = [
      `--input=${FIXTURES}/pinned-codeql-clean.sarif`,
      `--baseline=${baseline}`,
    ];
    const failing = runPolicy(args);
    expect(failing.status).toBe(1);
    expect(failing.stderr).toContain(
      'no longer matches any error-level result',
    );
    const warned = runPolicy([...args, '--stale-baseline=warn']);
    expect(warned.status).toBe(0);
    expect(warned.stdout).toContain('WARNING: 1 stale baseline entr(ies)');
  });
});
