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
  const lab = { peer, channel, messages: [] };
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
  return { sdp: peer.localDescription.sdp, type: peer.localDescription.type };
}

export async function browserAccept({ sdp, pin, candidates }) {
  const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (value) => value[1].trim(),
  );
  if (!fingerprints.length || fingerprints.some((value) => value !== pin))
    throw new Error('station_fingerprint_not_approved');
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
