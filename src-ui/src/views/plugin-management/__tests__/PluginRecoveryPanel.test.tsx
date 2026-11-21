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
  // Named so a missing review load fails on a readable assertion.
  refetch: vi.fn().mockName('recovery review loader'),
  recover: vi.fn(),
  approve: vi.fn(),
  hostApproval: vi.fn().mockName('trusted host approval'),
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
  usePermissions: () => ({
    requestInstallConsent: state.approve,
    requestConsent: state.hostApproval,
  }),
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
  // The shape the recover route sends when activation is stopped again.
  state.recover.mockResolvedValue({
    success: false,
    configurationActivation: {
      status: 'pending',
      recovery: 'required',
      deadlineMs: 10_000,
    },
  });
  state.hostApproval.mockResolvedValue(true);
});
afterEach(cleanup);

/** Each test starts from the review the panel loads by itself. */
async function reviewLoaded() {
  await waitFor(() => expect(state.refetch).toHaveBeenCalledOnce(), {
    timeout: 1000,
  });
}

test('a recovery that activates the plugin asks for the trusted approval it still owes, once, and reports where the panel cannot', async () => {
  state.recover.mockResolvedValue({
    success: true,
    plugin: { name: 'fixture', version: '1.0.0' },
    permissions: {
      autoGranted: [],
      pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
      dependencies: [],
    },
  });
  const onOutcome = vi.fn();
  render(
    <PluginRecoveryPanel
      plugin={plugin}
      onRemove={vi.fn()}
      onOutcome={onOutcome}
    />,
  );
  await reviewLoaded();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  await waitFor(() => expect(onOutcome).toHaveBeenCalledOnce());
  expect(state.hostApproval).toHaveBeenCalledOnce();
  expect(state.hostApproval).toHaveBeenCalledWith('fixture', 'Fixture', [
    { permission: 'plugin.server', tier: 'trusted' },
  ]);
  expect(onOutcome).toHaveBeenCalledWith({
    type: 'success',
    text: 'Fixture was recovered and is active.',
  });
});

test('a declined trusted approval after recovery says the plugin still needs it', async () => {
  state.recover.mockResolvedValue({
    success: true,
    permissions: {
      autoGranted: [],
      pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
    },
  });
  state.hostApproval.mockResolvedValue(false);
  const onOutcome = vi.fn();
  render(
    <PluginRecoveryPanel
      plugin={plugin}
      onRemove={vi.fn()}
      onOutcome={onOutcome}
    />,
  );
  await reviewLoaded();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  await waitFor(() =>
    expect(onOutcome).toHaveBeenCalledWith({
      type: 'error',
      text: 'Fixture is active, but its server features stay off until you approve its trusted permissions. Open Plugins, select it, and review its request under Requested and not granted.',
    }),
  );
});

test('a recovery stopped again says the host was busy and how to get out', async () => {
  render(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
  await reviewLoaded();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  expect((await screen.findByRole('status')).textContent).toBe(
    'Recovery was saved, but the plugin is still not active: its activation did not finish within 10 seconds. Trying again may work; Remove plugin is the way out.',
  );
  expect(state.hostApproval).not.toHaveBeenCalled();
});
test('loads a fresh review with the row, requires explicit consent, passes exact revisions, and keeps a saved-but-inactive recovery honest', async () => {
  render(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Recover plugin' })).toBeNull();
  // Nothing resumes the activation, so the review is offered without a click.
  await reviewLoaded();
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
    'still not active',
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
    await reviewLoaded();
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
  await reviewLoaded();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Recover plugin' }),
  );
  await waitFor(() => expect(state.approve).toHaveBeenCalledOnce());
  expect(state.recover).not.toHaveBeenCalled();
});

test('#1521: the recovery review shows the recovery preview’s receipt, not the list row’s', async () => {
  const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
  const receipt = (packageDigest: string, keyId: string) => ({
    version: 1 as const,
    policyScope: 'local',
    policyEpoch: 'epoch-1',
    policyFingerprint: digest('a'),
    registryKeyDigest: digest('b'),
    registryId: 'fixture',
    claimDigest: digest('c'),
    packageDigest,
    signer: { keyId, spkiFingerprint: digest('e') },
  });
  state.data = {
    ...state.data,
    registryTrust: {
      state: 'verified',
      revision: digest('1'),
      receipt: receipt(digest('2'), 'reviewed-key'),
    },
  };
  state.refetch.mockResolvedValue({ data: state.data });
  render(
    <PluginRecoveryPanel
      plugin={{
        ...plugin,
        registryTrust: {
          state: 'verified',
          revision: digest('8'),
          receipt: receipt(digest('9'), 'listed-key'),
        },
      }}
      onRemove={vi.fn()}
    />,
  );
  await reviewLoaded();
  const region = await screen.findByRole('region', {
    name: 'Registry verification',
  });
  expect(region.textContent).toContain(digest('1'));
  expect(region.textContent).toContain(digest('2'));
  expect(region.textContent).toContain('reviewed-key');
  expect(region.textContent).not.toContain(digest('8'));
  expect(region.textContent).not.toContain('listed-key');
});

test('an install that left this row inactive explains itself above the recovery review', async () => {
  const text =
    'Fixture was installed, but its activation did not finish, so it is not active. Choose Recover plugin to activate it; trusted permissions are approved after that.';
  render(
    <PluginRecoveryPanel
      plugin={plugin}
      message={{ type: 'warning', text }}
      onRemove={vi.fn()}
    />,
  );
  await reviewLoaded();
  const status = screen.getByRole('status');
  expect(status.textContent).toBe(text);
  expect(status.className).toContain('plugins__message--warning');
  expect(screen.getByText('Needs recovery')).toBeTruthy();
  expect(
    await screen.findByRole('region', { name: 'Recovery review' }),
  ).toBeTruthy();
});

test('a plugin the server is still activating says Activating, loads no recovery review and offers no Recover', async () => {
  const activating = {
    ...plugin,
    installationReadiness: { state: 'activating' as const },
  };
  const view = render(
    <PluginRecoveryPanel plugin={activating} onRemove={vi.fn()} />,
  );
  expect(screen.getByText('Activating…')).toBeTruthy();
  expect(screen.queryByText('Needs recovery')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Review recovery' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Recover plugin' })).toBeNull();
  expect(state.refetch).not.toHaveBeenCalled();

  // Once the server reports the activation stopped, the row needs recovery
  // and its review is loaded.
  view.rerender(<PluginRecoveryPanel plugin={plugin} onRemove={vi.fn()} />);
  expect(screen.getByText('Needs recovery')).toBeTruthy();
  await reviewLoaded();
});
