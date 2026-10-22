/** @vitest-environment jsdom */
import { webcrypto } from 'node:crypto';
import {
  APPLICATION_SESSION_PROOF_HEADER,
  APPLICATION_SESSION_VERSION,
} from '@kontourai/station-contracts/application-session';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _setApiBase } from '../api-core';
import { cancelActionOperation } from '../client/action-operations';
import {
  ApplicationSessionClient,
  createApplicationSessionKey,
} from '../client/application-session';
import { cancelAttachmentStage } from '../client/attachment-staging';
import {
  interruptDelegatedTask,
  respondToDelegatedTaskRequest,
  stopProviderTask,
} from '../client/delegations';
import {
  cancelConversationContextBoundary,
  cancelConversationInboxEntry,
} from '../client/execution';
import {
  StationReadOnlyError,
  setClientCredentialResolver,
} from '../client/http';
import { interruptTurn, respondToRequest } from '../client/orchestration';
import { cancelPeerEnrollment } from '../client/peer-enrollments';
import { changeProjectAccess } from '../client/project-access';
import { commandProjectTaskRoomLive } from '../client/project-task-rooms';
import { deleteProject } from '../client/projects';
import { revokeSecretBinding } from '../client/secret-bindings';
import { useCancelDeviceCodeLoginMutation } from '../device-code-login';
import { useEngineAccountLoginMutation } from '../engine-accounts';
import { useRevokeAnswerShareMutation } from '../query-domains/answerShares';
import {
  interruptOrchestrationTurn,
  resolveOrchestrationRequest,
} from '../query-domains/chatRuntimeOrchestration';
import { revokePluginPermissions } from '../query-domains/plugin-mutations';
import { revokeWorkspaceHomeRoleGrant } from '../query-domains/plugin-queries';
import { useDisconnectSshEnvironmentMutation } from '../query-domains/sshEnvironments';
import {
  revokeOwnAccessToken,
  revokeStationPersonToken,
} from '../query-domains/stationPeople';
import { denyRelayDevice, revokeRelaySetup } from '../relay-management';

const base = 'https://station.example.test';
const scope = { apiBase: base, authorityKey: 'account-1' };
const membershipScope = {
  localProjectSlug: 'project',
  stationId: 'station',
  localProjectId: 'local-project',
  portableProjectId: 'portable-project',
};
const reached = new Error('recovered transport reached');
const transport = vi.fn<typeof fetch>();
let authorityCurrent: boolean;
const clients: QueryClient[] = [];
beforeEach(() => {
  authorityCurrent = true;
  _setApiBase(base);
  transport.mockReset().mockRejectedValue(reached);
  setClientCredentialResolver(() => ({
    origin: base,
    requestAuthority: { ...scope, isCurrent: () => authorityCurrent },
    transport,
    mutationAllowed: () => {
      throw new TypeError('Previous transient outage');
    },
  }));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver();
  vi.unstubAllGlobals();
});

const operations: [string, () => Promise<unknown>][] = [
  [
    'task room Stop / delegated interrupt',
    () => interruptDelegatedTask(base, 'task', {}, { requestScope: scope }),
  ],
  [
    'provider task stop',
    () => stopProviderTask(base, 'session', 'provider-task'),
  ],
  [
    'room live stop',
    () =>
      commandProjectTaskRoomLive(base, 'task', {
        command: 'stop',
        paneId: 'pane',
      }),
  ],
  [
    'room departure',
    () => commandProjectTaskRoomLive(base, 'task', { command: 'depart' }),
  ],
  ['turn interrupt', () => interruptTurn(base, { threadId: 'session' })],
  [
    'UI turn Stop wrapper',
    () => interruptOrchestrationTurn({ threadId: 'session', apiBase: base }),
  ],
  [
    'conversation inbox cancellation',
    () => cancelConversationInboxEntry(base, 'conversation', 'turn'),
  ],
  [
    'context boundary cancellation',
    () => cancelConversationContextBoundary(base, 'conversation', 'key'),
  ],
  ['attachment cancellation', () => cancelAttachmentStage(base, 'stage')],
  [
    'peer enrollment cancellation',
    () => cancelPeerEnrollment(base, 'enrollment'),
  ],
  ['action cancellation', () => cancelActionOperation(base, 'operation')],
  ['secret revocation', () => revokeSecretBinding(base, 'secret', 1)],
  ['own token revocation', () => revokeOwnAccessToken('token', base)],
  [
    'person token revocation',
    () => revokeStationPersonToken('person', 'token', base),
  ],
  [
    'plugin permission revocation',
    () => revokePluginPermissions({ name: 'plugin', permissions: ['network'] }),
  ],
  ['Home role revocation', () => revokeWorkspaceHomeRoleGrant()],
  [
    'Project invitation revocation',
    () =>
      changeProjectAccess(base, 'project', {
        kind: 'revoke-invitation',
        scope: membershipScope,
        invitationId: 'invitation',
      }),
  ],
  [
    'Project member revocation',
    () =>
      changeProjectAccess(base, 'project', {
        kind: 'change-member',
        scope: membershipScope,
        principalId: 'person',
        revision: 1,
        role: 'viewer',
        status: 'revoked',
      }),
  ],
  ...(['cancel', 'decline'] as const).flatMap(
    (decision): [string, () => Promise<unknown>][] => [
      [
        `request ${decision}`,
        () =>
          respondToRequest(base, {
            threadId: 'session',
            requestId: 'request',
            decision,
          }),
      ],
      [
        `delegated request ${decision}`,
        () =>
          respondToDelegatedTaskRequest(base, 'task', {
            requestId: 'request',
            decision,
          }),
      ],
      [
        `UI request ${decision}`,
        () =>
          resolveOrchestrationRequest({
            threadId: 'session',
            requestId: 'request',
            decision,
            apiBase: base,
          }),
      ],
    ],
  ),
];
it.each(operations)(
  '%s attempts dispatch despite the previous outage',
  async (_name, invoke) => {
    await expect(invoke()).rejects.toBe(reached);
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('Stop returns the recovered server result, while ordinary writes and stale authority remain blocked', async () => {
  transport.mockResolvedValueOnce(
    Response.json({
      success: true,
      data: { taskId: 'task', interruptRequested: true },
    }),
  );
  await expect(
    interruptDelegatedTask(base, 'task', {}, { requestScope: scope }),
  ).resolves.toMatchObject({ taskId: 'task', interruptRequested: true });
  await expect(deleteProject(base, 'project')).rejects.toThrow(
    'Previous transient outage',
  );
  await expect(
    respondToRequest(base, {
      threadId: 'session',
      requestId: 'request',
      decision: 'accept',
    }),
  ).rejects.toThrow('Previous transient outage');
  authorityCurrent = false;
  await expect(
    interruptDelegatedTask(base, 'task', {}, { requestScope: scope }),
  ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
  expect(transport).toHaveBeenCalledTimes(1);
});

it('the explicit exception also bypasses a false reachability verdict', async () => {
  setClientCredentialResolver(() => ({
    origin: base,
    transport,
    mutationAllowed: () => false,
  }));
  await expect(deleteProject(base, 'project')).rejects.toBeInstanceOf(
    StationReadOnlyError,
  );
  await expect(interruptTurn(base, { threadId: 'session' })).rejects.toBe(
    reached,
  );
  expect(transport).toHaveBeenCalledTimes(1);
});

it.each([
  'device login cancellation',
  'answer share revocation',
  'SSH disconnect',
  'engine login cancellation',
] as const)(
  '%s reaches transport through its mutation hook',
  async (operation) => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    clients.push(client);
    const { result } = renderHook(
      () => {
        const cancelEngineLogin = useEngineAccountLoginMutation(
          'connection',
          'profile',
          scope,
        );
        const cancelLogin = useCancelDeviceCodeLoginMutation();
        const revokeShare = useRevokeAnswerShareMutation();
        const disconnect = useDisconnectSshEnvironmentMutation();
        return () =>
          operation === 'engine login cancellation'
            ? cancelEngineLogin.mutateAsync({ kind: 'cancel' })
            : operation === 'device login cancellation'
              ? cancelLogin.mutateAsync({
                  connectionId: 'connection',
                  profileRef: 'profile',
                  requestScope: scope,
                })
              : operation === 'answer share revocation'
                ? revokeShare.mutateAsync('share')
                : disconnect.mutateAsync('ssh');
      },
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      await expect(result.current()).rejects.toBe(reached);
    });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it('application-session revocation signs and attempts dispatch despite an outage', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const key = await createApplicationSessionKey();
  const client = new ApplicationSessionClient(
    base,
    'station',
    base,
    { requestScope: scope },
    key,
  );
  await expect(
    client.revoke({
      version: APPLICATION_SESSION_VERSION,
      credential: 'c'.repeat(43),
      authorityKey: 'person',
      stationId: 'station',
      deviceId: 'device',
      principal: humanPrincipal('test', 'alice', 'Alice'),
      requestOrigin: base,
      clientOrigin: base,
      keyThumbprint: 'k'.repeat(43),
      nonce: 'n'.repeat(43),
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  ).rejects.toBe(reached);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(
    new Headers(transport.mock.calls[0]![1]?.headers).has(
      APPLICATION_SESSION_PROOF_HEADER,
    ),
  ).toBe(true);
});

it('relay denial and approval revocation attempt dispatch despite an outage', async () => {
  const surface = {
    kind: 'station-native' as const,
    appIdentifier: 'io.kontourai.station',
    channel: 'stable' as const,
    clientInstanceId: 'client',
    keyThumbprint: 'k'.repeat(43),
  };
  await expect(
    revokeRelaySetup(base, {
      approvalId: 'approval',
      revision: 1,
      scope: {
        stationId: 'station',
        enrollmentId: 'enrollment',
        routingGeneration: 1,
      },
      surface,
    }),
  ).rejects.toBe(reached);
  await expect(
    denyRelayDevice(base, {
      enrollmentId: 'e'.repeat(43),
      requestId: 'request',
      account: { issuer: 'test', subject: 'alice', displayName: 'Alice' },
      requestedScope: 'orchestration:read',
      expiresAt: Date.now() + 60_000,
      candidate: {
        version: 'station-native-device-binding-candidate/v1',
        stationId: 'station',
        deviceId: 'device',
        bindingId: 'binding',
        surface,
        deviceProofJwk: {
          kty: 'EC',
          crv: 'P-256',
          x: 'x'.repeat(43),
          y: 'y'.repeat(43),
        },
        deviceProofKeyThumbprint: 'k'.repeat(43),
      },
    }),
  ).rejects.toBe(reached);
  expect(transport).toHaveBeenCalledTimes(2);
});
