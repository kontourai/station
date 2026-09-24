import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ALIAS = '/tmp/fake-pnpm-alias';
let cliPath = '';

vi.mock('../dependency-lifecycle.mjs', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../dependency-lifecycle.mjs')>();
  return {
    ...actual,
    pnpmInvocation: () => ({
      command: process.execPath,
      args: [cliPath],
      argv0: ALIAS,
    }),
  };
});

import { runPnpmAudit } from '../lib/pnpm-advisory.mjs';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function writeCli(mode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'station-pnpm-audit-'));
  temporary.push(dir);
  cliPath = join(dir, 'pnpm.cjs');
  writeFileSync(
    cliPath,
    `const alias = process.argv0;
const args = process.argv.slice(2);
if (alias !== ${JSON.stringify(ALIAS)}) {
  console.error('argv0 mismatch: ' + alias);
  process.exit(3);
}
if (JSON.stringify(args) !== JSON.stringify(['audit', '--json'])) {
  console.error('args mismatch: ' + args.join(' '));
  process.exit(3);
}
const m = ${JSON.stringify(mode)};
if (m === 'valid') { console.log(JSON.stringify({ advisories: {}, ok: true })); process.exit(1); }
if (m === 'clean') { console.log(JSON.stringify({ advisories: {} })); process.exit(0); }
if (m === 'malformed') { console.log('not-json{{{'); process.exit(0); }
process.exit(2);
`,
  );
}

describe('runPnpmAudit owned launch', () => {
  it('forwards argv0 alias and accepts audit exit 1 JSON', async () => {
    writeCli('valid');

    await expect(runPnpmAudit(tmpdir())).resolves.toEqual({
      advisories: {},
      ok: true,
    });
  }, 15_000);

  it('accepts a clean exit-zero audit response', async () => {
    writeCli('clean');
    await expect(runPnpmAudit(tmpdir())).resolves.toEqual({ advisories: {} });
  }, 15_000);

  it('refuses operational exit codes', async () => {
    writeCli('operational');

    await expect(runPnpmAudit(tmpdir())).rejects.toThrow(/operational failure/);
  }, 15_000);

  it('refuses malformed JSON', async () => {
    writeCli('malformed');

    await expect(runPnpmAudit(tmpdir())).rejects.toThrow(/valid JSON/);
  }, 15_000);
});
