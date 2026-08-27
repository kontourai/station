import { describe, expect, test } from 'vitest';
import { AUTO_ALLOCATE_PORT, resolveRuntimePort } from '../runtime-port.js';

describe('resolveRuntimePort', () => {
  test('uses the default only when PORT is absent or blank', () => {
    expect(resolveRuntimePort(undefined)).toBe(18141);
    expect(resolveRuntimePort('  ')).toBe(18141);
  });

  test('uses the selected runtime channel default when PORT is absent', () => {
    expect(
      resolveRuntimePort(undefined, undefined, { STATION_CHANNEL: 'beta' }),
    ).toBe(28141);
    expect(
      resolveRuntimePort(undefined, undefined, { STATION_CHANNEL: 'nightly' }),
    ).toBe(38141);
  });

  test.each([65533, 65535])(
    'rejects an unsafe context-derived port %i',
    (port) => {
      expect(() =>
        resolveRuntimePort(undefined, undefined, {
          STATION_SERVER_PORT: String(port),
        }),
      ).toThrow(/65532/);
    },
  );

  test('accepts the maximum context-derived port', () => {
    expect(
      resolveRuntimePort(undefined, undefined, {
        STATION_SERVER_PORT: '65532',
      }),
    ).toBe(65532);
  });

  test('accepts a base port whose three derived listeners remain in range', () => {
    expect(resolveRuntimePort('65532')).toBe(65_532);
  });

  test('treats PORT=0 as a self-allocation sentinel', () => {
    expect(resolveRuntimePort('0')).toBe(AUTO_ALLOCATE_PORT);
    expect(resolveRuntimePort(' 0 ')).toBe(AUTO_ALLOCATE_PORT);
  });

  test('treats STATION_PORT_MODE=auto as a self-allocation sentinel', () => {
    expect(resolveRuntimePort(undefined, 'auto')).toBe(AUTO_ALLOCATE_PORT);
    expect(resolveRuntimePort(undefined, ' auto ')).toBe(AUTO_ALLOCATE_PORT);
    // A concrete PORT is ignored once auto mode is requested.
    expect(resolveRuntimePort('3141', 'auto')).toBe(AUTO_ALLOCATE_PORT);
    // A non-auto mode leaves normal resolution intact.
    expect(resolveRuntimePort('3141', 'fixed')).toBe(3141);
  });

  test('still returns explicit in-range ports when auto mode is not requested', () => {
    expect(resolveRuntimePort('3141')).toBe(3141);
    expect(resolveRuntimePort('8080', 'fixed')).toBe(8080);
  });

  test.each(['-1', '65533', '65534', '65535', 'not-a-port', '3141.5'])(
    'rejects unsafe user-supplied PORT=%s',
    (value) => {
      expect(() => resolveRuntimePort(value)).toThrow(
        'PORT must be an integer between 1 and 65532',
      );
    },
  );
});
