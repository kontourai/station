/**
 * Two Station processes asking for the same expiring credential at once
 * spend its refresh token once: the second waits on the vault's
 * cross-process refresh lock, re-reads inside it, and issues the token the
 * first one stored. Real processes, a real stub issuer over HTTP.
 */
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EngineHostAuthService } from '../service.js';
import { startOidcStub } from './fixtures/oidc-stub.js';

const makeTempDir = trackTempDirs();

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '../../../..');
const SCOPE = {
  connectionId: 'kiro-kas-bundle',
  credentialProfileRef: 'default',
};

const probe = `
import { EngineHostAuthService } from './src-server/services/engine-host-auth/service.ts';
import { REVIEWED_ENGINE_CREDENTIAL_BINDINGS } from './src-server/services/acp/acp-inbound-extension-policy.ts';
const origin = process.env.STUB_ORIGIN;
const service = new EngineHostAuthService({
  homeDir: process.env.STUB_HOME,
  policy: () => 'allowed',
  endpoints: { oidcUrl: (region) => origin + '/oidc/' + region, controlPlaneUrls: () => [] },
});
const binding = REVIEWED_ENGINE_CREDENTIAL_BINDINGS.find((b) => b.id === 'kiro.get-access-token');
const result = await service.issuerFor({ connectionId: 'kiro-kas-bundle', credentialProfileRef: 'default' }).issue(binding);
console.log(JSON.stringify(result.kind === 'issued' ? result.issue.accessToken : 'refused:' + result.reason));
process.exit(0);
`;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

test('two processes refreshing one credential call the issuer once and both issue the refreshed token', async () => {
  const stub = await startOidcStub();
  const home = makeTempDir('engine-host-auth-race-');
  cleanups.push(() => stub.close());
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));

  // Sign in with a token already inside the three-minute refresh margin.
  const service = new EngineHostAuthService({
    homeDir: home,
    policy: () => 'allowed',
    endpoints: stub.endpoints,
    schedule: (work) => {
      const timer = setTimeout(work, 0);
      return () => clearTimeout(timer);
    },
  });
  stub.deviceAnswers.push({
    accessToken: 'access-expiring',
    refreshToken: 'refresh-1',
    expiresIn: 60,
  });
  await service.startLogin(SCOPE, { identity: 'builder-id' });
  await vi.waitFor(() => expect(service.login(SCOPE)?.phase).toBe('completed'));

  // The first refresh is slow, so the second process arrives while it runs.
  stub.refreshAnswers.push(
    {
      accessToken: 'access-refreshed',
      refreshToken: 'refresh-2',
      delayMs: 1500,
    },
    { accessToken: 'access-refreshed-twice', refreshToken: 'refresh-3' },
  );
  const child = () =>
    run(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', probe],
      {
        cwd: ROOT,
        env: { ...process.env, STUB_ORIGIN: stub.origin, STUB_HOME: home },
        timeout: 90_000,
        maxBuffer: 65_536,
        windowsHide: true,
      },
    ).then(({ stdout }) =>
      JSON.parse(stdout.trim().split('\n').at(-1) as string),
    );

  const answers = await Promise.all([child(), child()]);
  expect(answers).toEqual(['access-refreshed', 'access-refreshed']);
  expect(
    stub.requests.filter(
      (request) => request.body.grantType === 'refresh_token',
    ),
  ).toHaveLength(1);
}, 120_000);
