import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const makeTempDir = trackTempDirs();
const root = resolve(import.meta.dirname, '../..');
const workflowSha = 'a'.repeat(40);

type Step = { name?: string; run?: string; env?: Record<string, string> };
const gallery = load(
  readFileSync(join(root, '.github/workflows/gallery-pr-check.yml'), 'utf8'),
) as { jobs: Record<string, { steps: Step[] }> };
const bootstrap = gallery.jobs['gallery-diff'].steps.find(
  (step) => step.name === 'Install the native build toolchain node-pty needs',
);
if (!bootstrap?.run) throw new Error('Gallery toolchain caller is missing');
const run = bootstrap.run;

function fixture({ poisoned = false, failedFetch = false } = {}) {
  const directory = makeTempDir('ci-ubuntu-source-');
  const bin = join(directory, 'bin');
  const head = join(directory, 'old-head');
  const runnerTemp = join(directory, 'runner-temp');
  mkdirSync(bin);
  mkdirSync(head);
  mkdirSync(runnerTemp);
  const selected = join(directory, 'selected.txt');
  const transport = join(directory, 'transport.txt');
  const staged = join(runnerTemp, 'install-ci-ubuntu-packages.sh');
  const trusted = join(directory, 'trusted-helper.sh');
  writeFileSync(
    trusted,
    '#!/usr/bin/env bash\nprintf "trusted:%s\\n" "$*" > "$BOOTSTRAP_SELECTION_LOG"\n',
  );
  if (poisoned) {
    mkdirSync(join(head, 'scripts'));
    writeFileSync(
      join(head, 'scripts/install-ci-ubuntu-packages.sh'),
      'echo candidate-controlled >&2\nexit 91\n',
    );
  }
  if (failedFetch) writeFileSync(staged, readFileSync(trusted));
  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$BOOTSTRAP_TRANSPORT_LOG"
if [[ "$BOOTSTRAP_FETCH_STATUS" != 0 ]]; then exit "$BOOTSTRAP_FETCH_STATUS"; fi
output=
while [[ "$#" -gt 0 ]]; do
  if [[ "$1" == --output ]]; then output="$2"; shift 2; else shift; fi
done
cp "$BOOTSTRAP_TRUSTED_FIXTURE" "$output"
`,
    { mode: 0o755 },
  );
  const result = spawnSyncBounded(
    'bash',
    ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run],
    {
      cwd: head,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: runnerTemp,
        BOOTSTRAP_SOURCE_REPOSITORY: 'kontourai/station',
        BOOTSTRAP_SOURCE_SHA: workflowSha,
        BOOTSTRAP_SELECTION_LOG: selected,
        BOOTSTRAP_TRANSPORT_LOG: transport,
        BOOTSTRAP_TRUSTED_FIXTURE: trusted,
        BOOTSTRAP_FETCH_STATUS: failedFetch ? '22' : '0',
      },
    },
  );
  return { result, selected, transport, staged };
}

// The workflow callers are Ubuntu Bash jobs; this executes their shell boundary.
describe.skipIf(process.platform === 'win32')(
  'trusted Ubuntu bootstrap source',
  () => {
    it.each([false, true])(
      'uses workflow source when the candidate helper is absent or poisoned (%s)',
      (poisoned) => {
        expect(bootstrap.env).toEqual({
          BOOTSTRAP_SOURCE_REPOSITORY: `\${{ github.repository }}`,
          BOOTSTRAP_SOURCE_SHA: `\${{ github.workflow_sha }}`,
        });
        const { result, selected, transport, staged } = fixture({ poisoned });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(selected, 'utf8')).toBe(
          'trusted:build-essential\n',
        );
        expect(readFileSync(staged, 'utf8')).toContain(
          'BOOTSTRAP_SELECTION_LOG',
        );
        expect(readFileSync(transport, 'utf8').split('\n')).toContain(
          `https://raw.githubusercontent.com/kontourai/station/${workflowSha}/scripts/install-ci-ubuntu-packages.sh`,
        );
      },
    );

    it('refuses a failed helper fetch without executing a previously staged file', () => {
      const { result, selected } = fixture({ failedFetch: true });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(22);
      expect(existsSync(selected)).toBe(false);
    });
  },
);
