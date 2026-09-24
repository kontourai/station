// Owned Chromium profile helpers for the self-hosted broker lab journey.
// Browser-only functions, passed to Playwright for execution in owned profiles.
// They consume the production browser broker modules bundled into
// window.stationSelfHostedBroker by the lab controller. No mocked broker
// responses, no private auth injection: every broker call is a real fetch
// issued by the browser, so the browser emits the Origin header itself.
//
// Every function below is self-contained: Playwright serializes ONLY the
// passed function into the page, so no function may reference module-scope
// helpers. Shared construction (TURN server entries, credential providers)
// is inlined in each function body.

export async function browserBrokerConnect(input) {
  const api = window.stationSelfHostedBroker;
  if (!api) throw new Error('Missing self-hosted broker browser bundle');
  if (
    !window.stationConnectionTrustRecord ||
    !window.stationConnectionTrustStore
  )
    throw new Error('Missing independently admitted Station trust');
  if (!input.invitation)
    throw new Error('Broker lab requires a one-time client invitation');
  const credentials = new api.BrowserRoutingGrantCustody();
  await api.redeemBrokerRouteInvitation({
    invitation: input.invitation,
    trustRecord: window.stationConnectionTrustRecord,
    trustStore: window.stationConnectionTrustStore,
    custody: credentials,
    signal: AbortSignal.timeout(15_000),
  });
  // The real HTTP loopback broker origin is used for validation AND fetch:
  // never validate one origin then fetch a different one.
  const broker = new api.SelfHostedBrokerBrowserClient({
    brokerOrigin: input.brokerOrigin,
    browserOrigin: location.origin,
    scope: input.scope,
    credentials,
  });
  const ice = {
    current: true,
    capture() {
      return {
        configuration: {
          iceServers: [
            {
              urls: `turn:127.0.0.1:${input.port}?transport=${input.transport ?? 'tcp'}`,
              username: input.username,
              credential: input.password,
            },
          ],
          iceTransportPolicy: 'relay',
        },
        isCurrent: () => this.current,
      };
    },
  };
  let peer;
  const owner = api.createBrowserPionConnection({
    broker,
    applicationOrigin: input.applicationOrigin,
    trustRecord: window.stationConnectionTrustRecord,
    trustStore: window.stationConnectionTrustStore,
    ice,
    createPeer(configuration) {
      peer = new RTCPeerConnection(configuration);
      if (window.stationBrokerLab) window.stationBrokerLab.peer = peer;
      return peer;
    },
  });
  const signal = AbortSignal.timeout(45000);
  const snapshot = await owner.connect(signal);
  if (snapshot.applicationOrigin !== input.applicationOrigin)
    throw new Error('Broker transport application origin mismatch');
  window.stationBrokerLab = {
    owner,
    peer,
    snapshot,
    broker,
    credentials,
    ice,
    // Keep the one-use invitation and its secret out of the long-lived page
    // fixture after redemption. The live grant stays in its own custody owner.
    input: {
      brokerOrigin: input.brokerOrigin,
      scope: input.scope,
      applicationOrigin: input.applicationOrigin,
      port: input.port,
      username: input.username,
      password: input.password,
      transport: input.transport,
    },
  };
  return {
    connectionId: snapshot.connectionId,
    applicationOrigin: snapshot.applicationOrigin,
    routingGrantId: credentials.capture().id,
  };
}

export async function browserBrokerSelectedCandidatePair() {
  const peer = window.stationBrokerLab?.peer;
  if (!peer) throw new Error('Missing broker Pion peer');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const stats = await peer.getStats();
    let selected;
    for (const value of stats.values()) {
      if (
        value.type === 'candidate-pair' &&
        value.state === 'succeeded' &&
        (value.selected === true || value.nominated === true)
      ) {
        selected = value;
        if (value.selected === true) break;
      }
    }
    if (!selected) {
      const transport = [...stats.values()].find(
        (value) => value.type === 'transport' && value.selectedCandidatePairId,
      );
      selected = transport
        ? stats.get(transport.selectedCandidatePairId)
        : undefined;
    }
    const local = selected ? stats.get(selected.localCandidateId) : undefined;
    const remote = selected ? stats.get(selected.remoteCandidateId) : undefined;
    if (selected && local && remote)
      return {
        state: selected.state,
        localType: local.candidateType,
        remoteType: remote.candidateType,
      };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('No selected broker Pion candidate pair');
}

export async function browserBrokerReconnect() {
  const lab = window.stationBrokerLab;
  if (!lab) throw new Error('Missing broker lab connection');
  const previous = lab.snapshot ? lab.snapshot.connectionId : undefined;
  const previousPeer = lab.peer;
  try {
    const snapshot = await lab.owner.reconnect(AbortSignal.timeout(45000));
    lab.snapshot = snapshot;
    window.stationBrokerLabTransport = undefined;
    return {
      previous,
      connectionId: snapshot.connectionId,
      peerReplaced: lab.peer !== previousPeer,
    };
  } catch (error) {
    // A failed reconnect retires the owner: report no current owner rather
    // than a stale snapshot of a closed peer.
    lab.snapshot = undefined;
    window.stationBrokerLabTransport = undefined;
    throw error;
  }
}

export function browserBrokerAdmitApplicationTransport() {
  const api = window.stationSelfHostedBroker;
  const lab = window.stationBrokerLab;
  if (!api || !lab || !lab.snapshot)
    throw new Error('Missing broker lab connection');
  const admitted = api.createSelfHostedApplicationTransport({
    owner: lab.owner,
    snapshot: lab.snapshot,
    applicationOrigin: lab.input.applicationOrigin,
    signal: AbortSignal.timeout(300000),
  });
  window.stationBrokerLabTransport = admitted;
  return { connectionId: lab.snapshot.connectionId };
}

// Re-point the fixture SDK credential resolver at the newly admitted
// transport while keeping the CURRENT Device credential. No relogin, no
// bootstrap grant: the continuation stays bound to the existing Device.
export function browserBrokerAdoptApplicationTransport() {
  const api = window.stationApplicationChannel;
  const state = window.stationApplicationAccount;
  const current = window.stationBrokerLabTransport;
  if (!api || !state || !current)
    throw new Error('Missing broker lab transport adoption state');
  api.setClientCredentialResolver(() => ({
    origin: state.input.apiBase,
    credential: state.input.credential,
    transport: current.transport,
    transportBindingIsCurrent: current.transportBindingIsCurrent,
  }));
  return {
    connectionId: window.stationBrokerLab?.snapshot?.connectionId,
  };
}

export function browserBrokerClose() {
  const transport = window.stationBrokerLabTransport;
  const lab = window.stationBrokerLab;
  transport?.close();
  lab?.owner.close();
  lab?.credentials?.invalidate();
  if (lab?.ice) lab.ice.current = false;
  window.stationBrokerLabTransport = undefined;
  window.stationBrokerLab = undefined;
  return { closed: true };
}

// Real CORS + credential checks from the admitted page origin. The browser
// emits Origin; nothing here sets a forbidden Origin header and no explicit
// OPTIONS preflight is issued here: the non-simple POST below triggers the
// real browser preflight, which the owned Node broker listener observes.
export async function browserBrokerProbeOrigin(input) {
  const credential = window.stationBrokerLab?.credentials?.capture();
  if (!credential) throw new Error('Missing client-owned broker grant');
  const headers = {
    Authorization: `Bearer ${credential.secret}`,
    'Content-Type': 'application/json',
    'X-Broker-Credential-Id': credential.id,
  };
  const body = JSON.stringify({ scope: input.scope });
  const status = await fetch(
    `${input.brokerOrigin}/broker/v1/stations/status`,
    {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(15000),
    },
  );
  const allowOrigin = status.headers.get('access-control-allow-origin');
  const statusBody = await status.json();
  const wrong = await fetch(`${input.brokerOrigin}/broker/v1/stations/status`, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: 'Bearer ' + 'A'.repeat(43),
    },
    body,
    redirect: 'error',
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  const wrongBody = await wrong.json();
  return {
    pageOrigin: location.origin,
    status: status.status,
    statusBody,
    allowOrigin,
    wrongStatus: wrong.status,
    wrongBody,
  };
}

// Tamper refusal through the REAL production consumer: a fresh production
// browser owner is created with a fixed-endpoint request wrapper that
// fetches the REAL answer from the broker and alters ONLY the proof. The
// production owner (verify-then-accept) must reject before any remote
// description is set. The owned peer is always closed.
export async function browserBrokerTamperProof() {
  const api = window.stationSelfHostedBroker;
  const lab = window.stationBrokerLab;
  if (!api || !lab || !lab.snapshot)
    throw new Error('Missing broker lab connection');
  const tamperState = { tampered: false };
  const tamperingRequest = async (url, init) => {
    const target = String(url);
    const response = await fetch(target, init);
    if (!target.endsWith('/broker/v1/connections/read')) return response;
    const payload = await response
      .clone()
      .json()
      .catch(() => null);
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.answerSdp !== 'string' ||
      typeof payload.stationProof !== 'string' ||
      !payload.stationProof
    )
      return response;
    const proof = payload.stationProof;
    const altered =
      proof.slice(0, -2) +
      (proof.slice(-2, -1) === 'A' ? 'B' : 'A') +
      proof.slice(-1);
    if (altered === proof) return response;
    tamperState.tampered = true;
    return new Response(JSON.stringify({ ...payload, stationProof: altered }), {
      status: response.status,
      statusText: response.statusText,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const credentials = lab.credentials;
  const broker = new api.SelfHostedBrokerBrowserClient({
    brokerOrigin: lab.input.brokerOrigin,
    browserOrigin: location.origin,
    scope: lab.input.scope,
    credentials,
    request: tamperingRequest,
  });
  const ice = {
    current: true,
    capture() {
      return {
        configuration: {
          iceServers: [
            {
              urls: `turn:127.0.0.1:${lab.input.port}?transport=${lab.input.transport ?? 'tcp'}`,
              username: lab.input.username,
              credential: lab.input.password,
            },
          ],
          iceTransportPolicy: 'relay',
        },
        isCurrent: () => this.current,
      };
    },
  };
  let remoteDescriptionAttempted = false;
  const owner = api.createBrowserPionConnection({
    broker,
    applicationOrigin: lab.input.applicationOrigin,
    trustRecord: window.stationConnectionTrustRecord,
    trustStore: window.stationConnectionTrustStore,
    ice,
    createPeer(configuration) {
      const peer = new RTCPeerConnection(configuration);
      const acceptRemote = peer.setRemoteDescription.bind(peer);
      peer.setRemoteDescription = (...args) => {
        remoteDescriptionAttempted = true;
        return acceptRemote(...args);
      };
      return peer;
    },
  });
  let refused = '';
  try {
    await owner.connect(AbortSignal.timeout(45000));
  } catch (error) {
    refused = String(error?.message ?? error);
  } finally {
    owner.close();
  }
  if (!tamperState.tampered)
    throw new Error('Tamper wrapper never observed a real broker answer');
  return {
    tampered: tamperState.tampered,
    tamperedRefused: refused.length > 0,
    remoteDescriptionAttempted,
    refusal: refused,
  };
}

export async function browserBrokerReadStatus() {
  const lab = window.stationBrokerLab;
  if (!lab) throw new Error('Missing broker lab connection');
  return lab.broker.status(AbortSignal.timeout(15000));
}

// Reports the ACTUAL current owner: undefined when no live snapshot exists
// (including after a failed reconnect retired the peer).
export function browserBrokerConnectionId() {
  return window.stationBrokerLab?.snapshot?.connectionId;
}
