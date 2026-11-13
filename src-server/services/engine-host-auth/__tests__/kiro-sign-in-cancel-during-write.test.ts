/**
 * A connection removed while its sign-in's credential is being written: the
 * credential is taken back out, and the attempt neither completes nor reports
 * a sign-in. The vault's write is held open so the removal lands inside it.
 * Both flows (device code, and Google/GitHub) against local stubs.
 */
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { KIRO_CREDENTIAL_KIND, KiroSignIn } from '../kiro-oidc/kiro-sign-in.js';
import { EngineHostAuthVault } from '../vault.js';
import { startOidcStub } from './fixtures/oidc-stub.js';
import { SOCIAL_PROFILE_ARN, startSocialStub } from './fixtures/social-stub.js';

const makeTempDir = trackTempDirs();
const SCOPE = {
  connectionId: 'kiro-kas-bundle',
  credentialProfileRef: 'default',
};
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A real vault whose write waits until the test releases it. */
function gatedVault() {
  const home = makeTempDir('kiro-cancel-write-');
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const vault = new EngineHostAuthVault(home);
  const write = vault.write.bind(vault);
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let landed!: () => void;
  const written = new Promise<void>((resolve) => {
    landed = resolve;
  });
  vault.write = async (...args: Parameters<typeof write>) => {
    entered();
    await gate;
    await write(...args);
    landed();
  };
  return { vault, writing, release, written };
}

async function signInWith(
  deps: Partial<ConstructorParameters<typeof KiroSignIn>[0]> &
    Pick<ConstructorParameters<typeof KiroSignIn>[0], 'vault' | 'endpoints'>,
) {
  const onSignedIn = vi.fn();
  const signIn = new KiroSignIn({
    fetch: globalThis.fetch.bind(globalThis),
    now: Date.now,
    schedule: (run) => {
      const timer = setTimeout(run, 0);
      return () => clearTimeout(timer);
    },
    onSignedIn,
    ...deps,
  });
  return { signIn, onSignedIn };
}

describe('a connection removed while its credential is being written', () => {
  test('device-code flow: nothing kept, not completed, no sign-in reported', async () => {
    const oidc = await startOidcStub();
    cleanups.push(() => oidc.close());
    oidc.deviceAnswers.push({
      accessToken: 'device-access',
      refreshToken: 'r',
    });
    const { vault, writing, release, written } = gatedVault();
    const { signIn, onSignedIn } = await signInWith({
      vault,
      endpoints: oidc.endpoints,
    });
    await signIn.start(SCOPE, { identity: 'builder-id' });
    await writing;
    signIn.forget(SCOPE.connectionId);
    release();
    // The credential did land; it must then be taken back out.
    await written;
    await vi.waitFor(() =>
      expect(vault.read(KIRO_CREDENTIAL_KIND, SCOPE)).toBeUndefined(),
    );
    // forget() drops the record, so there is none to re-read: reaching
    // `completed` is the same synchronous step as calling onSignedIn.
    expect(signIn.attempt(SCOPE)).toBeUndefined();
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('a newer credential written between the check and the removal is kept', async () => {
    const oidc = await startOidcStub();
    cleanups.push(() => oidc.close());
    oidc.deviceAnswers.push({ accessToken: 'stale-access', refreshToken: 'r' });
    const { vault, writing, release, written } = gatedVault();
    // Another sign-in lands just before any removal this attempt makes.
    const newer = {
      identity: { kind: 'builder-id' as const, region: 'us-east-1' },
      accessToken: 'newer-access',
      refreshToken: 'newer-refresh',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      signedInAt: new Date().toISOString(),
    };
    const realWrite = EngineHostAuthVault.prototype.write.bind(vault);
    const landNewer = () => realWrite(KIRO_CREDENTIAL_KIND, SCOPE, newer);
    let removalReturned!: () => void;
    const removal = new Promise<void>((resolve) => {
      removalReturned = resolve;
    });
    const compareAndRemove = vault.compareAndRemove.bind(vault);
    vault.compareAndRemove = async (...args) => {
      await landNewer();
      const removed = await compareAndRemove(...args);
      removalReturned();
      return removed;
    };
    const remove = vault.remove.bind(vault);
    vault.remove = async (...args) => {
      await landNewer();
      await remove(...args);
      removalReturned();
    };
    const { signIn, onSignedIn } = await signInWith({
      vault,
      endpoints: oidc.endpoints,
    });
    await signIn.start(SCOPE, { identity: 'builder-id' });
    await writing;
    signIn.forget(SCOPE.connectionId);
    release();
    await written;
    await removal;
    expect(
      vault.read(KIRO_CREDENTIAL_KIND, SCOPE)?.credential.accessToken,
    ).toBe('newer-access');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  test('Google/GitHub flow: nothing kept, not completed, no sign-in reported', async () => {
    const social = await startSocialStub();
    cleanups.push(() => social.close());
    social.exchangeAnswers.push({
      accessToken: 'social-access',
      refreshToken: 'r',
      profileArn: SOCIAL_PROFILE_ARN,
    });
    const oidc = await startOidcStub();
    cleanups.push(() => oidc.close());
    const { vault, writing, release, written } = gatedVault();
    const { signIn, onSignedIn } = await signInWith({
      vault,
      endpoints: oidc.endpoints,
      social: social.endpoints,
      socialCallbackPorts: [await freePort()],
    });
    const started = await signIn.start(SCOPE, { identity: 'social' });
    const link = new URL(started.authorizationUrl ?? '');
    const port = new URL(link.searchParams.get('redirect_uri') ?? '').port;
    await fetch(link);
    await fetch(
      `http://127.0.0.1:${port}/oauth/callback?login_option=google&code=c&state=${link.searchParams.get('state')}`,
    );
    await writing;
    signIn.forget(SCOPE.connectionId);
    release();
    // The credential did land; it must then be taken back out.
    await written;
    await vi.waitFor(() =>
      expect(vault.read(KIRO_CREDENTIAL_KIND, SCOPE)).toBeUndefined(),
    );
    expect(signIn.attempt(SCOPE)).toBeUndefined();
    expect(onSignedIn).not.toHaveBeenCalled();
  });
});
