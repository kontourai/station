/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  refetch: vi.fn(),
  recover: vi.fn(),
  approve: vi.fn(),
  invalidate: vi.fn(),
  data: undefined as any,
}));
vi.mock('@kontourai/station-sdk', () => ({
  usePluginRecoveryPreviewQuery: () => ({
    data: state.data,
    refetch: state.refetch,
    isFetching: false,
  }),
  usePluginRecoveryMutation: () => ({
    mutateAsync: state.recover,
    isPending: false,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock('../../../core/PermissionManager', () => ({
  usePermissions: () => ({ requestInstallConsent: state.approve }),
}));

import { PluginRecoveryPanel } from '../PluginRecoveryPanel';

const plugin = {
  name: 'fixture',
  displayName: 'Fixture',
  version: '1.0.0',
  hasBundle: false,
  installationReadiness: {
    state: 'pending' as const,
    recovery: 'review' as const,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  state.data = {
    recoveryRevision: 'review-1',
    contentDigest: 'digest-1',
    grantRevision: 'grant-1',
    permissions: {
      required: ['agents.invoke'],
      pendingConsent: [{ permission: 'agents.invoke', tier: 'active' }],
    },
    dependencies: [
      {
        id: 'child',
        consent: {
          contentDigest: 'child-digest',
          grantRevision: 'child-grant',
          permissions: [],
          dependencies: [],
        },
      },
    ],
  };
  state.refetch.mockResolvedValue({ data: state.data });
  state.approve.mockResolvedValue(true);
  state.recover.mockResolvedValue({
    success: true,
    configurationActivation: { status: 'pending' },
  });
});
afterEach(cleanup);
test('requires a fresh preview and explicit consent, passes exact revisions, and keeps pending acceptance honest', async () => {
  render(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Recover plugin' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  await waitFor(() => expect(state.recover).toHaveBeenCalledOnce());
  expect(state.approve).toHaveBeenCalledOnce();
  expect(state.recover).toHaveBeenCalledWith({
    name: 'fixture',
    recoveryRevision: 'review-1',
    consent: {
      contentDigest: 'digest-1',
      grantRevision: 'grant-1',
      permissions: ['agents.invoke'],
      dependencies: ['child'],
      dependencyApprovals: [
        { id: 'child', ...state.data.dependencies[0].consent },
      ],
    },
  });
  expect((await screen.findByRole('status')).textContent).toContain(
    'still pending',
  );
  expect(screen.queryByRole('button', { name: 'Recover plugin' })).toBeNull();
});
// #2708 A-2: a recovery refused by the route's validation (POST
// /:name/recover), as the REAL `recoverPlugin` throws it: the notice shows the
// server's reason, not "Validation failed: consent …".
test('a refused recovery shows the server reason, not the field key', async () => {
  const { recoverPlugin } = await import('@kontourai/station-sdk/client');
  const previous = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: false,
        error: 'Validation failed',
        details: {
          formErrors: [],
          fieldErrors: { recoveryRevision: ['Required'] },
        },
      }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  state.recover.mockImplementationOnce(
    ({ name, ...input }: { name: string } & Record<string, unknown>) =>
      recoverPlugin('http://station.test', name, input as never),
  );
  try {
    render(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Recover plugin' }),
    );
    expect((await screen.findByRole('status')).textContent).toBe('Required');
  } finally {
    globalThis.fetch = previous;
  }
});

test('cancelled permission review performs no recovery mutation', async () => {
  state.approve.mockResolvedValue(false);
  render(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review recovery' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  await waitFor(() => expect(state.approve).toHaveBeenCalledOnce());
  expect(state.recover).not.toHaveBeenCalled();
});
