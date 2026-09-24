/** Capture only selected ICE candidate types from the real browser peer. */
export function installRelayCandidatePairRecorder() {
  const NativePeer = globalThis.RTCPeerConnection;
  if (typeof NativePeer !== 'function') return;

  const peers = [];
  globalThis.__stationRelaySelectedCandidatePair = async () => {
    for (const peer of peers) {
      const stats = await peer.getStats();
      let pair;
      for (const value of stats.values()) {
        if (
          value.type === 'candidate-pair' &&
          value.state === 'succeeded' &&
          (value.selected === true || value.nominated === true)
        ) {
          pair = value;
          if (value.selected === true) break;
        }
      }
      if (!pair) {
        const transport = [...stats.values()].find(
          (value) =>
            value.type === 'transport' && value.selectedCandidatePairId,
        );
        pair = transport
          ? stats.get(transport.selectedCandidatePairId)
          : undefined;
      }
      const local = pair ? stats.get(pair.localCandidateId) : undefined;
      const remote = pair ? stats.get(pair.remoteCandidateId) : undefined;
      if (local?.candidateType && remote?.candidateType)
        return {
          localType: local.candidateType,
          remoteType: remote.candidateType,
        };
    }
    return null;
  };

  globalThis.RTCPeerConnection = new Proxy(NativePeer, {
    construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      peers.push(peer);
      return peer;
    },
  });
}
