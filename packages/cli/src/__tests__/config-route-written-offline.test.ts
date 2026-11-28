/**
 * `station config set --offline` refuses the settings that have their own
 * route (`ROUTE_WRITTEN_APP_CONFIG_KEYS`): their rules (a first run that
 * only moves forward, a default for new chats recorded once) would otherwise
 * be skipped, and a malformed value would stop the home from loading. Runs the
 * real CLI as a child process against a temp home and reads the file back.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATION_HOME_SCHEMA_VERSION } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const makeTempDir = trackTempDirs();

function fixture() {
  const root = makeTempDir('station-route-written-offline-');
  const home = join(root, 'home');
  mkdirSync(join(home, 'config'), { recursive: true });
  writeFileSync(
    join(home, '.station-home-schema.json'),
    JSON.stringify({ version: STATION_HOME_SCHEMA_VERSION }),
  );
  const appPath = join(home, 'config', 'app.json');
  const before = JSON.stringify(
    {
      defaultMaxTurns: 7,
      firstRun: { status: 'pending' },
      newChatDefault: { agent: 'codex', reason: 'first-signed-in' },
    },
    null,
    2,
  );
  writeFileSync(appPath, before);
  const run = (...args: string[]) => {
    const result = spawnSyncBounded(
      process.execPath,
      ['--import', 'tsx', join(repoRoot, 'scripts/station-cli.ts'), ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60_000,
        killSignal: 'SIGKILL',
        env: {
          ...process.env,
          STATION_HOME: home,
          STATION_ROOT: join(root, 'station-root'),
          // Offline: nothing may answer here.
          STATION_PORT: '9',
        },
      },
    );
    return {
      status: result.status,
      output: `${String(result.stdout)}${String(result.stderr)}`,
    };
  };
  return { run, before, stored: () => readFileSync(appPath, 'utf8') };
}

describe('station config set --offline and route-written settings', () => {
  test.each([
    ['newChatDefault', '"just-a-string"', 'POST /config/new-chat-default'],
    [
      'newChatDefault',
      '{"agent":"claude","reason":"first-signed-in"}',
      'POST /config/new-chat-default',
    ],
    ['firstRun', '{"status":"pending"}', 'POST /config/first-run'],
  ])(
    '%s %s is refused, naming its route, and the file is unchanged',
    (key, value, route) => {
      const home = fixture();
      const result = home.run('config', 'set', key, value, '--offline');
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(route);
      expect(home.stored()).toBe(home.before);
    },
  );

  test('control: an ordinary setting is still written offline', () => {
    const home = fixture();
    const result = home.run(
      'config',
      'set',
      'defaultMaxTurns',
      '9',
      '--offline',
    );
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(home.stored()).defaultMaxTurns).toBe(9);
  });
});
