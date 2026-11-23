import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  PUBLIC_STATION_HANDSHAKE_PATH,
  REMOTE_AUTH_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { afterEach, expect, test, vi } from 'vitest';
import {
  cancelCliSessionGroup,
  createCliSessionGroup,
  getCliSessionGroup,
  listCliSessionGroups,
  parseCliSessionGroupInput,
  runCliSessionGroup,
  syncCliSessionGroup,
} from '../client/cli-session-groups';
import { resetPublicStationCapabilities } from '../client/publicStationCapabilities';

const apiBase = 'http://station-groups.test';
const handshakeUrl = `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`;
const groupsUrl = `${apiBase}/api/orchestration/session-groups`;

function handshake(enabled: boolean) {
  return Response.json({
    schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
    environmentId: 'group-station',
    authentication: {
      scheme: 'bearer',
      protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    transports: {
      http: REMOTE_AUTH_PROTOCOL_VERSION,
      sse: REMOTE_AUTH_PROTOCOL_VERSION,
      websocket: REMOTE_AUTH_PROTOCOL_VERSION,
    },
    compatibility: {
      serverVersion: '1.0.0',
      protocolVersion: 1,
      minClientProtocol: 1,
    },
    capabilities: enabled ? { cliSessionGroups: true } : {},
  });
}

function input() {
  return parseCliSessionGroupInput({
    operationId: 'operation-one',
    maxConcurrent: 1,
    maxDispatches: 0,
    deadlineAt: 2_000_000_000_000,
    members: [
      {
        seatId: 'seat-one',
        prompt: 'Inspect the Task',
        target: {
          agent: 'reviewer',
          expectedEngine: { kind: 'connection', connectionId: 'claude' },
        },
      },
    ],
  });
}

afterEach(() => {
  resetPublicStationCapabilities();
  vi.unstubAllGlobals();
});

test('a Station without the Session groups capability is never sent a group mutation', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe(handshakeUrl);
    return handshake(false);
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(createCliSessionGroup(apiBase, input())).rejects.toThrow(
    'does not support the Session groups preview',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

function groupView() {
  return {
    version: 'station.cli-session-group/v1',
    groupId: 'group-one',
    revision: 1,
    supervision: 'not-running',
    cancelled: false,
    deadlineAt: 2_000_000_000_000,
    maxConcurrent: 1,
    maxDispatches: 0,
    dispatchCount: 0,
    admissionClosed: 'dispatch-limit-exhausted',
    guarantees: {
      authority: 'station-session',
      portableFlowLineage: 'unbound',
      dollarCap: 'unavailable',
      tokenCap: 'unavailable',
      physicalAttemptCap: 'unavailable',
      deadline: 'stop-admission-and-request-interruption',
    },
    flow: null,
    acceptance: 'unassessed',
    members: [{ seatId: 'seat-one', needs: [], state: 'pending' }],
  };
}

test('group requests use the advertised API and retain the zero-dispatch receipt', async () => {
  const view = groupView();
  const requested: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === handshakeUrl) return handshake(true);
    requested.push({
      url: String(url),
      method: init?.method ?? 'GET',
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return Response.json({ success: true, data: view });
  });
  vi.stubGlobal('fetch', fetchMock);

  expect(await createCliSessionGroup(apiBase, input())).toEqual(view);
  expect(await getCliSessionGroup(apiBase, view.groupId)).toEqual(view);
  expect(await runCliSessionGroup(apiBase, view.groupId)).toEqual(view);
  expect(await cancelCliSessionGroup(apiBase, view.groupId)).toEqual(view);
  const groupUrl = `${groupsUrl}/${view.groupId}`;
  expect(requested).toEqual([
    { url: groupsUrl, method: 'POST', body: input() },
    { url: groupUrl, method: 'GET' },
    { url: `${groupUrl}/run`, method: 'POST', body: {} },
    { url: `${groupUrl}/cancel`, method: 'POST', body: {} },
  ]);
});

test('listing encodes the cursor and handles a Station that only has the original group routes', async () => {
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    if (String(url) === handshakeUrl) return handshake(true);
    expect(String(url)).toBe(`${groupsUrl}?afterGroupId=group%3Aprevious`);
    return new Response('404 Not Found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    listCliSessionGroups(apiBase, { afterGroupId: 'group:previous' }),
  ).rejects.toThrow('Enable the preview on an updated personal Station');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('sync binds the returned receipt to its operation and opts in to receipt inspection', async () => {
  const view = groupView();
  const sent = {
    operationId: 'sync-one',
    runId: 'fold-one',
    content: 'Folded result',
    deadlineAt: 2_000_000_000_000,
  };
  const receipt = {
    operationId: sent.operationId,
    runId: sent.runId,
    contentHash: `sha256:${'a'.repeat(64)}`,
    timestamp: '2026-09-01T12:00:00.000Z',
    status: 'acknowledged',
    members: [
      {
        seatId: 'seat-one',
        attempts: 1,
        status: 'acknowledged',
        turnId: 'turn-one',
        terminalEventId: 'event-one',
        nativeIdentityHash: `sha256:${'b'.repeat(64)}`,
        toolCalls: 0,
      },
    ],
  };
  let wrongOperation = false;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === handshakeUrl) return handshake(true);
    if (String(url) === `${groupsUrl}/${view.groupId}/sync`) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual(sent);
      return Response.json({
        success: true,
        data: {
          ...view,
          contextSync: wrongOperation
            ? { ...receipt, operationId: 'sync-other' }
            : receipt,
        },
      });
    }
    expect(String(url)).toBe(
      `${groupsUrl}/${view.groupId}?includeContextSync=1`,
    );
    return Response.json({
      success: true,
      data: { ...view, contextSync: receipt },
    });
  });
  vi.stubGlobal('fetch', fetchMock);

  expect(
    (await syncCliSessionGroup(apiBase, view.groupId, sent)).contextSync,
  ).toEqual(receipt);
  expect(
    (
      await getCliSessionGroup(apiBase, view.groupId, {
        includeContextSync: true,
      })
    ).contextSync,
  ).toEqual(receipt);
  wrongOperation = true;
  await expect(
    syncCliSessionGroup(apiBase, view.groupId, sent),
  ).rejects.toThrow('Unexpected Session-group sync receipt');
});
