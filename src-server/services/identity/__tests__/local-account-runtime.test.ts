import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type LoadedLocalAccounts,
  loadLocalAccounts,
  readLocalAccountConfiguration,
} from '../local-account-runtime.js';

const roots: string[] = [];
const loaded: LoadedLocalAccounts[] = [];
const publicOrigin = 'http://localhost:4322';
afterEach(async () => {
  for (const account of loaded.splice(0)) await account.service.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe('built-in local account lifetime', () => {
  test('configuration is opt-in, needs no mail settings, and rejects mixed authorities', () => {
    expect(readLocalAccountConfiguration({})).toBeUndefined();
    expect(
      readLocalAccountConfiguration({
        STATION_LOCAL_ACCOUNTS: '1',
        STATION_AUTHENTICATION_ORIGIN: publicOrigin,
      }),
    ).toEqual({ publicOrigin });
    expect(() =>
      readLocalAccountConfiguration({ STATION_LOCAL_ACCOUNTS: 'yes' }),
    ).toThrow();
    expect(() =>
      readLocalAccountConfiguration({
        STATION_LOCAL_ACCOUNTS: '1',
        STATION_AUTHENTICATION_MODULE: '/example.mjs',
        STATION_AUTHENTICATION_ORIGIN: publicOrigin,
      }),
    ).toThrow();
  });

  test('reopening preserves cookies and opaque person identity, while another Station or missing secret is refused', async () => {
    const homeDirectory = await mkdtemp(
      join(tmpdir(), 'station-account-lifetime-'),
    );
    roots.push(homeDirectory);
    const host = { stationId: 'local-accounts-lifetime', homeDirectory };
    const enrollment = { mayRegister: async () => true };
    let account = await loadLocalAccounts({ publicOrigin }, host, enrollment);
    loaded.push(account);
    const post = (
      path: string,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      account.service.handle(
        new Request(`${publicOrigin}/api/account-auth${path}`, {
          method: 'POST',
          headers: {
            Origin: publicOrigin,
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(body),
        }),
        path,
      );
    const registered = await post(
      '/sign-up/username',
      { username: 'local.person', password: 'Lifetime password 12345' },
      { 'x-station-invitation': 'owned-test-invitation' },
    );
    expect(registered.status, await registered.clone().text()).toBe(200);
    const login = await post('/sign-in/username', {
      username: 'local.person',
      password: 'Lifetime password 12345',
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const Cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(Cookie).toContain('session_token=');
    const request = () =>
      new Request(`${publicOrigin}/api/account-auth/session`, {
        headers: { Cookie },
      });
    const before = await account.service.authenticate(request());
    expect(before.kind).toBe('authenticated');
    await account.service.close();
    account = await loadLocalAccounts({ publicOrigin }, host, enrollment);
    loaded.push(account);
    const after = await account.service.authenticate(request());
    expect(after).toEqual(before);
    await account.service.close();
    await expect(
      loadLocalAccounts(
        { publicOrigin },
        { ...host, stationId: 'another-station' },
        enrollment,
      ),
    ).rejects.toThrow('incompatible');
    const db = new DatabaseSync(
      join(homeDirectory, 'authentication', 'local-account-authority.sqlite'),
    );
    db.exec('DELETE FROM local_account_authority');
    db.close();
    await expect(
      loadLocalAccounts({ publicOrigin }, host, enrollment),
    ).rejects.toThrow('missing');
  });
});
