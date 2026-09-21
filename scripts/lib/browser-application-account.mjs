// Owned Chromium profile: real provider, SDK signing and scoped Device credential.
export async function browserStartApplicationAccount(input) {
  const api = window.stationApplicationChannel;
  const peer = window.stationTransportLab?.peer;
  const trustStore = window.stationConnectionTrustStore;
  const trust = window.stationConnectionTrustRecord;
  if (!window.stationBrokerLabTransport) {
    if (
      !window.stationTransportLab?.proofConsumed ||
      peer?.connectionState !== 'connected'
    )
      throw new Error('Account transport requires an admitted encrypted peer');
  }
  const lifetime = new AbortController();
  const current = () =>
    !lifetime.signal.aborted && peer?.connectionState === 'connected';
  // Fixture-only broker override: the self-hosted broker journey admits its
  // transport through the production browser Pion connection instead of the
  // legacy ad-hoc RTCPeer path below. Unset in every existing mode, which
  // keeps the legacy path byte-for-byte unchanged.
  const brokerOverride = window.stationBrokerLabTransport;
  const transport =
    brokerOverride?.transport ??
    api.createApplicationChannelFetch({
      origin: input.apiBase,
      signal: lifetime.signal,
      assertCurrent: async () => {
        if (!current() || !(await trustStore.isCurrent(trust)))
          throw new Error('Endpoint trust retired');
      },
      open: (signal) =>
        new Promise((resolve, reject) => {
          const channel = peer.createDataChannel(
            'station-application-account-fixture',
            { ordered: true },
          );
          const cleanup = () => {
            signal.removeEventListener('abort', fail);
            channel.removeEventListener('open', ready);
            channel.removeEventListener('close', fail);
            channel.removeEventListener('error', fail);
          };
          const fail = () => {
            cleanup();
            channel.close();
            reject(new Error('Application channel opening failed'));
          };
          const ready = () => {
            cleanup();
            resolve(api.browserApplicationChannel(channel));
          };
          signal.addEventListener('abort', fail, { once: true });
          channel.addEventListener('open', ready, { once: true });
          channel.addEventListener('close', fail, { once: true });
          channel.addEventListener('error', fail, { once: true });
          if (signal.aborted) fail();
        }),
    });
  const transportBindingIsCurrent =
    brokerOverride?.transportBindingIsCurrent ?? current;
  api.setClientCredentialResolver(() => ({
    origin: input.apiBase,
    credential: input.credential,
    transport,
    transportBindingIsCurrent,
  }));
  const key = await api.createApplicationSessionKey();
  if (key.privateKey.extractable)
    throw new Error('Account signing key is extractable');
  const client = new api.ApplicationSessionClient(
    input.apiBase,
    input.stationId,
    location.origin,
    {
      // Per-call credentials deliberately bypass the SDK transport resolver.
      // This consumer uses the configured Device transport for every operation.
      requireCredential: true,
      signal: lifetime.signal,
      timeoutMs: 15000,
    },
    key,
  );
  const capabilities = await client.capabilities();
  if (!capabilities.virtualLogin)
    throw new Error('Provider does not support relay login');
  const continuation = await client.establish({
    username: input.username,
    password: input.password,
  });
  if (
    continuation.stationId !== input.stationId ||
    continuation.deviceId !== input.deviceId ||
    continuation.clientOrigin !== location.origin
  )
    throw new Error('Continuation binding mismatch');
  window.stationApplicationAccount = { client, continuation, lifetime, input };
  return {
    principalId: continuation.principal.id,
    deviceId: continuation.deviceId,
    stationId: continuation.stationId,
    keyExtractable: key.privateKey.extractable,
  };
}

/** @param {{ path: string, method?: string, body?: unknown, replay?: boolean }} input */
export async function browserApplicationAccountRequest({
  path,
  method = 'GET',
  body,
  replay = false,
}) {
  const state = window.stationApplicationAccount;
  const url = state.input.apiBase + path;
  const headers = replay
    ? state.lastHeaders
    : await state.client.headers(state.continuation, { method, url });
  if (!headers) throw new Error('Missing proof replay control');
  state.lastHeaders = headers;
  const response = await window.stationApplicationChannel.authenticatedFetch(
    url,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 15000,
    },
  );
  return { status: response.status, body: await response.text() };
}
export async function browserAcceptApplicationInvitation(token) {
  const state = window.stationApplicationAccount;
  const url = `${state.input.apiBase}/api/account-auth/accept-invitation`;
  const headers = await state.client.headers(state.continuation, {
    method: 'POST',
    url,
  });
  const response = await window.stationApplicationChannel.authenticatedFetch(
    url,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token ?? state.input.invitation }),
      timeoutMs: 15000,
    },
  );
  return { status: response.status, body: await response.json() };
}
export async function browserRequestBoundApplicationDevice(offer) {
  const state = window.stationApplicationAccount;
  const body = {
    offerId: offer.offerId,
    proof: offer.proof,
    deviceName: 'Bound encrypted account lab browser',
  };
  const url = state.input.apiBase + '/.well-known/station/v1/pairing/request';
  const headers = await state.client.headers(state.continuation, {
    method: 'POST',
    url,
    body: JSON.stringify(body),
  });
  const response = await window.stationApplicationChannel.authenticatedFetch(
    url,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 15000,
    },
  );
  return { status: response.status, body: await response.json() };
}
export async function browserAdoptBoundApplicationDevice(device) {
  const state = window.stationApplicationAccount;
  state.input.credential = device.credential;
  state.input.deviceId = device.deviceId;
  state.continuation = await state.client.establish({
    username: state.input.username,
    password: state.input.password,
  });
  if (state.continuation.deviceId !== device.deviceId)
    throw new Error('Bound Device continuation mismatch');
  return { principalId: state.continuation.principal.id };
}
export async function browserRejectWrongBoundAccount() {
  const state = window.stationApplicationAccount;
  try {
    await state.client.establish({
      username: state.input.wrongUsername,
      password: state.input.wrongPassword,
    });
    return false;
  } catch (error) {
    if (
      error instanceof window.stationApplicationChannel.StationHttpError &&
      error.status === 401 &&
      error.message === 'application_session_invalid'
    )
      return true;
    throw error;
  }
}
export async function browserRenewApplicationAccount() {
  const state = window.stationApplicationAccount;
  const previous = state.continuation;
  state.continuation = await state.client.renew(previous);
  if (
    state.continuation.authorityKey !== previous.authorityKey ||
    state.continuation.principal.id !== previous.principal.id ||
    state.continuation.deviceId !== previous.deviceId
  )
    throw new Error('Renewal changed account authority');
  return { principalId: state.continuation.principal.id };
}
export async function browserRevokeApplicationContinuation() {
  const state = window.stationApplicationAccount;
  await state.client.revoke(state.continuation);
}
export async function browserLoginApplicationAccountAgain() {
  const state = window.stationApplicationAccount;
  state.continuation = await state.client.establish({
    username: state.input.username,
    password: state.input.password,
  });
  return { principalId: state.continuation.principal.id };
}
export function browserStopApplicationAccount() {
  window.stationApplicationAccount?.lifetime.abort();
  window.stationApplicationChannel.setClientCredentialResolver(undefined);
}
