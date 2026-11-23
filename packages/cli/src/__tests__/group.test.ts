import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  PUBLIC_STATION_HANDSHAKE_PATH,
  REMOTE_AUTH_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { runCli } from '../cli';

const temporary = trackTempDirs();

afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    admissionClosed: 'dispatch-limit-exhausted',
    dispatchCount: 0,
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
    members: [{ seatId: 'one', needs: [], state: 'pending' }],
  };
}

test('the registered Session group command sends only its group read with the selected credential', async () => {
  const apiBase = 'https://session-group-cli.test';
  const calls: { url: string; authorization: string | null }[] = [];
  const view = groupView();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      calls.push({
        url: path,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      if (path === `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`)
        return groupHandshake();
      return Response.json({ success: true, data: view });
    }),
  );
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await runCli([
    'group',
    'session-get',
    'group-one',
    `--api-base=${apiBase}`,
    '--credential=fixture',
    '--json',
  ]);

  expect(calls).toEqual([
    { url: `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`, authorization: null },
    {
      url: `${apiBase}/api/orchestration/session-groups/group-one`,
      authorization: 'Bearer fixture',
    },
  ]);
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual(view);
});

function groupHandshake() {
  return Response.json({
    schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
    environmentId: 'session-group-station',
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
    capabilities: { cliSessionGroups: true },
  });
}

test('the registered sync command submits its bounded file once with the selected credential', async () => {
  const apiBase = 'https://session-group-sync-cli.test';
  const file = join(temporary('station-cli-group-sync-'), 'sync.json');
  const sent = {
    operationId: 'sync-one',
    runId: 'fold-one',
    content: 'Folded result',
    deadlineAt: 2_000_000_000_000,
  };
  writeFileSync(file, JSON.stringify(sent));

  const view = {
    ...groupView(),
    admissionClosed: undefined,
    maxDispatches: 1,
    dispatchCount: 1,
    members: [
      {
        seatId: 'one',
        needs: [],
        state: 'terminal',
        outcome: 'completed',
        handle: {
          taskId: 'task-one',
          conversationId: 'conversation-one',
          sessionId: 'session-one',
          initialTurnId: 'initial-turn',
        },
        terminalEvent: { turnId: 'initial-turn', eventId: 'initial-event' },
      },
    ],
    contextSync: {
      operationId: sent.operationId,
      runId: sent.runId,
      contentHash: `sha256:${'a'.repeat(64)}`,
      timestamp: '2026-09-01T12:00:00.000Z',
      status: 'acknowledged',
      members: [
        {
          seatId: 'one',
          attempts: 1,
          status: 'acknowledged',
          turnId: 'sync-turn',
          terminalEventId: 'sync-event',
          nativeIdentityHash: `sha256:${'b'.repeat(64)}`,
          toolCalls: 0,
        },
      ],
    },
  };
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path === `${apiBase}${PUBLIC_STATION_HANDSHAKE_PATH}`)
        return groupHandshake();
      paths.push(path);
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer fixture',
      );
      if (init?.method === 'POST')
        expect(JSON.parse(String(init.body))).toEqual(sent);
      return Response.json({ success: true, data: view });
    }),
  );
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const target = [`--api-base=${apiBase}`, '--credential=fixture', '--json'];
  await runCli([
    'group',
    'session-sync',
    'group-one',
    `--file=${file}`,
    ...target,
  ]);
  expect(JSON.parse(String(output.mock.calls[0]?.[0])).contextSync).toEqual(
    view.contextSync,
  );
  await runCli([
    'group',
    'session-get',
    'group-one',
    '--include-context-sync',
    ...target,
  ]);
  expect(JSON.parse(String(output.mock.calls[1]?.[0])).contextSync).toEqual(
    view.contextSync,
  );
  expect(paths).toEqual([
    `${apiBase}/api/orchestration/session-groups/group-one/sync`,
    `${apiBase}/api/orchestration/session-groups/group-one?includeContextSync=1`,
  ]);
});
