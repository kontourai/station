import { describe, expect, test } from 'vitest';
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

describe('withStationControlRuntimeEnv', () => {
  test('injects the process-local credential into the built-in child only', () => {
    const stationControl = withStationControlRuntimeEnv(
      'station-control',
      builtinDefinition,
      { STATION_PORT: '4111' },
    );

    expect(stationControl).toEqual({
      STATION_PORT: '4111',
      [INTERNAL_API_TOKEN_ENV]: expect.any(String),
    });
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        { ...builtinDefinition, id: 'third-party' },
        { SAFE: 'value', [INTERNAL_API_TOKEN_ENV]: 'must-not-leak' },
      ),
    ).toEqual({ SAFE: 'value' });
  });

  test('does not trust a spoofed station-control integration id', () => {
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        { ...builtinDefinition, args: ['/tmp/station-control.js'] },
        {},
      ),
    ).not.toHaveProperty(INTERNAL_API_TOKEN_ENV);
  });

  test('removes inherited tenant authority unless the server supplies context', () => {
    const inherited = { STATION_INTERNAL_TENANT: 'bravo' };

    expect(
      withStationControlRuntimeEnv(
        'station-control',
        builtinDefinition,
        inherited,
      ),
    ).not.toHaveProperty('STATION_INTERNAL_TENANT');
    expect(
      withStationControlRuntimeEnv(
        'station-control',
        builtinDefinition,
        inherited,
        { tenantId: 'alpha' as any, source: 'request' },
      ),
    ).toMatchObject({ STATION_INTERNAL_TENANT: 'alpha' });
    expect(
      withStationControlRuntimeEnv(
        'third-party',
        { ...builtinDefinition, id: 'third-party' },
        inherited,
        { tenantId: 'alpha' as any, source: 'request' },
      ),
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
    // Control: the built-in still received its env and the internal token,
    // so the strip is not a side effect of dropping the whole env.
    expect(builtin).toMatchObject({
      SAFE: 'value',
      [INTERNAL_API_TOKEN_ENV]: expect.any(String),
    });
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
