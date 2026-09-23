import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  browserAcceptApplicationInvitation,
  browserAdoptBoundApplicationDevice,
  browserAdoptCookieSessions,
  browserApplicationAccountRequest,
  browserCookieAdoptionOriginState,
  browserCookieAdoptionSecrets,
  browserExchangeCookieDevice,
  browserLoginApplicationAccountAgain,
  browserReadAliasOnlyDirect,
  browserReadCookieAccountAndParent,
  browserRejectWrongBoundAccount,
  browserRenewApplicationAccount,
  browserRequestBoundApplicationDevice,
  browserRequestCookieDevice,
  browserRevokeApplicationContinuation,
  browserRevokeCookieAlias,
  browserSelectCookieAdoption,
  browserSignInForCookieAdoption,
  browserStartApplicationAccount,
  browserStopApplicationAccount,
} from './browser-application-account.mjs';
import type { provisionRelayAccountStation } from './local-collaboration-relay-account.js';

export async function runBrowserCookieAdoptionScenario(
  page: Page,
  station: Awaited<ReturnType<typeof provisionRelayAccountStation>>,
  broker: {
    setExpectedAliasCredential(value: string): void;
    applicationObservations(): Array<{
      path: string;
      method: string;
      status: number;
      cookieHeader: boolean;
      setCookieHeader: boolean;
      continuationHeader: boolean;
      proofHeader: boolean;
      aliasCredential: boolean;
      origin: string | null;
    }>;
  },
) {
  const apiBase = station.station.base;
  const browserInput = station.browser;
  const originState = await page.evaluate(browserCookieAdoptionOriginState);
  assert.equal(originState.secureContext, true);
  assert.equal(new URL(apiBase).protocol, 'https:');
  assert.equal(originState.origin, apiBase);

  const countBeforePair = await station.deviceCount();
  const offer = await station.createBrowserCookieOffer();
  const request = await page.evaluate(browserRequestCookieDevice, {
    apiBase,
    requestPath: '/.well-known/station/v1/pairing/request',
    ...offer,
  });
  await station.confirmBrowserCookieRequest(request.requestId);
  const exchange = await page.evaluate(browserExchangeCookieDevice, {
    apiBase,
    exchangePath: '/.well-known/station/v1/pairing/exchange',
    ...offer,
    requestId: request.requestId,
  });
  assert.equal(exchange.delivery, 'browser-cookie');
  assert.equal(exchange.setCookieVisibleToJavascript, false);
  assert.equal(exchange.deviceCookieVisibleToJavascript, false);
  const countAfterPair = await station.deviceCount();
  assert.equal(countAfterPair, countBeforePair + 1);

  const deviceCookie = (await page.context().cookies(apiBase)).find(
    (cookie) => cookie.name === '__Host-station-device',
  );
  assert(deviceCookie, 'Station must install its real secure Device cookie');
  assert.equal(deviceCookie.httpOnly, true);
  assert.equal(deviceCookie.secure, true);
  assert.equal(deviceCookie.sameSite, 'Strict');
  const accountLogin = await page.evaluate(browserSignInForCookieAdoption, {
    apiBase,
    username: browserInput.username,
    password: browserInput.password,
    signInPath: browserInput.signInPath,
    sessionCookies: browserInput.sessionCookies,
  });
  assert.equal(accountLogin.setCookieVisibleToJavascript, false);
  assert.equal(accountLogin.accountCookieVisibleToJavascript, false);
  const accountCookie = (await page.context().cookies(apiBase)).find((cookie) =>
    browserInput.sessionCookies.includes(cookie.name),
  );
  assert(accountCookie, 'Provider must install its real account cookie');
  assert.equal(accountCookie.httpOnly, true);
  assert.equal(accountCookie.secure, true);

  const first = await page.evaluate(browserAdoptCookieSessions, {
    apiBase,
    stationId: browserInput.stationId,
    invitation: browserInput.invitation,
    username: browserInput.username,
    sessionCookies: browserInput.sessionCookies,
  });
  const second = await page.evaluate(browserAdoptCookieSessions, {
    apiBase,
    stationId: browserInput.stationId,
    invitation: browserInput.invitation,
    username: browserInput.username,
    sessionCookies: browserInput.sessionCookies,
  });
  assert.equal(first.keyExtractable, false);
  assert.equal(second.keyExtractable, false);
  assert.equal(first.stationId, browserInput.stationId);
  assert.equal(first.clientOrigin, apiBase);
  assert.equal(second.deviceId, first.deviceId);
  assert.equal(await station.deviceCount(), countAfterPair);
  const deviceCookieAfter = (await page.context().cookies(apiBase)).find(
    (cookie) => cookie.name === '__Host-station-device',
  );
  assert.equal(deviceCookieAfter?.value, deviceCookie.value);

  const cookieIdentity = await page.evaluate(
    browserReadCookieAccountAndParent,
    {
      apiBase,
      deviceId: first.deviceId,
      sessionCookies: browserInput.sessionCookies,
    },
  );
  assert.equal(cookieIdentity.account.status, 200);
  assert.equal(cookieIdentity.parent.status, 200);
  assert.equal(cookieIdentity.parent.containsDevice, true);
  assert.equal(cookieIdentity.deviceCookieVisibleToJavascript, false);
  assert.equal(cookieIdentity.accountCookieVisibleToJavascript, false);

  const aliasOnlyDirect = await page.evaluate(browserReadAliasOnlyDirect, {
    index: 1,
    path: '/api/projects/relay-private',
  });
  assert.equal(aliasOnlyDirect.status, 401);
  await page.evaluate(browserSelectCookieAdoption, { index: 1 });
  const expectedAlias = (await page.evaluate(browserCookieAdoptionSecrets))[1]!;
  broker.setExpectedAliasCredential(expectedAlias);
  await page.route(`${apiBase}/**`, async (route) =>
    route.abort('blockedbyclient'),
  );
  const sharedRead = await page.evaluate(browserApplicationAccountRequest, {
    path: '/api/account-auth/session',
  });
  assert.equal(sharedRead.status, 200, sharedRead.body);
  assert.equal(
    JSON.parse(sharedRead.body).data.principal.id,
    cookieIdentity.account.principalId,
  );
  const vaiRead = broker
    .applicationObservations()
    .slice()
    .reverse()
    .find((item) => item.path === '/api/account-auth/session');
  assert(vaiRead, 'Station VAI must observe the real browser Project request');
  assert.equal(vaiRead.status, 200);
  assert.equal(vaiRead.cookieHeader, false);
  assert.equal(vaiRead.setCookieHeader, false);
  assert.equal(vaiRead.continuationHeader, true);
  assert.equal(vaiRead.proofHeader, true);
  assert.equal(vaiRead.aliasCredential, true);
  assert.equal(vaiRead.origin, apiBase);

  await page.unroute(`${apiBase}/**`);
  await page.evaluate(browserRevokeCookieAlias, { index: 0 });
  const parentStillWorks = await page.evaluate(
    browserReadCookieAccountAndParent,
    {
      apiBase,
      deviceId: first.deviceId,
      sessionCookies: browserInput.sessionCookies,
    },
  );
  assert.equal(parentStillWorks.account.status, 200);
  assert.equal(
    parentStillWorks.account.principalId,
    cookieIdentity.account.principalId,
  );
  assert.equal(parentStillWorks.parent.status, 200);
  assert.equal(parentStillWorks.parent.containsDevice, true);
  assert.equal(parentStillWorks.deviceCookieVisibleToJavascript, false);
  assert.equal(parentStillWorks.accountCookieVisibleToJavascript, false);
  await page.route(`${apiBase}/**`, async (route) =>
    route.abort('blockedbyclient'),
  );

  await page.evaluate(browserSelectCookieAdoption, { index: 0 });
  const revokedAliasRead = await page.evaluate(
    browserApplicationAccountRequest,
    {
      path: '/api/projects/relay-shared',
    },
  );
  assert.equal(revokedAliasRead.status, 401);
  await page.evaluate(browserSelectCookieAdoption, { index: 1 });
  await station.revokeDeviceId(first.deviceId);
  const parentRevokedRead = await page.evaluate(
    browserApplicationAccountRequest,
    {
      path: '/api/projects/relay-shared',
    },
  );
  assert.equal(parentRevokedRead.status, 401);
  await page.unroute(`${apiBase}/**`);
  const afterParentRevocation = await page.evaluate(
    browserReadCookieAccountAndParent,
    {
      apiBase,
      deviceId: first.deviceId,
      sessionCookies: browserInput.sessionCookies,
    },
  );
  assert.equal(afterParentRevocation.account.status, 200);
  assert.equal(afterParentRevocation.parent.status, 401);

  return {
    status: 'passed',
    origin: apiBase,
    secureContext: true,
    deviceCookieHttpOnlySecureStrict:
      deviceCookie.httpOnly &&
      deviceCookie.secure &&
      deviceCookie.sameSite === 'Strict',
    accountCookieHttpOnlySecure: accountCookie.httpOnly && accountCookie.secure,
    cookieValuesVisibleToJavascript: false,
    adoptedDeviceId: first.deviceId,
    deviceCountBeforeAdoption: countAfterPair,
    deviceCountAfterAdoption: await station.deviceCount(),
    vaiAliasRequest: {
      status: vaiRead.status,
      cookieHeader: vaiRead.cookieHeader,
      setCookieHeader: vaiRead.setCookieHeader,
      continuationHeader: vaiRead.continuationHeader,
      proofHeader: vaiRead.proofHeader,
      aliasCredential: vaiRead.aliasCredential,
    },
    aliasOnlyDirectStatus: aliasOnlyDirect.status,
    aliasOnlyRevocationPreservedParentAndAccount: true,
    aliasRevocationStatus: revokedAliasRead.status,
    parentRevocationStatus: parentRevokedRead.status,
    parentCookieAfterDeviceRevocationStatus:
      afterParentRevocation.parent.status,
    privateSecrets: [
      deviceCookie.value,
      accountCookie.value,
      ...(await page.evaluate(browserCookieAdoptionSecrets)),
    ],
  };
}

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
  const boundDevice = await accountStation.exchangeBoundDevice(
    replacementOffer,
    replacementRequest.body.requestId,
  );
  // Exchange must see the still-current account session that the operator
  // approved; revoke the old continuation only after the Device is issued.
  await page.evaluate(browserRevokeApplicationContinuation);
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
  const sharedWorkChecks: string[] = [];
  const accountRequest = (path: string) =>
    page.evaluate(browserApplicationAccountRequest, { path });
  const work = accountStation.sharedWork;
  assert(work, 'Published-work fixture is required');
  const assertPublishedDocument = async () => {
    const response = await accountRequest(
      `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/document`,
    );
    assert.equal(response.status, 200, response.body);
    const document = JSON.parse(response.body).data;
    assert.equal(document.kind, 'snapshot');
    assert.equal(document.project.id, work.expected.project.localProjectId);
    assert.equal(document.project.slug, work.slug);
    assert.equal(document.task.id, work.sharedTask.id);
    assert.equal(document.task.createdAt, work.sharedTask.createdAt);
    assert(document.text.includes(work.sharedTask.documentMarker));
    for (const marker of [
      work.unpublishedTask.title,
      work.unpublishedTask.messageMarker,
      work.unpublishedTask.documentMarker,
    ])
      assert(!response.body.includes(marker));
    return response;
  };

  {
    const sharedList = await accountRequest(
      `/api/projects/${work.slug}/shared-work`,
    );
    assert.equal(sharedList.status, 200, sharedList.body);
    const sharedItems = JSON.parse(sharedList.body).data;
    assert(Array.isArray(sharedItems));
    assert.equal(sharedItems.length, 1);
    assert.equal(sharedItems[0].task.id, work.sharedTask.id);
    assert.equal(sharedItems[0].task.createdAt, work.sharedTask.createdAt);
    assert.deepEqual(sharedItems[0].project, work.expected.project);
    assert(!sharedList.body.includes(work.unpublishedTask.id));
    assert(!sharedList.body.includes(work.unpublishedTask.title));
    sharedWorkChecks.push('shared-work catalogue contains shared Task only');
    const sharedHistory = await accountRequest(
      `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
    );
    assert.equal(sharedHistory.status, 200, sharedHistory.body);
    assert(sharedHistory.body.includes(work.sharedTask.messageMarker));
    assert(!sharedHistory.body.includes(work.unpublishedTask.messageMarker));
    sharedWorkChecks.push('shared Task history exposes message marker');
    const sharedDocument = await accountRequest(
      `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/document`,
    );
    assert.equal(sharedDocument.status, 200, sharedDocument.body);
    assert(sharedDocument.body.includes(work.sharedTask.documentMarker));
    assert(!sharedDocument.body.includes(work.unpublishedTask.documentMarker));
    sharedWorkChecks.push('shared Task document exposes text marker');
    const unpublishedHistory = await accountRequest(
      `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.unpublishedTask.id)}/history`,
    );
    assert.equal(unpublishedHistory.status, 404, unpublishedHistory.body);
    assert(
      !unpublishedHistory.body.includes(work.unpublishedTask.messageMarker),
    );
    const unpublishedDocument = await accountRequest(
      `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.unpublishedTask.id)}/document`,
    );
    assert.equal(unpublishedDocument.status, 404, unpublishedDocument.body);
    assert(
      !unpublishedDocument.body.includes(work.unpublishedTask.documentMarker),
    );
    sharedWorkChecks.push('unpublished Task shared reads refuse with 404');
    const ordinaryTask = await accountRequest(
      `/api/tasks/${encodeURIComponent(work.unpublishedTask.id)}`,
    );
    assert.equal(ordinaryTask.status, 403, ordinaryTask.body);
    assert(
      !ordinaryTask.body.includes(work.unpublishedTask.messageMarker) &&
        !ordinaryTask.body.includes(work.unpublishedTask.documentMarker),
      'Ordinary Task ceiling must not expose body',
    );
    sharedWorkChecks.push('ordinary Task route ceiling refuses with 403');
  }
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
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
      )
    ).status,
    404,
    'Membership revocation refuses shared Task history',
  );
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/document`,
      )
    ).status,
    404,
    'Membership revocation refuses shared Task document',
  );
  sharedWorkChecks.push('membership revocation refuses shared Task reads');
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
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
      )
    ).status,
    200,
    'Membership restore restores shared Task history',
  );
  await assertPublishedDocument();
  sharedWorkChecks.push('membership restore restores shared reads');
  await accountStation.unshareSharedTask();
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
      )
    ).status,
    404,
    'Unshare refuses shared Task history while membership stands',
  );
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/document`,
      )
    ).status,
    404,
    'Unshare refuses shared Task document while membership stands',
  );
  sharedWorkChecks.push('operator unshare refuses shared reads');
  await accountStation.republishSharedTask();
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
      )
    ).status,
    200,
    'Republish restores shared Task history with a different shareId',
  );
  await assertPublishedDocument();
  sharedWorkChecks.push('republish with new shareId restores shared reads');
  await beforeDeviceRevocation?.();
  await assertPublishedDocument();
  sharedWorkChecks.push(
    'current transport reads the published document before Device revocation',
  );
  await accountStation.revokeDevice();
  assert.equal(
    (
      await page.evaluate(browserApplicationAccountRequest, {
        path: '/api/projects/relay-shared',
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await accountRequest(
        `/api/projects/${work.slug}/shared-work/${encodeURIComponent(work.sharedTask.id)}/history`,
      )
    ).status,
    401,
    'Device revocation independently refuses shared Task history',
  );
  sharedWorkChecks.push('device revocation refuses shared Task history');
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
      ...sharedWorkChecks,
      'continuation renewal and revocation',
      'provider-session revocation and stable relogin',
      'membership revocation and invitation-based restoration',
      'Device revocation independently refuses a permitted Project read',
    ],
    sharedWork: {
      slug: work.slug,
      sharedTaskId: work.sharedTask.id,
      unpublishedTaskId: work.unpublishedTask.id,
      checks: sharedWorkChecks,
    },
    privateProject: privateBoundary,
  };
  writeFileSync(
    join(root, 'account-scenario.json'),
    JSON.stringify(accountReport, null, 2),
    { mode: 0o600 },
  );
  return accountReport;
}
