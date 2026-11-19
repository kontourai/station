import type { FetchSseConnection } from '@kontourai/station-sdk';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

export function ownSseFixture(
  connections: Map<FetchSseConnection, { settled: boolean }>,
) {
  const releases: (() => void)[] = [];
  afterEach(async () => {
    try {
      cleanup();
      for (const release of releases.splice(0).reverse()) release();
      const streams = [...connections];
      expect(
        streams.filter(
          ([stream, state]) => !state.settled && !stream.signal.aborted,
        ),
        'fixture teardown left a protected SSE transport running',
      ).toHaveLength(0);
      await Promise.all(streams.map(([stream]) => stream.completed));
    } finally {
      for (const stream of connections.keys()) stream.close();
      await Promise.allSettled(
        [...connections.keys()].map((stream) => stream.completed),
      );
      connections.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  return (release: () => void) => {
    releases.push(release);
    return release;
  };
}

export function observeSseFixture(
  connections: Map<FetchSseConnection, { settled: boolean }>,
  stream: FetchSseConnection,
): FetchSseConnection {
  const state = { settled: false };
  connections.set(stream, state);
  const settle = () => {
    state.settled = true;
  };
  void stream.completed.then(settle, settle);
  return stream;
}
