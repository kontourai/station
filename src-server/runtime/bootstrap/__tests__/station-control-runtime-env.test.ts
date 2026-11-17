import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { STATION_CONTROL_CALLER_TOKEN_ENV } from '../../../tools/station-control-shared.js';
import { INTERNAL_API_TOKEN_ENV } from '../../../utils/internal-api-token.js';
import {
  builtinStationControlServerPath,
  withStationControlRuntimeEnv,
} from '../station-control-runtime-env.js';

const builtinDefinition = {
  id: 'station-control',
  kind: 'mcp' as const,
  transport: 'stdio' as const,
  command: 'node',
  args: [builtinStationControlServerPath()],
};

const tempDir = trackTempDirs();

describe('withStationControlRuntimeEnv', () => {
  test('#2377 slice D: no child, the built-in included, receives the internal token; only the built-in gets the compile cache', () => {
    const home = tempDir('station-control-runtime-env-');
    vi.stubEnv('STATION_HOME', home);
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', '');
    let stationControl: Record<string, string> | undefined;
    try {
      stationControl = withStationControlRuntimeEnv(
        'station-control',
        builtinDefinition,
        // Even a token the parent environment already held is stripped.
        { STATION_PORT: '4111', [INTERNAL_API_TOKEN_ENV]: 'inherited' },
      );
    } finally {
      vi.unstubAllEnvs();
    }

    // Control: the built-in path still ran (it got the compile cache), so the
    // missing token is not a side effect of skipping the built-in branch.
    expect(stationControl).toEqual({
      STATION_PORT: '4111',
      NODE_COMPILE_CACHE: resolve(home, 'cache', 'node-compile'),
    });
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        { ...builtinDefinition, id: 'third-party' },
        { SAFE: 'value', [INTERNAL_API_TOKEN_ENV]: 'must-not-leak' },
      ),
    ).toEqual({ SAFE: 'value' });
  });

  test('removes inherited tenant authority from every child', () => {
    const inherited = { STATION_INTERNAL_TENANT: 'bravo' };
    for (const [id, definition] of [
      ['station-control', builtinDefinition],
      ['third-party', { ...builtinDefinition, id: 'third-party' }],
    ] as const)
      expect(
        withStationControlRuntimeEnv(id, definition, inherited),
        id,
      ).not.toHaveProperty('STATION_INTERNAL_TENANT');
  });

  test('never passes an inherited stdio caller credential to any child: stdio children are caller-less', () => {
    const inherited = {
      SAFE: 'value',
      [STATION_CONTROL_CALLER_TOKEN_ENV]: 'parent-leak',
    };

    const builtin = withStationControlRuntimeEnv(
      'station-control',
      builtinDefinition,
      inherited,
    );
    // Control: the built-in still received its env, so the strip is not a
    // side effect of dropping the whole env.
    expect(builtin).toMatchObject({ SAFE: 'value' });
    expect(builtin).not.toHaveProperty(STATION_CONTROL_CALLER_TOKEN_ENV);
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        { ...builtinDefinition, id: 'third-party' },
        inherited,
      ),
    ).toEqual({ SAFE: 'value' });
    // The caller's own env object is never mutated.
    expect(inherited[STATION_CONTROL_CALLER_TOKEN_ENV]).toBe('parent-leak');
  });
});
