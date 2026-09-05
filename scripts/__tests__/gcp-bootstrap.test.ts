import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-gcp-swap-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const script = (name: string, body: string) =>
    writeFileSync(join(bin, name), `#!/bin/bash\nset -eu\n${body}\n`, {
      mode: 0o755,
    });
  script(
    'fallocate',
    `printf allocated > "\${@: -1}"
if [ -f "$GCP_SWAP_TEST_ROOT/interrupt" ]; then
  rm "$GCP_SWAP_TEST_ROOT/interrupt"
  kill -KILL "$PPID"
fi`,
  );
  script(
    'mkswap',
    `echo format >> "$GCP_SWAP_TEST_ROOT/formats"
printf swap > "\${@: -1}"`,
  );
  script(
    'blkid',
    `if [ "$(cat "\${@: -1}")" = swap ]; then echo swap; else exit 2; fi`,
  );
  script(
    'swapon',
    `if [ "$1" = --show=NAME ]; then
  if [ -f "$GCP_SWAP_TEST_ROOT/active" ]; then cat "$GCP_SWAP_TEST_ROOT/active"; fi
elif [ "$(cat "$1")" = swap ]; then
  printf '%s\n' "$1" > "$GCP_SWAP_TEST_ROOT/active"
else exit 1
fi`,
  );
  const file = join(root, 'swapfile');
  const run = () =>
    execFileSync(
      'bash',
      [
        '-c',
        'source "$1"; prepare_station_swap "$2"',
        'test',
        resolve('deploy/gcp-dev/bootstrap.sh'),
        file,
      ],
      {
        windowsHide: true,
        timeout: 10000,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          GCP_SWAP_TEST_ROOT: root,
        },
        stdio: 'pipe',
      },
    );
  return { root, file, run };
}

describe.skipIf(process.platform === 'win32')(
  'GCP Linux swap preparation',
  () => {
    test('recovers after interruption between allocation and formatting without publishing a partial final file', () => {
      const { root, file, run } = fixture();
      writeFileSync(join(root, 'interrupt'), 'interrupt');
      expect(run).toThrow();
      expect(existsSync(file)).toBe(false);
      run();
      expect(readFileSync(file, 'utf8')).toBe('swap');
      expect(readFileSync(join(root, 'active'), 'utf8').trim()).toBe(file);
    });
    test('does not reformat or replace active swap', () => {
      const { root, file, run } = fixture();
      run();
      run();
      expect(readFileSync(file, 'utf8')).toBe('swap');
      expect(readFileSync(join(root, 'formats'), 'utf8')).toBe('format\n');
    });
    test('preserves an unknown existing file rather than formatting it', () => {
      const { root, file, run } = fixture();
      writeFileSync(file, 'retain-this');
      expect(run).toThrow();
      expect(readFileSync(file, 'utf8')).toBe('retain-this');
      expect(existsSync(join(root, 'formats'))).toBe(false);
    });
  },
);
