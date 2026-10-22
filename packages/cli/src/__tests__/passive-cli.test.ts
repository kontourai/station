import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'station-passive-cli-'));
const rejectCommands = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from 'node:module';
  registerHooks({ load(url, context, next) {
    if (url.endsWith('/packages/cli/src/cli.ts') || url.includes('/src-server/')) {
      throw Error('PASSIVE_COMMAND_GRAPH_LOADED');
    }
    return next(url, context);
  } });
`)}`;

function run(entry: string, args: string[]) {
  return spawnSyncBounded(
    process.execPath,
    ['--import', 'tsx/esm', '--import', rejectCommands, entry, ...args],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        STATION_ROOT: scratch,
        STATION_HOME: join(scratch, 'instances', 'passive'),
        STATION_INSTANCE_ID: 'perf-passive',
        STATION_SERVER_PORT: '38141',
        STATION_UI_PORT: '38000',
      },
    },
  );
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.each(['packages/cli/src/bin.ts', 'scripts/station-cli.ts'])(
  '%s passive startup',
  (entry) => {
    it.each([
      ['--version'],
      ['--help'],
      ['environment', 'access', '--help'],
      ['help', 'stations'],
    ])('answers %j without loading command or server modules', (...args) => {
      const result = run(entry, args);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('station');
      expect(result.stderr).not.toContain('PASSIVE_COMMAND_GRAPH_LOADED');
    });

    it('retains unknown-help failure without loading commands', () => {
      const result = run(entry, ['help', 'unknown-command-sentinel']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Unknown command: unknown-command-sentinel',
      );
      expect(result.stderr).not.toContain('PASSIVE_COMMAND_GRAPH_LOADED');
    });

    it('actually reaches the command graph for a non-passive invocation', () => {
      const result = run(entry, ['stations', '--json']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PASSIVE_COMMAND_GRAPH_LOADED');
    });
  },
);
