import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';

const ALIAS = '/tmp/fake-pnpm-alias';
const PRIVATE_OUTPUT =
  'https://fixture-user:fixture-token@example.invalid/private-registry';
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

import { withAuditRetries } from '../dependency-advisory-policy.mjs';
import { runPnpmAudit } from '../lib/pnpm-advisory.mjs';

const makeTempDir = trackTempDirs();

function makeTempAuditRoot(mode: string) {
  const dir = makeTempDir('station-pnpm-audit-');
  cliPath = join(dir, 'pnpm.cjs');
  writeFileSync(
    cliPath,
    `const fs = require('node:fs');
const alias = process.argv0;
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
console.error(${JSON.stringify(PRIVATE_OUTPUT)}.repeat(m === 'valid' ? 512 : 1));
if (m === 'hang') {
  fs.writeFileSync('child-ready', 'ready');
  setInterval(() => {}, 1000);
} else if (m === 'retry') {
  if (!fs.existsSync('first-attempt')) {
    fs.writeFileSync('first-attempt', 'done');
    process.exit(2);
  }
  console.log(JSON.stringify({ advisories: {} }));
  process.exit(1);
}
if (m === 'valid') { console.log(JSON.stringify({ advisories: {}, ok: true })); process.exit(1); }
if (m === 'clean') { console.log(JSON.stringify({ advisories: {} })); process.exit(0); }
if (m === 'malformed') { console.log('not-json{{{'); process.exit(0); }
if (m !== 'hang') process.exit(2);
`,
  );
  return dir;
}

function receipts(root: string, kind: 'started' | 'terminal') {
  const receiptsPath = '.kontourai/verification-output/dependency-audit';
  return readdirSync(join(root, receiptsPath))
    .filter((name) => name.endsWith(`.${kind}.json`))
    .map((name) => {
      const text = readFileSync(join(root, receiptsPath, name), 'utf8');
      expect(Buffer.byteLength(text)).toBeLessThan(16 * 1024);
      expect(text).not.toMatch(/fixture-token|example\.invalid/);
      expect(text).not.toContain(root);
      return JSON.parse(text);
    });
}

describe('runPnpmAudit owned launch', () => {
  it('forwards argv0 alias and accepts audit exit 1 JSON', async () => {
    const root = makeTempAuditRoot('valid');

    await expect(runPnpmAudit(root)).resolves.toEqual({
      advisories: {},
      ok: true,
    });
    const [started] = receipts(root, 'started');
    const [terminal] = receipts(root, 'terminal');
    expect(started).toMatchObject({
      packageManager: 'pnpm',
      scope: 'workspace',
      attempt: 1,
      timeoutMs: 240_000,
      state: 'started',
      complete: false,
    });
    expect(terminal).toMatchObject({
      id: started.id,
      state: 'settled',
      complete: true,
      status: 1,
      outcome: 'response-decoded',
      failurePhases: [],
    });
  }, 15_000);

  it('accepts a clean exit-zero audit response', async () => {
    const root = makeTempAuditRoot('clean');
    await expect(runPnpmAudit(root)).resolves.toEqual({ advisories: {} });
  }, 15_000);

  it('preserves a decoded response when the diagnostic directory is unavailable', async () => {
    const root = makeTempAuditRoot('clean');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        runPnpmAudit(root, { diagnosticsRoot: join(root, 'pnpm.cjs') }),
      ).resolves.toEqual({ advisories: {} });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Dependency audit diagnostics unavailable; audit verdict is unchanged',
      );
    } finally {
      warn.mockRestore();
    }
  }, 15_000);

  it('refuses operational exit codes', async () => {
    const root = makeTempAuditRoot('operational');

    await expect(runPnpmAudit(root)).rejects.toThrow(/operational failure/);
    expect(receipts(root, 'terminal')).toMatchObject([
      {
        status: 2,
        outcome: 'operational-failure',
        failurePhases: ['process'],
      },
    ]);
  }, 15_000);

  it('refuses malformed JSON', async () => {
    const root = makeTempAuditRoot('malformed');

    await expect(runPnpmAudit(root)).rejects.toThrow(/valid JSON/);
    expect(receipts(root, 'terminal')).toMatchObject([
      {
        status: 0,
        outcome: 'operational-failure',
        failurePhases: ['decode'],
      },
    ]);
  }, 15_000);

  it('keeps each retry separate and accepts the decoded exit-one response', async () => {
    const root = makeTempAuditRoot('retry');
    await expect(
      withAuditRetries('pnpm workspace', (attempt: number) =>
        runPnpmAudit(root, { attempt }),
      ),
    ).resolves.toEqual({ advisories: {} });
    const terminals = receipts(root, 'terminal').sort(
      (a, b) => a.attempt - b.attempt,
    );
    expect(terminals).toMatchObject([
      {
        attempt: 1,
        outcome: 'operational-failure',
        failurePhases: ['process'],
      },
      { attempt: 2, outcome: 'response-decoded', failurePhases: [] },
    ]);
    expect(new Set(terminals.map((receipt) => receipt.id)).size).toBe(2);
  }, 15_000);

  it('records deadline expiry and settles the owned fixture child', async () => {
    const root = makeTempAuditRoot('hang');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = runPnpmAudit(root).catch((error: unknown) => error);
    try {
      const started = Date.now();
      while (
        !existsSync(join(root, 'child-ready')) &&
        Date.now() - started < 7_500
      )
        await sleep(25);
      expect(existsSync(join(root, 'child-ready'))).toBe(true);
      vi.advanceTimersByTime(239_999);
      expect(receipts(root, 'terminal')).toHaveLength(0);
    } finally {
      vi.advanceTimersByTime(240_000);
      vi.useRealTimers();
      await outcome;
    }
    expect(await outcome).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/240000ms deadline/),
      }),
    );
    expect(receipts(root, 'terminal')).toMatchObject([
      {
        complete: true,
        outcome: 'operational-failure',
        failurePhases: ['deadline'],
      },
    ]);
  }, 20_000);
});
