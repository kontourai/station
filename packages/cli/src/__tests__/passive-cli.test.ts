import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncBounded } from '../../../../scripts/lib/bounded-capture.mjs';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';

const makeTempDir = trackTempDirs({ lifetime: 'file' });
const scratch = makeTempDir('station-passive-cli-');
const rejectCommands = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from 'node:module';
  registerHooks({ load(url, context, next) {
    if (url.endsWith('/packages/cli/src/cli.ts') || url.includes('/src-server/')) {
      throw Error('PASSIVE_COMMAND_GRAPH_LOADED');
    }
    return next(url, context);
  } });
`)}`;

function run(entry: string, args: string[], hook = rejectCommands) {
  return spawnSyncBounded(
    process.execPath,
    ['--import', 'tsx/esm', '--import', hook, entry, ...args],
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

    it('lists Stations without initializing the pairing QR encoder', () => {
      const rejectQr = `data:text/javascript,${encodeURIComponent(`
        import { registerHooks } from 'node:module';
        registerHooks({ load(url, context, next) {
          if (url.includes('/qrcode/')) throw Error('QR_ENCODER_LOADED');
          return next(url, context);
        } });
      `)}`;
      const result = run(entry, ['stations', 'list'], rejectQr);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('No Stations saved.');
      expect(result.stderr).not.toContain('QR_ENCODER_LOADED');
    });

    it('actually reaches the command graph for a non-passive invocation', () => {
      const result = run(entry, ['stations', '--json']);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PASSIVE_COMMAND_GRAPH_LOADED');
    });
  },
);
