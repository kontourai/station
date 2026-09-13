import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test.each(['SIGINT', 'SIGTERM'])(
  'the real framework cannot exit before Station drains on %s',
  (signal) => {
    const module = fileURLToPath(
      new URL('../runtime-signal-ownership.ts', import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
    import { VoltAgent } from '@voltagent/core';
    import { withStationShutdownOwnership } from ${JSON.stringify(module)};
    const timer = setTimeout(() => process.exit(3), 10000);
    const station = async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      await framework.shutdown();
      console.log('STATION_SERVICES_DRAINED');
      clearTimeout(timer);
      process.exit(0);
    };
    process.on(${JSON.stringify(signal)}, station);
    const framework = withStationShutdownOwnership(() => new VoltAgent({ agents: {} }));
    await framework.ready;
    if (process.listeners(${JSON.stringify(signal)}).length !== 1 || process.listeners(${JSON.stringify(signal)})[0] !== station) process.exit(2);
    process.emit(${JSON.stringify(signal)});
  `,
      ],
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain('STATION_SERVICES_DRAINED');
  },
  20000,
);
