import { describe, expect, test } from 'vitest';
import { suiteStationE2EEnv } from '../run-e2e-suite.mjs';

describe('screenshot suite server environment (#875)', () => {
  test('requests native-engine suppression only for the screenshot server', () => {
    expect(suiteStationE2EEnv('screenshot')).toMatchObject({
      STATION_E2E_SYSTEM_STATUS_READY: '1',
      STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION: '1',
    });

    for (const suite of [
      'product',
      'extended',
      'first-run',
      'starter-clean-install',
      'smoke-live',
      'android',
    ]) {
      const env = suiteStationE2EEnv(suite);
      expect(
        Object.keys(env),
        `${suite} must explicitly clear an inherited native-adoption request`,
      ).toContain('STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION');
      expect(env.STATION_E2E_SUPPRESS_NATIVE_ENGINE_ADOPTION).toBeUndefined();
    }
  });
});
