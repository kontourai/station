import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { createApplicationChannelFetch } from '@kontourai/station-connect/application-channel';
import {
  type DevicePairingBearerExchangeResponse,
  type DevicePairingOffer,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  pairingScopePresetString,
} from '@kontourai/station-contracts/environment-security';
import { getAccountAuthentication } from '@kontourai/station-sdk/account-authentication';
import { createProject } from '@kontourai/station-sdk/client';
import {
  changeLocalAccount,
  getLocalAccounts,
} from '@kontourai/station-sdk/local-accounts';
import {
  changeProjectAccess,
  getProjectAccess,
} from '@kontourai/station-sdk/project-access-client';
import {
  acquireAccountLabPorts,
  startAccountLabStation,
} from './local-collaboration-station.js';

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
/** Real account/Project setup in an isolated source Station, with an approved Device. */
export async function startRelayAccountStation(
  directory: string,
  browserOrigin: string,
  signal: AbortSignal,
) {
  const release = await acquireAccountLabPorts();
  const nonce = randomBytes(32).toString('hex');
  let allowedHits = 0;
  let blockedHits = 0;
  const allowed = createServer((_request, response) => {
    allowedHits++;
    response.end(nonce);
  });
  const blocked = createServer((_request, response) => {
    blockedHits++;
    response.end('unowned');
  });
  let station: Awaited<ReturnType<typeof startAccountLabStation>> | undefined;
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      const results = await Promise.allSettled([
        station?.stop(),
        close(allowed),
        close(blocked),
      ]);
      await release();
      for (const result of results)
        if (result.status === 'rejected') throw result.reason;
    })());
  try {
    station = await startAccountLabStation(
      {
        directory: join(directory, 'application-station'),
        name: 'relay-account-lab',
        hostname: '127.0.0.1',
        allowedProbePort: await listen(allowed),
        blockedProbePort: await listen(blocked),
        probeNonce: nonce,
        virtualApplicationOrigin: browserOrigin,
      },
      signal,
    );
    assert.equal(allowedHits, 1);
    assert.equal(blockedHits, 0);
    const current = station;
    assert(current.openApplicationChannel);
    const transport = createApplicationChannelFetch({
      origin: current.base,
      signal,
      open: async () => current.openApplicationChannel!(),
      assertCurrent: () => signal.throwIfAborted(),
    });
    const http = async <T = Record<string, unknown>>(
      path: string,
      body?: unknown,
      operator = false,
    ) => {
      const response = await fetch(current.base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: current.base,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(operator
            ? { Authorization: `Bearer ${current.operator.credential}` }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      });
      return {
        status: response.status,
        body: (await response.json()) as T,
      };
    };
    const privateName = `private-project-${randomBytes(16).toString('hex')}`;
    await createProject(
      current.base,
      { name: privateName, slug: 'relay-private' },
      current.operator,
    );
    const shared = await createProject(
      current.base,
      { name: 'Relay shared fixture', slug: 'relay-shared' },
      current.operator,
    );
    const enabled = await changeProjectAccess(
      current.base,
      shared.slug,
      { kind: 'enable', localProjectId: shared.id },
      current.operator,
    );
    assert.equal(enabled.kind, 'enabled');
    if (enabled.kind !== 'enabled')
      throw new Error('Shared Project enablement failed');
    const invitation = await changeProjectAccess(
      current.base,
      shared.slug,
      {
        kind: 'invite',
        scope: enabled.view.scope,
        email: null,
        role: 'viewer',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
      current.operator,
    );
    assert.equal(invitation.kind, 'invited');
    if (invitation.kind !== 'invited')
      throw new Error('Project invitation failed');
    const descriptor = await getAccountAuthentication(current.base);
    assert(
      descriptor.login?.kind === 'username-password' &&
        descriptor.login.signUpPath,
    );
    const username = 'relay.viewer';
    const password = `Lab-${randomBytes(20).toString('hex')}-Aa1!`;
    const wrongUsername = 'relay.other';
    const wrongPassword = `Lab-${randomBytes(20).toString('hex')}-Bb2!`;
    const signup = await fetch(
      `${current.base}/api/account-auth${descriptor.login.signUpPath}`,
      {
        method: 'POST',
        headers: {
          Origin: current.base,
          'Content-Type': 'application/json',
          'x-station-invitation': invitation.token,
        },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      },
    );
    assert.equal(signup.status, 200);
    assert.equal(
      signup.headers.has('set-cookie'),
      false,
      'Registration must not install an account session',
    );
    await signup.arrayBuffer();
    const wrongInvite = await changeProjectAccess(
      current.base,
      shared.slug,
      {
        kind: 'invite',
        scope: enabled.view.scope,
        email: null,
        role: 'viewer',
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      },
      current.operator,
    );
    assert.equal(wrongInvite.kind, 'invited');
    if (wrongInvite.kind !== 'invited')
      throw new Error('Wrong-account invitation failed');
    const wrongSignup = await fetch(
      `${current.base}/api/account-auth${descriptor.login.signUpPath}`,
      {
        method: 'POST',
        headers: {
          Origin: current.base,
          'Content-Type': 'application/json',
          'x-station-invitation': wrongInvite.token,
        },
        body: JSON.stringify({
          username: wrongUsername,
          password: wrongPassword,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: 'error',
      },
    );
    assert.equal(wrongSignup.status, 200);
    await wrongSignup.arrayBuffer();
    const offer = await http<DevicePairingOffer>(
      '/api/pairing/offers',
      { endpoint: current.base, scope: pairingScopePresetString('read-only') },
      true,
    );
    assert.equal(offer.status, 201);
    const proof = { offerId: offer.body.offerId, proof: offer.body.challenge };
    const request = await transport(
      current.base + PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
      {
        method: 'POST',
        headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...proof,
          deviceName: 'Encrypted account lab browser',
        }),
      },
    );
    assert.equal(request.status, 202);
    const pending = (await request.json()) as { requestId: string };
    assert(pending.requestId);
    assert.equal(
      (
        await http(
          `/api/pairing/requests/${pending.requestId}/confirm`,
          {},
          true,
        )
      ).status,
      200,
    );
    const exchange = await transport(
      current.base + PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
      {
        method: 'POST',
        headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...proof, requestId: pending.requestId }),
      },
    );
    assert.equal(exchange.status, 200);
    let device = (await exchange.json()) as DevicePairingBearerExchangeResponse;
    assert.match(device.credential, /^[A-Za-z0-9_-]{43}$/);
    const bearerOnlyPrivateRead = async (
      request: typeof fetch,
      origin: string,
    ) => {
      const response = await request(
        `${current.base}/api/projects/relay-private`,
        {
          headers: {
            Origin: origin,
            Authorization: `Bearer ${device.credential}`,
          },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
          redirect: 'error',
        },
      );
      return { status: response.status, body: await response.text() };
    };
    return {
      station: current,
      stop,
      browser: {
        apiBase: current.base,
        stationId: current.stationId,
        deviceId: device.device.id,
        credential: device.credential,
        username,
        password,
        wrongUsername,
        wrongPassword,
        invitation: invitation.token,
        privateName,
      },
      async createBoundDeviceOffer() {
        const result = await http<DevicePairingOffer>(
          '/api/pairing/offers',
          {
            endpoint: current.base,
            scope: pairingScopePresetString('read-only'),
          },
          true,
        );
        assert.equal(result.status, 201);
        return result.body;
      },
      async confirmBoundDevice(requestId: string) {
        const confirmation = await http<{ principalBinding: { kind: string } }>(
          `/api/pairing/requests/${requestId}/confirm`,
          { bindAccountIdentity: true },
          true,
        );
        assert.equal(confirmation.status, 200);
        assert.equal(confirmation.body.principalBinding.kind, 'account');
      },
      async exchangeBoundDevice(offer: DevicePairingOffer, requestId: string) {
        const response = await transport(
          current.base + PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
          {
            method: 'POST',
            headers: {
              Origin: browserOrigin,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              offerId: offer.offerId,
              proof: offer.challenge,
              requestId,
            }),
          },
        );
        assert.equal(response.status, 200);
        device = (await response.json()) as DevicePairingBearerExchangeResponse;
        assert(
          device.device.principalBinding &&
            'kind' in device.device.principalBinding &&
            device.device.principalBinding.kind === 'account',
        );
        return { credential: device.credential, deviceId: device.device.id };
      },
      async verifyMembership(principalId: string) {
        const access = await getProjectAccess(
          current.base,
          shared.slug,
          current.operator,
        );
        assert(
          access.members.some(
            (member) =>
              member.principal.id === principalId &&
              member.role === 'viewer' &&
              member.status === 'active',
          ),
        );
      },
      readPrivateWithBearerOnlyDirect: () =>
        bearerOnlyPrivateRead(fetch, current.base),
      readPrivateWithBearerOnlyVirtual: () =>
        bearerOnlyPrivateRead(transport, browserOrigin),
      async revokeMembership(principalId: string) {
        const access = await getProjectAccess(
          current.base,
          shared.slug,
          current.operator,
        );
        const member = access.members.find(
          (candidate) =>
            candidate.principal.id === principalId &&
            candidate.status === 'active',
        );
        assert(member);
        assert.equal(member.role, 'viewer');
        await changeProjectAccess(
          current.base,
          shared.slug,
          {
            kind: 'change-member',
            scope: enabled.view.scope,
            principalId,
            revision: member.revision,
            role: 'viewer',
            status: 'revoked',
          },
          current.operator,
        );
      },
      async inviteAgain() {
        const next = await changeProjectAccess(
          current.base,
          shared.slug,
          {
            kind: 'invite',
            scope: enabled.view.scope,
            email: null,
            role: 'viewer',
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
          current.operator,
        );
        assert.equal(next.kind, 'invited');
        if (next.kind !== 'invited')
          throw new Error('Replacement Project invitation failed');
        return next.token;
      },
      async revokeAccount() {
        const accounts = await getLocalAccounts(current.base, current.operator);
        assert(accounts.kind === 'local');
        if (accounts.kind !== 'local')
          throw new Error('Local accounts unavailable');
        const account = accounts.accounts.find(
          (account) => account.username === username,
        );
        assert(account);
        await changeLocalAccount(
          current.base,
          account.accountId,
          'revoke-sessions',
          current.operator,
        );
      },
      async revokeDevice() {
        const response = await fetch(
          `${current.base}/api/pairing/devices/${device.device.id}`,
          {
            method: 'DELETE',
            headers: {
              Origin: current.base,
              Authorization: `Bearer ${current.operator.credential}`,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
            redirect: 'error',
          },
        );
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
