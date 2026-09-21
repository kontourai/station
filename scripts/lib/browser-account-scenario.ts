import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  browserAcceptApplicationInvitation,
  browserAdoptBoundApplicationDevice,
  browserApplicationAccountRequest,
  browserLoginApplicationAccountAgain,
  browserRejectWrongBoundAccount,
  browserRenewApplicationAccount,
  browserRequestBoundApplicationDevice,
  browserRevokeApplicationContinuation,
  browserStartApplicationAccount,
  browserStopApplicationAccount,
} from './browser-application-account.mjs';
import type { provisionRelayAccountStation } from './local-collaboration-relay-account.js';

/** Same protected API journey for local and genuinely remote Station fixtures. */
export async function runBrowserAccountScenario(
  page: Page,
  accountStation: Awaited<ReturnType<typeof provisionRelayAccountStation>>,
  root: string,
  beforeDeviceRevocation?: () => Promise<void>,
) {
  let directApplicationAttempts = 0;
  await page.route(`${accountStation.station.base}/**`, async (route) => {
    directApplicationAttempts++;
    await route.abort('blockedbyclient');
  });
  let loginTimer: ReturnType<typeof setTimeout> | undefined;
  const account = await Promise.race([
    page.evaluate(browserStartApplicationAccount, accountStation.browser),
    new Promise<never>((_, reject) => {
      loginTimer = setTimeout(
        () =>
          reject(new Error('Encrypted account login exceeded liveness bound')),
        20_000,
      );
    }),
  ]).finally(() => clearTimeout(loginTimer));
  assert.equal(account.stationId, accountStation.station.stationId);
  const self = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/account-auth/session',
  });
  assert.equal(self.status, 200, self.body);
  assert.equal(JSON.parse(self.body).data.principal.id, account.principalId);
  const replay = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/account-auth/session',
    replay: true,
  });
  assert.equal(replay.status, 401);
  const accepted = await page.evaluate(browserAcceptApplicationInvitation);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.data.grantsDeviceAccess, false);
  await accountStation.verifyMembership(account.principalId);
  const replacementOffer = await accountStation.createBoundDeviceOffer();
  const replacementRequest = await page.evaluate(
    browserRequestBoundApplicationDevice,
    { offerId: replacementOffer.offerId, proof: replacementOffer.challenge },
  );
  assert.equal(replacementRequest.status, 202);
  await accountStation.confirmBoundDevice(replacementRequest.body.requestId);
  await page.evaluate(browserRevokeApplicationContinuation);
  const boundDevice = await accountStation.exchangeBoundDevice(
    replacementOffer,
    replacementRequest.body.requestId,
  );
  assert.equal(
    (await page.evaluate(browserAdoptBoundApplicationDevice, boundDevice))
      .principalId,
    account.principalId,
  );
  assert.equal(await page.evaluate(browserRejectWrongBoundAccount), true);
  const sharedRead = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/projects/relay-shared',
  });
  assert.equal(
    sharedRead.status,
    200,
    'Permitted Project is the positive resource control',
  );
  assert(sharedRead.body.includes('Relay shared fixture'));
  const sharedView = JSON.parse(sharedRead.body).data;
  assert.equal(sharedView.version, 'station.member-project/v1');
  assert.equal(sharedView.kind, 'member-project');
  assert.deepEqual(sharedView.actions, ['view']);
  const memberKeys = new Set([
    'version',
    'kind',
    'id',
    'slug',
    'name',
    'icon',
    'description',
    'actions',
  ]);
  assert(Object.keys(sharedView).every((key) => memberKeys.has(key)));
  const catalogue = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/projects',
  });
  assert.equal(catalogue.status, 200);
  const memberProjects = JSON.parse(catalogue.body).data;
  assert.equal(memberProjects.length, 1);
  assert.equal(memberProjects[0].id, sharedView.id);
  assert.deepEqual(memberProjects[0].actions, ['view']);
  assert(Object.keys(memberProjects[0]).every((key) => memberKeys.has(key)));
  assert(!catalogue.body.includes(accountStation.browser.privateName));
  const privateRead = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/projects/relay-private',
  });
  const [bearerOnlyDirect, bearerOnlyVirtual] = await Promise.all([
    accountStation.readPrivateWithBearerOnlyDirect(),
    accountStation.readPrivateWithBearerOnlyVirtual(),
  ]);
  const privateBoundary = {
    status: privateRead.status,
    containsPrivateMarker: privateRead.body.includes(
      accountStation.browser.privateName,
    ),
    path: '/api/projects/relay-private',
    deviceScope: 'orchestration:read',
    principalId: account.principalId,
    bearerOnlyDirect: {
      status: bearerOnlyDirect.status,
      containsPrivateMarker: bearerOnlyDirect.body.includes(
        accountStation.browser.privateName,
      ),
    },
    bearerOnlyVirtual: {
      status: bearerOnlyVirtual.status,
      containsPrivateMarker: bearerOnlyVirtual.body.includes(
        accountStation.browser.privateName,
      ),
    },
  };
  writeFileSync(
    join(root, 'account-boundary.json'),
    JSON.stringify(privateBoundary, null, 2),
    { mode: 0o600 },
  );
  const privateRefused =
    privateRead.status === 404 &&
    !privateBoundary.containsPrivateMarker &&
    JSON.parse(privateRead.body).error === 'Project not found' &&
    bearerOnlyDirect.status === 401 &&
    !privateBoundary.bearerOnlyDirect.containsPrivateMarker &&
    bearerOnlyVirtual.status === 401 &&
    !privateBoundary.bearerOnlyVirtual.containsPrivateMarker;
  assert(
    privateRefused,
    `Unshared Project boundary failed: ${JSON.stringify(privateBoundary)}`,
  );
  await page.evaluate(browserRenewApplicationAccount);
  await page.evaluate(browserRevokeApplicationContinuation);
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    401,
    'Continuation revocation refuses a permitted Project read',
  );
  assert.equal(
    (await page.evaluate(browserLoginApplicationAccountAgain)).principalId,
    account.principalId,
  );
  await accountStation.revokeAccount();
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    401,
    'Provider-session revocation refuses a permitted Project read',
  );
  assert.equal(
    (await page.evaluate(browserLoginApplicationAccountAgain)).principalId,
    account.principalId,
  );
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    200,
    'A fresh provider session restores the permitted Project read',
  );
  await accountStation.revokeMembership(account.principalId);
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    404,
    'Membership revocation independently refuses the Project read',
  );
  const replacementInvitation = await accountStation.inviteAgain();
  assert.equal(
    (
      await page.evaluate(
        browserAcceptApplicationInvitation,
        replacementInvitation,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    200,
    'Restored membership proves Device revocation is independent',
  );
  await beforeDeviceRevocation?.();
  await accountStation.revokeDevice();
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    401,
  );
  await page.evaluate(browserStopApplicationAccount);
  assert.equal(
    directApplicationAttempts,
    0,
    'Account traffic must not bypass the encrypted channel',
  );
  const accountReport = {
    status: privateRefused ? 'passed' : 'failed',
    directApplicationAttempts,
    stationId: account.stationId,
    principalId: account.principalId,
    keyExtractable: account.keyExtractable,
    scope:
      'full source Station account, Device and membership APIs; no guest UI or compute',
    checks: [
      'encrypted provider login',
      'account self and proof replay refusal',
      'invitation acceptance without new Device authority',
      'operator-observed viewer membership and permitted Project read',
      'continuation renewal and revocation',
      'provider-session revocation and stable relogin',
      'membership revocation and invitation-based restoration',
      'Device revocation independently refuses a permitted Project read',
    ],
    privateProject: privateBoundary,
  };
  writeFileSync(
    join(root, 'account-scenario.json'),
    JSON.stringify(accountReport, null, 2),
    { mode: 0o600 },
  );
  return accountReport;
}
