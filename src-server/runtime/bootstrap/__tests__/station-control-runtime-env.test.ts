import { describe, expect, test } from 'vitest';
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
});
