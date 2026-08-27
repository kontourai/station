import { describe, expect, test } from 'vitest';
import { buildE2EBrowserStorageState } from '../../tests/helpers/e2e-browser-storage-state';

const OPERATOR_CREDENTIAL = 'a'.repeat(43);
const BROWSER_SESSION_CREDENTIAL = 'b'.repeat(43);

describe('E2E browser storage state', () => {
  test('seeds one active saved connection and the disposable credential separately', () => {
    const state = buildE2EBrowserStorageState({
      baseURL: 'http://localhost:5274/nested/path',
      browserSessionCredential: BROWSER_SESSION_CREDENTIAL,
      establishedUser: true,
      operatorCredential: OPERATOR_CREDENTIAL,
      runnerOwned: true,
    });
    const origin = state?.origins[0];
    const values = Object.fromEntries(
      origin?.localStorage.map(({ name, value }) => [name, value]) ?? [],
    );
    const profiles = JSON.parse(values['station-connect-connections'] ?? '[]');
    const credentials = JSON.parse(
      values['station-connect-connections-credentials'] ?? '{}',
    );

    expect(origin?.origin).toBe('http://localhost:5274');
    expect(state?.cookies).toEqual([
      expect.objectContaining({
        name: 'station-device',
        value: BROWSER_SESSION_CREDENTIAL,
        domain: 'localhost',
        httpOnly: true,
        sameSite: 'Strict',
      }),
    ]);
    expect(values['station:onboarding-setup-dismissed']).toBe('1');
    expect(values['station-connect-connections-active']).toBe('e2e-host');
    expect(profiles).toEqual([
      expect.objectContaining({
        profileVersion: 4,
        id: 'e2e-host',
        name: 'Station E2E',
        url: 'http://localhost:5274',
        credentialState: 'saved',
        credentialRef: {
          credentialVersion: 1,
          kind: 'connection',
          id: 'e2e-host',
        },
      }),
    ]);
    expect(JSON.stringify(profiles)).not.toContain(OPERATOR_CREDENTIAL);
    expect(credentials).toEqual({
      'connection:e2e-host': OPERATOR_CREDENTIAL,
    });
  });

  test('authenticates first-run host access without dismissing setup', () => {
    const state = buildE2EBrowserStorageState({
      baseURL: 'http://localhost:5274',
      browserSessionCredential: BROWSER_SESSION_CREDENTIAL,
      establishedUser: false,
      operatorCredential: OPERATOR_CREDENTIAL,
      runnerOwned: true,
    });
    if (!state) throw new Error('runner-owned storage state was not built');
    const values = Object.fromEntries(
      state.origins[0]?.localStorage.map(({ name, value }) => [name, value]) ??
        [],
    );

    expect(values['station:onboarding-setup-dismissed']).toBeUndefined();
    expect(values['station-connect-connections-active']).toBe('e2e-host');
    expect(
      JSON.parse(values['station-connect-connections'] ?? '[]'),
    ).toHaveLength(1);
    expect(
      JSON.parse(values['station-connect-connections-credentials'] ?? '{}'),
    ).toEqual({ 'connection:e2e-host': OPERATOR_CREDENTIAL });
  });

  test.each([
    [true, undefined],
    [true, ''],
    [true, 'not-a-valid-operator-credential'],
    [false, undefined],
    [false, 'not-a-valid-operator-credential'],
  ])(
    'fails closed for established-user=%s credential %s',
    (establishedUser, operatorCredential) => {
      expect(() =>
        buildE2EBrowserStorageState({
          baseURL: 'http://localhost:5274',
          browserSessionCredential: BROWSER_SESSION_CREDENTIAL,
          establishedUser,
          operatorCredential,
          runnerOwned: true,
        }),
      ).toThrow('operator credential is missing or malformed');
    },
  );

  test.each([undefined, '', 'not-a-valid-session-credential'])(
    'fails closed for runner browser session credential %s',
    (browserSessionCredential) => {
      expect(() =>
        buildE2EBrowserStorageState({
          baseURL: 'http://localhost:5274',
          browserSessionCredential,
          establishedUser: true,
          operatorCredential: OPERATOR_CREDENTIAL,
          runnerOwned: true,
        }),
      ).toThrow('browser session credential is missing or malformed');
    },
  );

  test('keeps direct local Playwright config independent of runner credentials', () => {
    expect(
      buildE2EBrowserStorageState({
        baseURL: 'http://localhost:5274',
        establishedUser: false,
        runnerOwned: false,
      }),
    ).toBeUndefined();
  });
});
