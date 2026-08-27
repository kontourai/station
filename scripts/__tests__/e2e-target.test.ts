import { describe, expect, it } from 'vitest';
import { resolveE2EApiBase } from '../../tests/helpers/e2e-target';

describe('resolveE2EApiBase', () => {
  it('returns the explicitly scoped API origin', () => {
    expect(
      resolveE2EApiBase({
        PW_API_BASE_URL: 'http://localhost:3346/',
        PW_BASE_URL: 'http://localhost:5378',
        STATION_PORT: '3346',
      }),
    ).toBe('http://localhost:3346');
  });

  it('fails closed when no isolated API origin is configured', () => {
    expect(() => resolveE2EApiBase({})).toThrow(/PW_API_BASE_URL is required/);
  });

  it('rejects an API port that differs from the scoped instance', () => {
    expect(() =>
      resolveE2EApiBase({
        PW_API_BASE_URL: 'http://localhost:3141',
        PW_BASE_URL: 'http://localhost:5378',
        STATION_PORT: '3346',
      }),
    ).toThrow(/Refusing to call a different Station instance/);
  });

  it('rejects a cross-host API target', () => {
    expect(() =>
      resolveE2EApiBase({
        PW_API_BASE_URL: 'http://127.0.0.1:3346',
        PW_BASE_URL: 'http://localhost:5378',
        STATION_PORT: '3346',
      }),
    ).toThrow(/Refusing a cross-host E2E target/);
  });
});
