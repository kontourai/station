// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { setClientCredentialResolver } from '../client/http';
import { resetPublicStationCapabilities } from '../publicStationCapabilities.js';
import { useSessionInventoryInput } from '../session-inventory.js';

vi.mock('../api', () => ({
  _getApiBase: vi.fn().mockResolvedValue('http://station.test'),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  setClientCredentialResolver(undefined);
  resetPublicStationCapabilities();
});

/** Real sessions carry colon-shaped ids. */
const SESSION = 'station:1792851837813:session:b1f09152';
const EVENT = 'cfdf1d72-fadb-4c41-8017-83c33baa7dfb';
const TURN = '01a16ec6-013e-76f1-a428-0b40e94b72cb';

/**
 * The public handshake a host on nightly 0.1.11-nightly.2488.1 actually
 * served (captured from a running install; environment id replaced). It
 * predates the input route, and its protocol numbers equal the current
 * build's, so only the capability flag can tell the two apart.
 */
const HOST_WITHOUT_INPUT_READ = {
  schemaVersion: 1,
  environmentId: '00000000-0000-4000-8000-000000000000',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.1.11',
    protocolVersion: 3,
    minClientProtocol: 1,
    capabilities: {
      productTelemetryAcknowledgement: 2,
      remoteAuth: 1,
      devicePairing: 1,
      environmentProof: 1,
      clientProtocolHeader: 1,
    },
  },
  capabilities: {
    sshEnvironments: true,
    webPushNotifications: true,
    eventStreamResume: true,
    sessionEventWindow: true,
    scopedPairing: true,
    portableExecutionOffers: true,
    delegationAttemptClaims: true,
    executionPreparation: true,
    fleetInference: true,
    delegatedInputAnswers: true,
  },
};
const HOST_WITH_INPUT_READ = {
  ...HOST_WITHOUT_INPUT_READ,
  capabilities: {
    ...HOST_WITHOUT_INPUT_READ.capabilities,
    sessionInventoryInputRead: true,
  },
};

function respond(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A Station that serves `handshake` publicly. Like the 2488.1 host, the input
 * path is answered only when the host has the route; otherwise it is the
 * same non-disclosing 404 a denied read gets.
 */
function station(handshake: unknown | 'unreachable') {
  const inputReads: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === '/.well-known/station/v1') {
      if (handshake === 'unreachable') throw new TypeError('Failed to fetch');
      return respond(200, handshake);
    }
    if (url.pathname.includes('/inputs/')) {
      inputReads.push(url.pathname);
      const served =
        handshake === 'unreachable' ||
        (handshake as typeof HOST_WITH_INPUT_READ).capabilities
          .sessionInventoryInputRead === true;
      return served
        ? respond(200, {
            success: true,
            data: {
              sessionId: SESSION,
              eventId: EVENT,
              turnId: TURN,
              input: {
                inputKind: 'initial',
                prompt: 'Continue',
                attachments: [],
              },
            },
          })
        : respond(404, { success: false, error: 'Not Found' });
    }
    throw new Error(`unexpected request ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetch);
  return { inputReads };
}

function mountInput() {
  const requestScope = {
    apiBase: 'http://station.test',
    authorityKey: 'epoch-a',
  };
  setClientCredentialResolver(() => ({
    origin: requestScope.apiBase,
    requestAuthority: { ...requestScope, isCurrent: () => true },
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client }, children);
  const observer = renderHook(
    () => useSessionInventoryInput(SESSION, EVENT, TURN, requestScope),
    { wrapper },
  );
  return { observer, client };
}

describe('session inventory input read against hosts of different versions', () => {
  test('a host that predates the input read is named unsupported and never asked', async () => {
    const host = station(HOST_WITHOUT_INPUT_READ);
    const { observer, client } = mountInput();
    await waitFor(() =>
      expect(observer.result.current.hostSupport).toBe('unsupported'),
    );
    // The read is disabled before the handshake answers and stays disabled
    // after it: nothing is in flight and nothing was sent.
    expect(observer.result.current.fetchStatus).toBe('idle');
    expect(host.inputReads).toEqual([]);
    expect(observer.result.current.error).toBeNull();
    expect(observer.result.current.data).toBeUndefined();
    observer.unmount();
    client.clear();
  });

  test('a host that advertises the read serves the authored input', async () => {
    const host = station(HOST_WITH_INPUT_READ);
    const { observer, client } = mountInput();
    await waitFor(() =>
      expect(observer.result.current.data?.prompt).toBe('Continue'),
    );
    expect(observer.result.current.hostSupport).toBe('supported');
    expect(host.inputReads).toHaveLength(1);
    observer.unmount();
    client.clear();
  });

  test('an unreadable handshake leaves support unknown and still attempts the read', async () => {
    const host = station('unreachable');
    const { observer, client } = mountInput();
    await waitFor(() =>
      expect(observer.result.current.data?.prompt).toBe('Continue'),
    );
    expect(observer.result.current.hostSupport).toBe('unknown');
    expect(host.inputReads).toHaveLength(1);
    observer.unmount();
    client.clear();
  });
});
