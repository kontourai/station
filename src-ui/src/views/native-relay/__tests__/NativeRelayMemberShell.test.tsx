/** @vitest-environment jsdom */
import type { SavedConnection } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import {
  PROJECT_SHARED_TASK_VERSION,
  type ProjectSharedTaskSummary,
} from '@kontourai/station-contracts/project-shared-task';
import { setClientCredentialResolver } from '@kontourai/station-sdk';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  scope: null as {
    apiBase: string;
    authorityKey: string;
    isCurrent(): boolean;
  } | null,
  connection: null as SavedConnection | null,
  transport: vi.fn<typeof fetch>(),
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  useConnections: () => ({
    activeConnection: state.connection,
    connections: state.connection ? [state.connection] : [],
    setActiveConnection: async () => {},
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => state.scope,
}));
vi.mock('../../connections-hub/RelayRouteProfiles', () => ({
  RelayRouteProfiles: () => <div>Native account recovery</div>,
}));

import { navigationStore } from '../../../contexts/NavigationContext';
import { savedConnectionFromStationProfile } from '../../../platform/native/stationProfileStorage';
import { NativeRelayMemberShell } from '../NativeRelayMemberShell';

const stationId = '11111111-1111-4111-8111-111111111111';
const origin = 'https://native-station.example.test';
const member: MemberProjectView = {
  version: 'station.member-project/v1',
  kind: 'member-project',
  id: 'project-a',
  slug: 'shared',
  name: 'Shared research',
  actions: ['view'],
};
const observation: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: stationId,
  principal: { kind: 'human', id: humanPrincipal('test', 'zach', 'Zach').id },
  grant: {
    kind: 'device',
    deviceId: 'device-a',
    grantedScopes: ['orchestration:read'],
  },
};
const sharedTask: ProjectSharedTaskSummary = {
  version: PROJECT_SHARED_TASK_VERSION,
  project: {
    stationId,
    localProjectId: member.id,
    localProjectSlug: member.slug,
    portableProjectId: 'portable-project',
  },
  task: {
    id: 'task-a',
    title: 'Published task',
    status: 'in_progress',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  shareId: '44444444-4444-4444-8444-444444444444',
  sharedAt: '2026-01-02T00:00:00.000Z',
};
let current: boolean;
let accountNumber = 0;
function paths() {
  return state.transport.mock.calls.map(
    ([input]) =>
      new URL(input instanceof Request ? input.url : input.toString()).pathname,
  );
}
beforeEach(() => {
  current = true;
  accountNumber++;
  const capturedAccount = accountNumber;
  state.scope = {
    apiBase: origin,
    authorityKey: `account-${accountNumber}`,
    isCurrent: () => current && accountNumber === capturedAccount,
  };
  state.connection = savedConnectionFromStationProfile(
    {
      schemaVersion: 1,
      name: 'Home Station',
      endpoint: origin,
      relayRoute: {
        brokerOrigin: 'https://broker.example.test',
        stationId,
        enrollmentId: '22222222-2222-4222-8222-222222222222',
      },
      setupSource: 'manual',
      configurationState: 'configured',
      credentialRef: { kind: 'station-bearer', id: 'opaque-host-ref' },
      environmentId: stationId,
      clientInstanceId: '33333333-3333-4333-8333-333333333333',
      createdAt: 1,
      updatedAt: 1,
    },
    7,
  );
  state.transport.mockReset().mockImplementation(async (input) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (path === '/api/auth/authority') return Response.json(observation);
    if (path === '/api/projects')
      return Response.json({ success: true, data: [member] });
    if (path === '/api/projects/shared')
      return Response.json({ success: true, data: member });
    if (path === '/api/projects/shared/shared-work')
      return Response.json({ success: true, data: [] });
    throw new Error(`unsupported operator read: ${path}`);
  });
  setClientCredentialResolver(() => ({
    origin,
    transport: state.transport,
    requestAuthority: state.scope ?? undefined,
    transportBindingIsCurrent: () => current,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('raw HTTP fallback');
    }),
  );
});
afterEach(() => {
  cleanup();
  setClientCredentialResolver();
  vi.unstubAllGlobals();
});
it('reads published task content through the real member SDK without starting operator resources', async () => {
  state.transport.mockImplementation(async (input) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (path === '/api/auth/authority') return Response.json(observation);
    let data: unknown;
    if (path === '/api/projects') data = [member];
    else if (path === '/api/projects/shared') data = member;
    else if (path === '/api/projects/shared/shared-work') data = [sharedTask];
    else if (path === '/api/projects/shared/shared-work/task-a/publication')
      data = { kind: 'shared', publication: sharedTask };
    else if (path === '/api/projects/shared/shared-work/task-a/document')
      data = {
        kind: 'snapshot',
        project: { id: member.id, slug: member.slug },
        task: { id: sharedTask.task.id, createdAt: sharedTask.task.createdAt },
        revision: 'revision-one',
        text: 'Published document text',
      };
    else if (path === '/api/projects/shared/shared-work/task-a/history')
      data = {
        kind: 'available',
        records: [
          {
            actor: { kind: 'human', label: 'Contributor' },
            sequence: 1,
            body: { kind: 'human-message', text: 'Published discussion' },
            digests: { proposal: 'a'.repeat(64), checkpoint: 'b'.repeat(64) },
            integrity: 'L0',
          },
        ],
        checkpoint: {
          throughSeq: 1,
          checkpointDigest: 'b'.repeat(64),
          retainedAnchorSeq: 0,
          retainedAnchorDigest: 'c'.repeat(64),
        },
        hasMore: false,
      };
    else throw new Error(`unsupported operator read: ${path}`);
    return Response.json({ success: true, data });
  });
  render(<NativeRelayMemberShell />);
  await screen.findByRole('heading', { name: 'Shared research' });
  fireEvent.click(screen.getByRole('button', { name: member.name }));
  expect(window.location.pathname).toBe('/projects/shared');
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Read shared item: Published task',
    }),
  );
  await screen.findByText('Published document text');
  await screen.findByText('Published discussion');
  expect(paths().sort()).toEqual(
    [
      '/api/auth/authority',
      '/api/projects',
      '/api/projects/shared',
      '/api/projects/shared/shared-work',
      '/api/projects/shared/shared-work/task-a/publication',
      '/api/projects/shared/shared-work/task-a/document',
      '/api/projects/shared/shared-work/task-a/history',
    ].sort(),
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('keeps accountless native recovery open without any protected or operator request', () => {
  state.scope = null;
  render(<NativeRelayMemberShell />);
  expect(screen.getByText('Native account recovery')).toBeDefined();
  expect(
    screen.getByText(
      'Sign in to this Station to view the Projects shared with your account.',
    ),
  ).toBeDefined();
  expect(state.transport).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects operator detail DTOs and never synthesizes a member view', async () => {
  state.transport.mockImplementation(async (input) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (path === '/api/auth/authority') return Response.json(observation);
    if (path === '/api/projects')
      return Response.json({ success: true, data: [member] });
    if (path === '/api/projects/shared')
      return Response.json({
        success: true,
        data: {
          id: member.id,
          slug: member.slug,
          name: 'Private workspace',
          workingDirectory: '/private/work',
        },
      });
    throw new Error(path);
  });
  render(<NativeRelayMemberShell />);
  await screen.findByText('This Project is unavailable');
  expect(screen.queryByText('Private workspace')).toBeNull();
  expect(paths()).toEqual([
    '/api/auth/authority',
    '/api/projects',
    '/api/projects/shared',
  ]);
});
it('drops a late Project body after account loss and performs a fresh read for the next account', async () => {
  navigationStore.setProject('previous-account-project');
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  state.transport.mockImplementation(async (input) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (path === '/api/auth/authority') return Response.json(observation);
    if (path === '/api/projects') {
      await held;
      return Response.json({ success: true, data: [member] });
    }
    throw new Error(path);
  });
  const mounted = render(<NativeRelayMemberShell />);
  await waitFor(() => expect(paths()).toContain('/api/projects'));
  current = false;
  state.scope = null;
  mounted.rerender(<NativeRelayMemberShell />);
  expect(window.location.pathname).toBe('/');
  await act(async () => {
    release();
    await held;
  });
  expect(screen.queryByRole('button', { name: member.name })).toBeNull();
  expect(paths()).not.toContain('/api/projects/shared');
  expect(screen.getByText('Native account recovery')).toBeDefined();
  current = true;
  const nextAccount = ++accountNumber;
  state.scope = {
    apiBase: origin,
    authorityKey: `account-${nextAccount}`,
    isCurrent: () => current && accountNumber === nextAccount,
  };
  state.transport.mockImplementation(async (input) => {
    const path = new URL(
      input instanceof Request ? input.url : input.toString(),
    ).pathname;
    if (path === '/api/auth/authority') return Response.json(observation);
    if (path === '/api/projects')
      return Response.json({ success: true, data: [member] });
    if (path === '/api/projects/shared')
      return Response.json({ success: true, data: member });
    if (path === '/api/projects/shared/shared-work')
      return Response.json({ success: true, data: [] });
    throw new Error(path);
  });
  mounted.rerender(<NativeRelayMemberShell />);
  await screen.findByRole('heading', { name: member.name });
  expect(paths().filter((path) => path === '/api/projects')).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});
