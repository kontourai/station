// The SDK/transport runs in the real browser. This fixture has no account API.
export async function browserCheckApplicationChannel() {
  const api = window.stationApplicationChannel;
  const peer = window.stationTransportLab.peer;
  if (
    !window.stationTransportLab.proofConsumed ||
    peer.connectionState !== 'connected'
  )
    throw new Error('Application fixture requires an admitted encrypted peer');
  const origin = 'https://fixture-station.invalid';
  const lifetime = new AbortController();
  const current = () =>
    !lifetime.signal.aborted && peer.connectionState === 'connected';
  const transport = api.createApplicationChannelFetch({
    origin,
    signal: lifetime.signal,
    assertCurrent: async () => {
      if (
        !current() ||
        !(await window.stationConnectionTrustStore.isCurrent(
          window.stationConnectionTrustRecord,
        ))
      )
        throw new Error('Station endpoint trust changed');
    },
    open: (signal) =>
      new Promise((resolve, reject) => {
        const channel = peer.createDataChannel(
          'station-application-protocol-fixture',
          { ordered: true },
        );
        const cleanup = () => {
          signal.removeEventListener('abort', aborted);
          channel.removeEventListener('open', opened);
          channel.removeEventListener('error', failed);
          channel.removeEventListener('close', failed);
        };
        const failed = () => {
          cleanup();
          channel.close();
          reject(new Error('Application channel failed to open'));
        };
        const aborted = () => failed();
        const opened = () => {
          cleanup();
          resolve(api.browserApplicationChannel(channel));
        };
        signal.addEventListener('abort', aborted, { once: true });
        channel.addEventListener('open', opened, { once: true });
        channel.addEventListener('error', failed, { once: true });
        channel.addEventListener('close', failed, { once: true });
        if (signal.aborted) failed();
      }),
  });
  api.setClientCredentialResolver(() => ({
    origin,
    transport,
    transportBindingIsCurrent: current,
  }));
  try {
    const requestMarker = `sdk-request-${crypto.randomUUID()}`;
    const response = await api.authenticatedFetch(`${origin}/fixture/payload`, {
      method: 'POST',
      body: requestMarker,
      headers: { Origin: location.origin },
      timeoutMs: 15000,
    });
    if (response.headers.get('X-Fixture-Client-Origin') !== location.origin)
      throw new Error(
        'Actual browser origin was lost across virtual transport',
      );
    if (response.status !== 200)
      throw new Error('Application protocol response refused');
    const text = await response.text();
    if (text !== requestMarker.repeat(512))
      throw new Error('Application protocol streamed bytes changed');
    return {
      status: 'passed',
      requestMarker,
      responseBytes: new TextEncoder().encode(text).byteLength,
    };
  } finally {
    lifetime.abort();
    api.setClientCredentialResolver(undefined);
  }
}
