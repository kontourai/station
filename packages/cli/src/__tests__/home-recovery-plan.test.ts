import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectStationHomeRecovery } from '@kontourai/station-shared/station-home-recovery-preflight';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from '../cli.js';

const roots: string[] = [];
const originalExit = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  process.exitCode = originalExit;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function homeFixture() {
  const root = fs.realpathSync(
    fs.mkdtempSync(join(tmpdir(), 'station-recovery-cli-')),
  );
  roots.push(root);
  fs.writeFileSync(join(root, '.station-home-schema.json'), '{"version":1}');
  return root;
}
it('runs the real observer through CLI dispatch with no keyring, writes, or process launches', async () => {
  const home = homeFixture();
  const expected = inspectStationHomeRecovery({ homeDir: home });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const configureProfileCredentialStore = vi.fn();
  const forbidden = [
    ...(
      [
        'writeFileSync',
        'mkdirSync',
        'mkdtempSync',
        'renameSync',
        'rmSync',
        'unlinkSync',
        'copyFileSync',
        'cpSync',
        'writeSync',
      ] as const
    ).map((name) =>
      vi.spyOn(fs, name).mockImplementation(() => {
        throw new Error('unexpected filesystem mutation');
      }),
    ),
    ...(
      [
        'spawn',
        'spawnSync',
        'execFile',
        'execFileSync',
        'exec',
        'execSync',
        'fork',
      ] as const
    ).map((name) =>
      vi.spyOn(childProcess, name).mockImplementation(() => {
        throw new Error('unexpected process');
      }),
    ),
  ];
  syncBuiltinESMExports();
  await runCli(['home', 'recovery-plan', `--base=${home}`, '--json'], {
    configureProfileCredentialStore,
  });
  expect(output).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual(expected);
  expect(process.exitCode).toBe(2);
  expect(configureProfileCredentialStore).not.toHaveBeenCalled();
  for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
});

it('explains unopened payloads, non-atomic observation, and absent apply authority in text', async () => {
  const home = homeFixture();
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runCli(['home', 'recovery-plan', `--home=${home}`]);
  const text = output.mock.calls.flat().join('\n');
  expect(text).toContain('no apply is authorized');
  expect(text).toContain('NOT PROVEN');
  expect(text).toContain('non-atomic');
  expect(text).not.toContain(home);
});

it.each(
  [
    [],
    ['--temp-home'],
    ['--base=/unused', '--confirm'],
    ['--base=/unused', '--apply'],
    ['--base=/unused', '--output=/unused'],
    ['--base=/unused', '--home=/unused'],
    ['--base=/unused', '--base=/unused'],
    ['--base='],
    ['--base', '/unused'],
  ].map((args) => ({ args })),
)(
  'rejects non-observational or ambiguous arguments before target/keyring resolution: %j',
  async ({ args }) => {
    const configureProfileCredentialStore = vi.fn();
    const create = vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => {
      throw new Error('must not create a temp home');
    });
    syncBuiltinESMExports();
    await expect(
      runCli(['home', 'recovery-plan', ...args], {
        configureProfileCredentialStore,
      }),
    ).rejects.toThrow('Usage: station home recovery-plan');
    expect(configureProfileCredentialStore).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  },
);

it('lists recovery-plan in command help without inspecting a home', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runCli(['home', '--help']);
  expect(output.mock.calls.flat().join('\n')).toContain(
    'station home recovery-plan',
  );
});
