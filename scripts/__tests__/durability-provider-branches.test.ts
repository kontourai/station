import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { findDurabilityProviderBranches } from '../check-durability-provider-branches.mjs';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';

const gate = fileURLToPath(
  new URL('../check-durability-provider-branches.mjs', import.meta.url),
);
const makeTempDir = trackTempDirs();

test('detects provider comparisons, aliases, membership and switches in durability decisions', () => {
  const source = `
    function steer(adapter) { const p = adapter.provider; if (p === 'claude') return true; }
    function recover(provider) { return ['codex', 'claude'].includes(provider); }
    function cancel(provider) { switch (provider) { case 'acp': return true; } }
    function execute(provider) { if (provider === 'muse') return resumeTurn(); }
    function resume(engine) { return engine === PROVIDER_CODEX; }
    function cancelAgain(adapter) { const p = adapter['provider']; return Object.is(p, 'claude'); }
    function executeSwitch(provider) { switch (provider) { case 'codex': return resumeTurn(); } }
    function history(engineId) { return (engineId) === 'station'; }
  `;
  expect(
    findDurabilityProviderBranches(source).map(
      (item: { expression: string }) => item.expression,
    ),
  ).toEqual([
    "p === 'claude'",
    "['codex', 'claude'].includes(provider)",
    "case 'acp': return true;",
    "provider === 'muse'",
    'engine === PROVIDER_CODEX',
    "Object.is(p, 'claude')",
    "case 'codex': return resumeTurn();",
    "(engineId) === 'station'",
  ]);
});

test('ignores protocol-only branches, profile reads and comment text', () => {
  const source = `
    function questionnaire(provider) { if (provider === 'claude') return 'format'; }
    function credentialRecovery(provider) { if (provider === 'codex') return 'login'; }
    function plain(provider) { if (provider === 'muse') return 1; /* steer */ }
    function steer(adapter) { return adapter.metadata.durability.steerPlacement.state === 'native'; }
  `;
  expect(findDurabilityProviderBranches(source)).toEqual([]);
});

test('the executable gate rejects a durability decision even if committed into its baseline', () => {
  const root = makeTempDir('station-durability-branch-');
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, windowsHide: true });
  git(['init', '-q']);
  mkdirSync(join(root, 'src-server'), { recursive: true });
  const file = join(root, 'src-server', 'service.ts');
  const old =
    "function questionnaire(provider: string) { return provider === 'claude'; }\n";
  writeFileSync(file, old);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  const run = () =>
    spawnSyncBounded(process.execPath, [gate], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, STATION_CI_FAST_BASE: 'HEAD' },
    });
  writeFileSync(file, `${old}export const marker = 1;\n`);
  expect(run().status).toBe(0);
  writeFileSync(
    file,
    `${old}function steer(provider: string) { return provider === 'codex'; }\n`,
  );
  const bad = run();
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("provider === 'codex'");
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'bad baseline',
  ]);
  expect(run().status).toBe(1);
});
