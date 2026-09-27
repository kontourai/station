import { createNativeDiagnosticEchoClient } from '@kontourai/station-connect/native-diagnostic-echo';
import { createNativeDiagnosticEchoBridge } from '../../src-ui/src/platform/native/nativeDiagnosticEchoBridge';

export interface NativeDiagnosticEchoShellInput {
  profileName: string;
  profileRevision: number;
  turnPort: number;
  turnUsername: string;
  turnPassword: string;
  tamperProof: boolean;
}

/** Test-only runner bundled into a WebDriver script for the real main WebView. */
export async function runNativeDiagnosticEchoShellAttempt(
  input: NativeDiagnosticEchoShellInput,
) {
  const bridge = await createNativeDiagnosticEchoBridge(
    input.profileName,
    input.profileRevision,
  );
  let remoteDescriptionCalls = 0;
  const sentMessages: string[] = [];
  const createdChannels: string[] = [];
  let localOfferSdp = '';
  const signaling = Object.freeze({
    ...bridge.signaling,
    async read(...args: Parameters<typeof bridge.signaling.read>) {
      const answer = await bridge.signaling.read(...args);
      return input.tamperProof && answer.stationProof
        ? { ...answer, stationProof: `${answer.stationProof}tampered` }
        : answer;
    },
  });
  const client = createNativeDiagnosticEchoClient({
    ...bridge,
    signaling,
    configuration: {
      iceServers: [
        {
          urls: `turn:127.0.0.1:${input.turnPort}?transport=tcp`,
          username: input.turnUsername,
          credential: input.turnPassword,
        },
      ],
      iceTransportPolicy: 'relay',
    },
    createPeer(configuration) {
      const peer = new RTCPeerConnection(configuration);
      return new Proxy(peer, {
        get(target, property) {
          if (property === 'setRemoteDescription')
            return async (description: RTCSessionDescriptionInit) => {
              remoteDescriptionCalls += 1;
              return await target.setRemoteDescription(description);
            };
          if (property === 'localDescription') {
            const description = target.localDescription;
            if (description?.sdp) localOfferSdp = description.sdp;
            return description;
          }
          if (property === 'setLocalDescription')
            return async (description?: RTCLocalSessionDescriptionInit) => {
              await target.setLocalDescription(description);
              if (target.localDescription?.sdp)
                localOfferSdp = target.localDescription.sdp;
            };
          if (property === 'createDataChannel')
            return (label: string, options?: RTCDataChannelInit) => {
              createdChannels.push(label);
              const channel = target.createDataChannel(label, options);
              return new Proxy(channel, {
                get(channelTarget, channelProperty) {
                  if (channelProperty === 'send')
                    return (data: string) => {
                      sentMessages.push(data);
                      return channelTarget.send(data);
                    };
                  const value = Reflect.get(
                    channelTarget,
                    channelProperty,
                    channelTarget,
                  );
                  return typeof value === 'function'
                    ? value.bind(channelTarget)
                    : value;
                },
              });
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, property, value) {
          return Reflect.set(target, property, value, target);
        },
      });
    },
  });

  try {
    const result = await client.run(new AbortController().signal);
    return {
      status: 'resolved' as const,
      result,
      remoteDescriptionCalls,
      sentMessages,
      createdChannels,
      usedRelayCandidate: / typ relay(?:\s|\r?$)/m.test(localOfferSdp),
    };
  } catch (error) {
    const failure = error as Error & { code?: string };
    return {
      status: 'rejected' as const,
      failure: failure.code ?? failure.message ?? String(error),
      remoteDescriptionCalls,
      sentMessages,
      createdChannels,
      usedRelayCandidate: / typ relay(?:\s|\r?$)/m.test(localOfferSdp),
    };
  }
}
