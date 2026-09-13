// Browser-only functions, passed to Playwright for execution in owned profiles.
// Keeping them here avoids changing Node's ambient HTTP types with DOM globals.
export async function browserOffer({
  port,
  username,
  password,
  transport = 'tcp',
}) {
  const peer = new RTCPeerConnection({
    iceServers: [
      {
        urls: `turn:127.0.0.1:${port}?transport=${transport}`,
        username,
        credential: password,
      },
    ],
    iceTransportPolicy: 'relay',
  });
  const channel = peer.createDataChannel('station-lab-v1');
  if (!window.stationConnectionProof || !window.stationConnectionTrust)
    throw new Error('Missing independently admitted Station trust');
  const lab = {
    peer,
    channel,
    messages: [],
    clientNonce: window.stationConnectionProof.newNonce(),
    connectionId: crypto.randomUUID(),
    proofConsumed: false,
    proofInFlight: false,
    localDescription: '',
  };
  window.stationTransportLab = lab;
  channel.onmessage = (event) => lab.messages.push(String(event.data));
  const gathered = new Promise((resolve) => {
    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState === 'complete') resolve();
    };
  });
  await peer.setLocalDescription(await peer.createOffer());
  if (peer.iceGatheringState !== 'complete') await gathered;
  if (!peer.localDescription) throw new Error('Missing browser offer');
  lab.localDescription = peer.localDescription.sdp;
  return { sdp: peer.localDescription.sdp, type: peer.localDescription.type };
}

export function browserSetConnectionTrust(trust) {
  // Called only by the owned fixture controller, not a signaling message.
  window.stationConnectionTrust = Object.freeze({
    ...trust,
    signingKey: Object.freeze({ ...trust.signingKey }),
  });
}

export function browserConnectionContext() {
  const { clientNonce, connectionId } = window.stationTransportLab;
  return { clientNonce, connectionId };
}

export async function browserAccept({ sdp, pin, candidates, proof }) {
  const lab = window.stationTransportLab;
  if (lab.proofConsumed || lab.proofInFlight)
    throw new Error('Connection proof already consumed or pending');
  const trust = window.stationConnectionTrust;
  const api = window.stationConnectionProof;
  lab.proofInFlight = true;
  try {
    const localFingerprint = lab.localDescription
      .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
      ?.trim();
    const stationFingerprint = sdp
      .match(/^a=fingerprint:sha-256 (.+)$/m)?.[1]
      ?.trim();
    const expected = {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      generation: trust.generation,
      connectionId: lab.connectionId,
      clientNonce: lab.clientNonce,
      clientFingerprint: localFingerprint,
      stationFingerprint,
      offerSha256: await api.connectionDescriptionDigest(lab.localDescription),
      answerSha256: await api.connectionDescriptionDigest(sdp),
    };
    const verifier = api.createStationConnectionProofVerifier({
      trust,
      expected,
      isCurrent: () =>
        window.stationConnectionTrust === trust &&
        window.stationTransportLab === lab &&
        !lab.proofConsumed,
    });
    await verifier.verifyAndConsume(proof);
    lab.proofConsumed = true;
  } finally {
    lab.proofInFlight = false;
  }
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (value) => value[1].trim(),
  );
  if (!fingerprints.length || fingerprints.some((value) => value !== pin))
    throw new Error('station_fingerprint_not_approved');
  if (
    candidates.some(
      ({ candidate }) => !sdp.split(/\r?\n/).includes(`a=${candidate}`),
    )
  )
    throw new Error('unsigned_ice_candidate');
  const { peer } = window.stationTransportLab;
  await peer.setRemoteDescription({ type: 'answer', sdp });
  for (const candidate of candidates) await peer.addIceCandidate(candidate);
}

export function browserChannelOpen() {
  return window.stationTransportLab.channel.readyState === 'open';
}
export function browserSend(value) {
  window.stationTransportLab.channel.send(value);
}
export function browserReceived(value) {
  return window.stationTransportLab.messages.includes(value);
}
export function browserFailed() {
  return window.stationTransportLab.peer.connectionState === 'failed';
}
export async function browserStats() {
  const result = [];
  const stats = await window.stationTransportLab.peer.getStats();
  stats.forEach((value) => {
    if (['transport', 'candidate-pair', 'certificate'].includes(value.type))
      result.push(value);
  });
  return result;
}
