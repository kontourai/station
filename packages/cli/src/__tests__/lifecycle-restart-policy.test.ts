import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import {
  getBoot,
  makeShortHome,
  SUPERVISOR_MAIN,
  startSupervisor,
} from '../../../supervisor/src/__tests__/harness.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('restart refuses an invalid policy before draining the serving generation; a valid policy still hands off', async () => {
  const home = makeShortHome();
  const supervisor = await startSupervisor({
    home,
    instance: 'restart-policy',
  });
  const before = await getBoot(supervisor.port);
  const archive = join(home, 'archive');
  mkdirSync(join(archive, 'dist-server'), { recursive: true });
  writeFileSync(
    join(archive, '.station-prebuilt-archive'),
    'station-prebuilt-archive-v1\n',
  );
  writeFileSync(
    join(archive, '.station-release.json'),
    JSON.stringify({
      schemaVersion: 2,
      sha: 'a'.repeat(40),
      ref: 'v0.0.0',
      createdAt: '2026-11-06T00:00:00.000Z',
      channel: 'stable',
      releaseChannel: 'stable',
      prerelease: false,
    }),
  );
  writeFileSync(
    join(archive, 'dist-server', 'station-supervisor.js'),
    `import(${JSON.stringify(pathToFileURL(SUPERVISOR_MAIN).href)}).catch(error => { console.error(error); process.exit(1); });`,
  );
  vi.spyOn(process, 'cwd').mockReturnValue(archive);
  vi.stubEnv('STATION_HOME', home);
  vi.stubEnv('STATION_ROOT', '');
  const policyPath = join(home, 'policy.json');
  vi.stubEnv('STATION_MANAGED_POLICY_TEST_FILE', policyPath);
  const { getInstanceStatePath } = await import('../commands/helpers.js');
  const statePath = getInstanceStatePath('restart-policy', home);
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dirname(statePath), 0o700);
  writeFileSync(
    statePath,
    JSON.stringify({
      instanceId: 'restart-policy',
      serverPid: supervisor.child.pid,
      uiPid: null,
      serverPort: supervisor.port,
      uiPort: supervisor.port + 4,
      baseDir: home,
      cwd: archive,
      homeSource: '--home',
      startedAt: '2026-11-06T00:00:00.000Z',
      supervised: true,
    }),
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') chmodSync(statePath, 0o600);
  const { restart } = await import('../commands/lifecycle.js');
  writeFileSync(
    policyPath,
    JSON.stringify({ schemaVersion: 99, organization: 'Acme' }),
  );
  await expect(
    restart({ instanceId: 'restart-policy', stateHome: home }),
  ).rejects.toThrow('STATION_MANAGED_POLICY_INVALID');
  expect(await getBoot(supervisor.port)).toMatchObject({
    bootId: before.bootId,
    generation: 1,
  });
  writeFileSync(
    policyPath,
    JSON.stringify({ schemaVersion: 1, organization: 'Acme' }),
  );
  await restart({ instanceId: 'restart-policy', stateHome: home });
  expect(await getBoot(supervisor.port)).toMatchObject({ generation: 2 });
}, 60_000);
