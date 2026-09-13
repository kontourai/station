import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import type { AccountSessionView } from '@kontourai/station-sdk/account-authentication';
import { createProject } from '@kontourai/station-sdk/client';
import {
  changeLocalAccount,
  getLocalAccounts,
} from '@kontourai/station-sdk/local-accounts';
import {
  changeProjectAccess,
  getProjectAccess,
} from '@kontourai/station-sdk/project-access-client';
import { type Browser, chromium, type Page } from '@playwright/test';
import { build, stop as stopBundler } from 'esbuild';
import {
  accountLabDeniedRead,
  accountLabOperation,
  accountLabReadableSessionCookie,
} from './local-collaboration-account-page.mjs';
import {
  acquireAccountLabPorts,
  startAccountLabStation,
} from './local-collaboration-station.js';

type Station = Awaited<ReturnType<typeof startAccountLabStation>>;
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}
async function readDevices(station: Station) {
  const response = await fetch(`${station.base}/api/pairing/devices`, {
    headers: { Authorization: `Bearer ${station.operator.credential}` },
    redirect: 'error',
    signal: AbortSignal.any([
      station.operator.signal,
      AbortSignal.timeout(15000),
    ]),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { devices?: unknown };
  assert(
    Array.isArray(body.devices),
    'The real pairing response must contain a devices array',
  );
  return body.devices;
}
async function enable(station: Station, name: string) {
  const project = await createProject(
    station.base,
    { name, slug: 'shared-example' },
    station.operator,
  );
  assert(typeof project.id === 'string');
  const enabled = await changeProjectAccess(
    station.base,
    project.slug,
    { kind: 'enable', localProjectId: project.id },
    station.operator,
  );
  assert.equal(enabled.kind, 'enabled');
  if (enabled.kind !== 'enabled')
    throw new Error('Project sharing was not enabled');
  assert.equal(enabled.view.scope.stationId, station.stationId);
  return enabled.view.scope;
}
async function invite(
  station: Station,
  scope: ProjectMembershipScope,
  role: 'viewer' | 'contributor' = 'viewer',
) {
  const result = await changeProjectAccess(
    station.base,
    scope.localProjectSlug,
    {
      kind: 'invite',
      scope,
      email: null,
      role,
      expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    station.operator,
  );
  if (result.kind !== 'invited')
    throw new Error('The invitation was not created');
  return result;
}
function account(
  page: Page,
  path: string,
  body: Record<string, unknown>,
  invitation?: string,
) {
  return page.evaluate(accountLabOperation, {
    operation: 'request',
    path,
    body,
    invitation,
  });
}
async function session(page: Page): Promise<AccountSessionView | null> {
  return page.evaluate(accountLabOperation, { operation: 'session' });
}
async function denyPrivateAccess(page: Page, privateName: string) {
  for (const path of [
    '/api/projects',
    '/api/projects/shared-example',
    '/api/projects/shared-example/access',
    '/api/operator/accounts',
  ]) {
    const result = await page.evaluate(accountLabDeniedRead, path);
    assert.equal(result.status, 401);
    assert.equal(result.body.includes(privateName), false);
  }
  assert.equal(await page.evaluate(accountLabReadableSessionCookie), false);
}

/** Real Station processes and provider/member APIs, with synthetic local users. */
export async function checkLocalCollaborationAccounts(
  root: string,
  parentSignal: AbortSignal,
) {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(180000)]);
  const nonce = randomBytes(32).toString('hex');
  let permittedHits = 0;
  let forbiddenHits = 0;
  const permitted = createServer((_request, response) => {
    permittedHits++;
    response.end(nonce);
  });
  const forbidden = createServer((_request, response) => {
    forbiddenHits++;
    response.end('unexpected lab TCP request');
  });
  const stations: Station[] = [];
  const ports: number[] = [];
  const processes: number[] = [];
  const bootIds: string[] = [];
  let browser: Browser | undefined;
  let closingBrowser: Promise<void> | undefined;
  const closeBrowser = () => {
    if (!browser) return Promise.resolve();
    closingBrowser ??= browser.close();
    return closingBrowser;
  };
  // The same promise is checked by finally when abort interrupts SDK calls.
  const abortBrowser = () => {
    void closeBrowser().catch(() => {});
  };
  const checks: string[] = [];
  let outcome: { stationIds: string[]; principals: string[] } | undefined;
  const errors: unknown[] = [];
  const unlock = await acquireAccountLabPorts();
  try {
    signal.throwIfAborted();
    browser = await chromium.launch({ headless: true });
    signal.addEventListener('abort', abortBrowser, { once: true });
    signal.throwIfAborted();
    const allowedProbePort = await listen(permitted);
    const blockedProbePort = await listen(forbidden);
    ports.push(allowedProbePort, blockedProbePort);
    const common = { allowedProbePort, blockedProbePort, probeNonce: nonce };
    const start = async (
      name: string,
      hostname: '127.0.0.1' | 'localhost',
      port?: number,
    ) => {
      const station = await startAccountLabStation(
        { ...common, directory: join(root, name), name, hostname, port },
        signal,
      );
      stations.push(station);
      assert(station.pid);
      processes.push(station.pid);
      bootIds.push(station.bootId);
      if (!port)
        ports.push(
          ...Array.from({ length: 4 }, (_, offset) => station.port + offset),
        );
      return station;
    };
    let a = await start('account-station-a', '127.0.0.1');
    const b = await start('account-station-b', 'localhost');
    assert.notEqual(a.stationId, b.stationId);
    const secretA = `Private A ${randomBytes(12).toString('hex')}`;
    const secretB = `Private B ${randomBytes(12).toString('hex')}`;
    const scopeA = await enable(a, secretA);
    const scopeB = await enable(b, secretB);
    const devicesBefore = await readDevices(a);
    assert.deepEqual(devicesBefore, []);
    const bundled = await build({
      stdin: {
        contents:
          "import {getAccountAuthentication,getAccountSession,runAccountOperation} from '@kontourai/station-sdk/account-authentication';window.stationAccountLab={getAccountAuthentication,getAccountSession,runAccountOperation};",
        resolveDir: resolve(import.meta.dirname, '../..'),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
    });
    assert.equal(bundled.outputFiles.length, 1);
    const script = bundled.outputFiles[0].text;
    stopBundler();
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const open = async (context: typeof firstContext, station: Station) => {
      const page = await context.newPage();
      await page.goto(`${station.base}/api/account-auth`);
      await page.evaluate(script);
      return page;
    };
    const first = await open(firstContext, a);
    const second = await open(secondContext, a);
    const descriptor = await first.evaluate(accountLabOperation, {
      operation: 'descriptor',
    });
    assert.equal(descriptor.login.kind, 'username-password');
    assert.equal(await session(first), null);
    const firstUser = {
      username: 'lab.viewer',
      password: `Lab-${randomBytes(20).toString('hex')}-Aa1!`,
    };
    const secondUser = {
      username: 'lab.contributor',
      password: `Lab-${randomBytes(20).toString('hex')}-Aa1!`,
    };
    assert.equal(
      (await account(first, descriptor.login.signUpPath, firstUser)).status,
      403,
    );
    const firstInvite = await invite(a, scopeA);
    const secondInvite = await invite(a, scopeA, 'contributor');
    for (const [page, user, invitation] of [
      [first, firstUser, firstInvite],
      [second, secondUser, secondInvite],
    ] as const) {
      assert.equal(
        (
          await account(
            page,
            descriptor.login.signUpPath,
            user,
            invitation.token,
          )
        ).status,
        200,
      );
      assert.equal(await session(page), null);
      assert.equal(
        (await account(page, descriptor.login.signInPath, user)).status,
        200,
      );
    }
    const firstSession = await session(first);
    const secondSession = await session(second);
    assert(firstSession && secondSession);
    assert.notEqual(firstSession.principal.id, secondSession.principal.id);
    assert.equal(firstSession.issuer, descriptor.issuer);
    assert.equal(secondSession.issuer, descriptor.issuer);
    assert.deepEqual(firstSession.contacts, []);
    const before = await getProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      a.operator,
    );
    assert.equal(before.members.length, 1);
    assert.notEqual(before.actingPrincipal.id, firstSession.principal.id);
    for (const [page, invitation] of [
      [first, firstInvite],
      [second, secondInvite],
    ] as const) {
      const accepted = await account(page, '/accept-invitation', {
        token: invitation.token,
      });
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.result, {
        scope: scopeA,
        grantsDeviceAccess: false,
      });
      if (page === first)
        assert.equal(
          (
            await account(second, '/accept-invitation', {
              token: invitation.token,
            })
          ).status,
          409,
        );
      assert.equal(
        (await account(page, '/accept-invitation', { token: invitation.token }))
          .status,
        409,
      );
      await denyPrivateAccess(page, secretA);
    }
    const members = await getProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      a.operator,
    );
    assert.equal(
      members.members.find(
        (value) => value.principal.id === firstSession.principal.id,
      )?.role,
      'viewer',
    );
    assert.equal(
      members.members.find(
        (value) => value.principal.id === secondSession.principal.id,
      )?.role,
      'contributor',
    );
    assert.deepEqual(await readDevices(a), devicesBefore);
    checks.push(
      'real local registration/sign-in; distinct issuer-qualified people; invitation-only registration',
      'explicit membership acceptance and role projections; invitation replay refused',
      'account and membership grant no Device access; private Project/operator endpoints denied',
    );

    const cancelled = await invite(a, scopeA);
    await changeProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      {
        kind: 'revoke-invitation',
        scope: scopeA,
        invitationId: cancelled.invitation.id,
      },
      a.operator,
    );
    const stale = members.members.find(
      (value) => value.principal.id === secondSession.principal.id,
    )!;
    await changeProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      {
        kind: 'change-member',
        scope: scopeA,
        principalId: stale.principal.id,
        revision: stale.revision,
        role: 'viewer',
        status: 'revoked',
      },
      a.operator,
    );
    const revoked = await getProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      a.operator,
    );
    assert.equal(
      revoked.members.find((value) => value.principal.id === stale.principal.id)
        ?.status,
      'revoked',
    );
    assert.equal(
      (await account(second, '/accept-invitation', { token: cancelled.token }))
        .status,
      409,
    );
    const restricted = await changeProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      {
        kind: 'invite',
        scope: scopeA,
        email: 'verified-only@example.invalid',
        role: 'viewer',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
      a.operator,
    );
    if (restricted.kind !== 'invited')
      throw new Error('Missing contact-restricted invitation');
    assert.equal(
      (
        await account(second, '/accept-invitation', {
          token: restricted.token,
          verifiedEmails: ['verified-only@example.invalid'],
        })
      ).status,
      400,
    );
    assert.equal(
      (await account(second, '/accept-invitation', { token: restricted.token }))
        .status,
      409,
    );
    checks.push(
      'unverified local contact and caller-supplied contact claims cannot satisfy a restricted invitation',
    );
    checks.push('invitation cancellation and independent member revocation');

    const onB = await open(firstContext, b);
    assert.equal(await session(onB), null);
    const crossStation = await invite(a, scopeA);
    assert.equal(
      (
        await account(
          onB,
          descriptor.login.signUpPath,
          firstUser,
          crossStation.token,
        )
      ).status,
      403,
    );
    const restoredMembership = await account(second, '/accept-invitation', {
      token: crossStation.token,
    });
    assert.equal(restoredMembership.status, 200);
    assert.deepEqual(restoredMembership.result, {
      scope: scopeA,
      grantsDeviceAccess: false,
    });
    const currentMembership = (
      await getProjectAccess(a.base, scopeA.localProjectSlug, a.operator)
    ).members.find(
      (member) => member.principal.id === secondSession.principal.id,
    );
    assert(currentMembership);
    await assert.rejects(
      changeProjectAccess(
        a.base,
        scopeA.localProjectSlug,
        {
          kind: 'change-member',
          scope: scopeA,
          principalId: stale.principal.id,
          revision: stale.revision,
          role: 'admin',
          status: 'active',
        },
        a.operator,
      ),
      { status: 409 },
    );
    await changeProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      {
        kind: 'change-member',
        scope: scopeA,
        principalId: currentMembership.principal.id,
        revision: currentMembership.revision,
        role: 'viewer',
        status: 'revoked',
      },
      a.operator,
    );
    const ownB = await invite(b, scopeB);
    assert.equal(
      (await account(onB, descriptor.login.signUpPath, firstUser, ownB.token))
        .status,
      200,
    );
    assert.equal(
      (await account(onB, descriptor.login.signInPath, firstUser)).status,
      200,
    );
    const identityB = await session(onB);
    assert(identityB);
    assert.notEqual(identityB.principal.id, firstSession.principal.id);
    assert.notEqual(identityB.issuer, firstSession.issuer);
    assert.equal(
      (await session(first))?.principal.id,
      firstSession.principal.id,
    );
    await denyPrivateAccess(onB, secretB);
    checks.push(
      'separate Station hostnames isolate cookies; fresh wrong-Station invitation refused and remains usable at its owner',
      'stale member revision refused; current revision remains usable',
    );

    const originalId = a.stationId;
    const previousBoot = a.bootId;
    await a.stop();
    a = await start('account-station-a', '127.0.0.1', a.port);
    assert.equal(a.stationId, originalId);
    assert.notEqual(a.bootId, previousBoot);
    assert.equal(
      (await session(first))?.principal.id,
      firstSession.principal.id,
    );
    const restored = await getProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      a.operator,
    );
    assert.equal(
      restored.members.find(
        (value) => value.principal.id === firstSession.principal.id,
      )?.status,
      'active',
    );
    assert.equal(
      restored.members.find(
        (value) => value.principal.id === secondSession.principal.id,
      )?.status,
      'revoked',
    );
    await denyPrivateAccess(first, secretA);
    checks.push(
      'real Station restart preserves account identity, cookies, membership and revocation',
    );
    assert.equal(
      (await session(second))?.principal.id,
      secondSession.principal.id,
    );
    const accounts = await getLocalAccounts(a.base, a.operator);
    assert.equal(accounts.kind, 'local');
    if (accounts.kind !== 'local')
      throw new Error('The real local account provider is unavailable');
    const firstAccount = accounts.accounts.find(
      (entry) => entry.username === firstUser.username,
    );
    assert(firstAccount);
    assert.equal(JSON.stringify(accounts).includes('@station.invalid'), false);
    await changeLocalAccount(
      a.base,
      firstAccount.accountId,
      'revoke-sessions',
      a.operator,
    );
    assert.equal(await session(first), null);
    assert.equal(
      (await session(second))?.principal.id,
      secondSession.principal.id,
    );
    assert.equal(
      (await account(first, descriptor.login.signInPath, firstUser)).status,
      200,
    );
    assert.equal(
      (await session(first))?.principal.id,
      firstSession.principal.id,
    );
    await changeLocalAccount(
      a.base,
      firstAccount.accountId,
      'disable',
      a.operator,
    );
    assert.equal(await session(first), null);
    await changeLocalAccount(
      a.base,
      firstAccount.accountId,
      'enable',
      a.operator,
    );
    assert.equal(await session(first), null);
    // Better Auth's persisted sign-in rule permits three attempts per ten
    // seconds. Keep that production limit; cross its window before attempt four.
    await wait(11000, undefined, { signal });
    assert.equal(
      (await account(first, descriptor.login.signInPath, firstUser)).status,
      200,
    );
    assert.equal(
      (await session(first))?.principal.id,
      firstSession.principal.id,
    );
    assert.equal((await session(onB))?.principal.id, identityB.principal.id);
    const preserved = await getProjectAccess(
      a.base,
      scopeA.localProjectSlug,
      a.operator,
    );
    assert.equal(
      preserved.members.find(
        (member) => member.principal.id === firstSession.principal.id,
      )?.status,
      'active',
    );
    assert.deepEqual(await readDevices(a), devicesBefore);
    checks.push(
      'account session revocation and disable/enable invalidate old cookies without deleting membership or affecting another person',
    );
    assert.equal(forbiddenHits, 0);
    assert.equal(permittedHits, 3);
    signal.throwIfAborted();
    outcome = {
      stationIds: [a.stationId, b.stationId],
      principals: [firstSession.principal.id, secondSession.principal.id],
    };
  } catch (error) {
    errors.push(error);
  } finally {
    signal.removeEventListener('abort', abortBrowser);
    stopBundler();
    for (const operation of [
      closeBrowser,
      ...stations.reverse().map((station) => station.stop),
      () => close(permitted),
      () => close(forbidden),
      unlock,
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      'Local account/member runtime scenario failed',
    );
  assert(outcome);
  return {
    ...outcome,
    ports,
    processes,
    bootIds,
    checks,
    browserProfiles: 2,
    transport: 'direct-loopback-http',
    actors: 'synthetic local accounts through the production provider',
    unownedTcpProbeDeliveries: forbiddenHits,
    ownedTcpProbeDeliveries: permittedHits,
  };
}
