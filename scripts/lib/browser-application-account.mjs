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
  window.stationApplicationAccount = {
    client,
    continuation,
    lifetime,
    input,
    transport,
  };
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
export function browserApplicationAccountPrincipal() {
  return window.stationApplicationAccount?.continuation?.principal?.id;
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

/** Begin a fresh relay enrollment using only the admitted encrypted transport. */
export async function browserBeginFreshRelayEnrollment(input) {
  const api = window.stationRelayEnrollment;
  const channel = window.stationBrokerLabTransport?.transport;
  if (!api || !channel)
    throw new Error('Missing encrypted relay enrollment transport');
  const priorAccountStatePresent =
    window.stationApplicationAccount !== undefined;
  const cookieJarBeforeLogin = document.cookie;
  if (priorAccountStatePresent || cookieJarBeforeLogin !== '')
    throw new Error('Fresh browser profile contains prior account state');
  const key = await api.createRelayEnrollmentKey();
  const observedRequestHeaders = [];
  const post = async (path, body) => {
    const headers = new Headers({
      Origin: location.origin,
      'Content-Type': 'application/json',
    });
    observedRequestHeaders.push([...headers.keys()].sort());
    if (headers.has('authorization') || headers.has('cookie'))
      throw new Error('Fresh relay request attempted an existing credential');
    const response = await channel(`${input.apiBase}${path}`, {
      method: 'POST',
      headers: Object.fromEntries(headers.entries()),
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      timeoutMs: 15000,
    });
    return { status: response.status, body: await response.json() };
  };
  const begin = await post(api.RELAY_ENROLLMENT_CLIENT_PATHS.begin, {
    publicKey: key.publicKey,
  });
  if (begin.status !== 201)
    throw new Error(
      `Fresh relay begin refused: ${begin.status} ${JSON.stringify(begin.body)}`,
    );
  const challenge = begin.body;
  if (
    challenge.stationId !== input.stationId ||
    challenge.clientOrigin !== location.origin ||
    challenge.purpose !== 'login'
  )
    throw new Error('Fresh relay challenge binding mismatch');
  const proof = await api.createRelayEnrollmentLoginProof(key, challenge, {
    method: 'POST',
    url: `${input.apiBase}${api.RELAY_ENROLLMENT_CLIENT_PATHS.login}`,
    clientOrigin: location.origin,
  });
  const login = await post(api.RELAY_ENROLLMENT_CLIENT_PATHS.login, {
    enrollmentId: challenge.enrollmentId,
    proof,
    credentials: { username: input.username, password: input.password },
  });
  if (login.status !== 202 || login.body.state !== 'pending')
    throw new Error(`Fresh relay candidate login refused: ${login.status}`);
  if (
    'deviceCredential' in login.body ||
    'continuation' in login.body ||
    'offerProof' in login.body
  )
    throw new Error(
      'Pending fresh relay response disclosed authority material',
    );
  window.stationFreshRelayEnrollment = {
    apiBase: input.apiBase,
    stationId: input.stationId,
    clientOrigin: location.origin,
    key,
    challenge,
    requestId: login.body.requestId,
    transport: channel,
    requestHeaderEvidence: observedRequestHeaders,
  };
  return {
    state: login.body.state,
    enrollmentId: login.body.enrollmentId,
    requestId: login.body.requestId,
    keyExtractable: key.privateKey.extractable,
    requestHeaderEvidence: observedRequestHeaders,
    priorAccountStatePresent,
    cookieJarEmpty: document.cookie === '',
  };
}

export function browserFreshProfileState() {
  return {
    cookieJar: document.cookie,
    hasPriorAccountState: window.stationApplicationAccount !== undefined,
  };
}

/** Finalize after operator approval, prove the delivered bundle inert, then ACK. */
export async function browserFinalizeAndActivateFreshRelayEnrollment() {
  const api = window.stationRelayEnrollment;
  const sessionApi = window.stationApplicationChannel;
  const state = window.stationFreshRelayEnrollment;
  if (!api || !sessionApi || !state)
    throw new Error('Missing fresh relay enrollment state');
  const enrollmentRequestHeaderEvidence = state.requestHeaderEvidence;
  const post = async (path, body) => {
    const headers = new Headers({
      Origin: state.clientOrigin,
      'Content-Type': 'application/json',
    });
    enrollmentRequestHeaderEvidence.push([...headers.keys()].sort());
    if (headers.has('authorization') || headers.has('cookie'))
      throw new Error('Fresh relay request attempted an existing credential');
    const response = await state.transport(`${state.apiBase}${path}`, {
      method: 'POST',
      headers: Object.fromEntries(headers.entries()),
      body: JSON.stringify(body),
      credentials: 'omit',
      redirect: 'error',
      timeoutMs: 15000,
    });
    return { status: response.status, body: await response.json() };
  };
  const finalizeProof = await api.createRelayEnrollmentFinalizeProof(
    state.key,
    state.challenge,
    {
      method: 'POST',
      url: `${state.apiBase}${api.RELAY_ENROLLMENT_CLIENT_PATHS.finalize}`,
      clientOrigin: state.clientOrigin,
    },
  );
  const finalized = await post(api.RELAY_ENROLLMENT_CLIENT_PATHS.finalize, {
    enrollmentId: state.challenge.enrollmentId,
    proof: finalizeProof,
  });
  if (finalized.status !== 200 || finalized.body.state !== 'delivered')
    throw new Error(`Fresh relay finalize refused: ${finalized.status}`);
  const delivery = finalized.body;
  if (
    delivery.enrollmentId !== state.challenge.enrollmentId ||
    delivery.bundle.stationId !== state.stationId ||
    delivery.bundle.deviceId !== delivery.bundle.continuation.deviceId ||
    delivery.bundle.continuation.clientOrigin !== state.clientOrigin
  )
    throw new Error('Fresh relay delivered bundle binding mismatch');
  const client = new sessionApi.ApplicationSessionClient(
    state.apiBase,
    state.stationId,
    state.clientOrigin,
    { requireCredential: true, timeoutMs: 15000 },
    state.key,
  );
  const resourceUrl = `${state.apiBase}/api/account-auth/session`;
  const headers = await client.headers(delivery.bundle.continuation, {
    method: 'GET',
    url: resourceUrl,
  });
  const beforeAck = await state.transport(resourceUrl, {
    method: 'GET',
    headers: {
      ...headers,
      Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
    },
    credentials: 'omit',
    redirect: 'error',
    timeoutMs: 15000,
  });
  if (beforeAck.status !== 401)
    throw new Error(
      `Pending Device/continuation became active before ACK: ${beforeAck.status}`,
    );

  const activationProof = await api.createRelayEnrollmentActivationProof(
    state.key,
    state.challenge,
    delivery,
    {
      method: 'POST',
      url: `${state.apiBase}${api.RELAY_ENROLLMENT_CLIENT_PATHS.activate}`,
      clientOrigin: state.clientOrigin,
    },
  );
  const ack = await post(api.RELAY_ENROLLMENT_CLIENT_PATHS.activate, {
    enrollmentId: delivery.enrollmentId,
    activationNonce: delivery.activationNonce,
    deviceId: delivery.bundle.deviceId,
    authorityKey: delivery.bundle.continuation.authorityKey,
    bundleDigest: delivery.bundleDigest,
    proof: activationProof,
  });
  if (ack.status !== 200 || ack.body.state !== 'active')
    throw new Error(`Fresh relay activation refused: ${ack.status}`);
  const afterAckHeaders = await client.headers(delivery.bundle.continuation, {
    method: 'GET',
    url: resourceUrl,
  });
  const afterAck = await state.transport(resourceUrl, {
    method: 'GET',
    headers: {
      ...afterAckHeaders,
      Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
    },
    credentials: 'omit',
    redirect: 'error',
    timeoutMs: 15000,
  });
  if (afterAck.status !== 200)
    throw new Error(
      `Fresh relay account did not become usable after ACK: ${afterAck.status}`,
    );
  const self = await afterAck.json();
  if (self.data?.principal?.id !== delivery.bundle.continuation.principal.id)
    throw new Error('Fresh relay active account principal binding mismatch');
  window.stationFreshRelayActiveAccount = {
    state,
    bundle: delivery.bundle,
  };
  window.stationFreshRelayEnrollment = undefined;
  const finalHeaders = new Headers({
    ...afterAckHeaders,
    Authorization: `Bearer ${delivery.bundle.deviceCredential}`,
  });
  if (finalHeaders.has('cookie'))
    throw new Error('Fresh relay account resource request attached a cookie');
  return {
    status: 'passed',
    enrollmentId: delivery.enrollmentId,
    deviceId: delivery.bundle.deviceId,
    principalId: self.data.principal.id,
    beforeAckStatus: beforeAck.status,
    afterAckStatus: afterAck.status,
    keyExtractable: state.key.privateKey.extractable,
    cookieJarEmpty: document.cookie === '',
    priorAccountStateAbsent: window.stationApplicationAccount === undefined,
    resourceHeaderNames: [...finalHeaders.keys()].sort(),
    enrollmentRequestHeaderEvidence,
  };
}

/** Recheck the newly activated Device after the prior Device is revoked. */
export async function browserFreshRelayProjectRead(input) {
  const active = window.stationFreshRelayActiveAccount;
  const sessionApi = window.stationApplicationChannel;
  if (!active || !sessionApi)
    throw new Error('Missing activated fresh relay Device');
  const { state, bundle } = active;
  const client = new sessionApi.ApplicationSessionClient(
    state.apiBase,
    state.stationId,
    state.clientOrigin,
    { requireCredential: true, timeoutMs: 15000 },
    state.key,
  );
  const url = `${state.apiBase}${input.path}`;
  const proofHeaders = await client.headers(bundle.continuation, {
    method: 'GET',
    url,
  });
  const headers = new Headers({
    ...proofHeaders,
    Authorization: `Bearer ${bundle.deviceCredential}`,
  });
  if (headers.has('cookie'))
    throw new Error('Fresh Device request attempted cookie adoption');
  const response = await state.transport(url, {
    method: 'GET',
    headers: Object.fromEntries(headers.entries()),
    credentials: 'omit',
    redirect: 'error',
    timeoutMs: 15000,
  });
  return { status: response.status, body: await response.text() };
}
