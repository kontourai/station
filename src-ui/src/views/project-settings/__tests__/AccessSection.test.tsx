/** @vitest-environment jsdom */
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBERSHIP_VERSION,
  type ProjectAccessAdministrationView,
} from '@kontourai/station-contracts/project-membership';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AccessSection } from '../AccessSection';

const host = vi.hoisted(() => ({
  apiBase: 'https://station.example.test',
  authorityKey: 'device-one',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({ ...host }),
}));
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));
vi.mock('../../../components/modals/ConfirmModal', () => ({
  ConfirmModal: ({
    isOpen,
    title,
    onConfirm,
    onCancel,
  }: {
    isOpen: boolean;
    title: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    isOpen ? (
      <div role="dialog" aria-label={title}>
        <button type="button" onClick={onConfirm}>
          Confirm change
        </button>
        <button type="button" onClick={onCancel}>
          Cancel change
        </button>
      </div>
    ) : null,
}));
const owner = humanPrincipal('deployment', 'owner', 'Owner');
const person = humanPrincipal('deployment', 'person', 'Collaborator');
function view(): ProjectAccessAdministrationView {
  const at = '2026-09-12T12:00:00.000Z';
  return {
    version: PROJECT_MEMBERSHIP_VERSION,
    actingPrincipal: owner,
    invitationOrigin: host.apiBase,
    scope: {
      stationId: 'station-one',
      localProjectId: 'local-one',
      localProjectSlug: 'example',
      portableProjectId: 'prj_shared',
    },
    members: [
      {
        principal: owner,
        role: 'owner',
        actions: [...PROJECT_MEMBER_ROLES.owner],
        status: 'active',
        revision: 1,
        grantedBy: owner,
        updatedAt: at,
      },
      {
        principal: person,
        role: 'viewer',
        actions: [...PROJECT_MEMBER_ROLES.viewer],
        status: 'active',
        revision: 2,
        grantedBy: owner,
        updatedAt: at,
      },
    ],
    invitations: [],
  };
}
const clients: QueryClient[] = [];
beforeEach(() => {
  host.authorityKey = 'device-one';
  setClientCredentialResolver(() => ({
    origin: host.apiBase,
    requestAuthority: { ...host, isCurrent: () => true },
  }));
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <AccessSection slug="example" projectId="local-one" />
    </QueryClientProvider>,
  );
}
function reply(data: unknown) {
  return Response.json({ success: true, data });
}

describe('Project access administration UI through SDK queries and mutations', () => {
  test('changing a role sends the exact Project scope and observed member revision', async () => {
    const current = view();
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return reply({ changed: true });
      }
      return reply(current);
    });
    mount();
    const select = await screen.findByLabelText('Role for Collaborator');
    await waitFor(() =>
      expect((select as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.change(select, { target: { value: 'contributor' } });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      scope: current.scope,
      principalId: person.id,
      revision: 2,
      role: 'contributor',
      status: 'active',
    });
  });

  test('revoking access requires the confirmation and never sends an owner-removal command', async () => {
    const writes: unknown[] = [];
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        return reply({ changed: true });
      }
      return reply(view());
    });
    mount();
    const revoke = await screen.findByRole('button', { name: 'Revoke access' });
    await waitFor(() =>
      expect((revoke as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(revoke);
    expect(writes).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      principalId: person.id,
      status: 'revoked',
      revision: 2,
    });
  });

  test('a forbidden refresh hides stale member data and a Station authority change clears the invite draft', async () => {
    vi.mocked(fetch).mockResolvedValue(reply(view()));
    const rendered = mount();
    await screen.findByText('Collaborator');
    fireEvent.click(screen.getByLabelText('Require a verified email address'));
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'private@example.test' },
    });
    vi.mocked(fetch).mockResolvedValue(
      Response.json(
        { error: { code: 'project_access_forbidden' } },
        { status: 403 },
      ),
    );
    host.authorityKey = 'device-two';
    const client = clients[0]!;
    rendered.rerender(
      <QueryClientProvider client={client}>
        <AccessSection slug="example" projectId="local-one" />
      </QueryClientProvider>,
    );
    await screen.findByText('Project access is unavailable');
    expect(screen.queryByText('Collaborator')).toBeNull();
    expect(screen.queryByDisplayValue('private@example.test')).toBeNull();
  });

  test('invitation creation requires configured account sign-in', async () => {
    const current = view();
    delete current.invitationOrigin;
    vi.mocked(fetch).mockResolvedValue(reply(current));
    mount();
    expect(
      (
        (await screen.findByRole('button', {
          name: 'Create invitation',
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        'Account sign-in must be configured before creating an invitation link.',
      ),
    ).toBeTruthy();
  });
});

describe('enabling sharing with an operator passkey step-up (#4306)', () => {
  const REVIEW = 'https://station.example.test:8443/consent/tx-1';
  function route(enablement: Response | (() => Response), statuses: string[]) {
    let shared = false;
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.pathname}`);
      if (url.pathname === '/api/projects/example/access/enablement')
        return typeof enablement === 'function'
          ? enablement()
          : enablement.clone();
      if (url.pathname === '/api/projects/example/access')
        return shared
          ? reply(view())
          : Response.json(
              { error: { code: 'project_access_forbidden' } },
              { status: 403 },
            );
      if (url.pathname === '/api/projects/example/access/enable')
        return Response.json(
          {
            status: 'step_up_required',
            transaction: { id: 'tx-1', reviewUrl: REVIEW, expiresAt: 1 },
          },
          { status: 202 },
        );
      if (url.pathname === '/api/pairing/device-access-transactions/tx-1') {
        const status = statuses.shift() ?? 'pending';
        if (status === 'approved') shared = true;
        return Response.json({ status });
      }
      throw new Error(`unexpected ${method} ${url.pathname}`);
    });
    return calls;
  }

  test('opens the consent-origin review during the click and shows People and access once approved', async () => {
    const calls = route(reply({ enable: 'operator-passkey' }), [
      'pending',
      'approved',
    ]);
    const replace = vi.fn();
    const close = vi.fn();
    const open = vi.fn(() => ({ location: { replace }, close }));
    vi.stubGlobal('open', open);
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Enable Project sharing' }),
    );
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(replace).toHaveBeenCalledWith(REVIEW));
    expect(close).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('link', { name: 'Review sharing change' }),
    ).toHaveProperty('href', REVIEW);
    expect(
      await screen.findByText('Collaborator', {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(calls).toContain('GET /api/pairing/device-access-transactions/tx-1');
  }, 10_000);

  test('a cancelled review says nothing was applied', async () => {
    route(reply({ enable: 'operator-passkey' }), ['denied']);
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ location: { replace: vi.fn() }, close: vi.fn() })),
    );
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Enable Project sharing' }),
    );
    expect(
      await screen.findByText('Cancelled. Nothing was applied.'),
    ).toBeTruthy();
  });

  test('a caller that must sign in first gets the sign-in link, not Enable', async () => {
    route(
      reply({
        enable: 'operator-sign-in',
        signInUrl: 'https://station.example.test:8443/operator/sign-in',
      }),
      [],
    );
    mount();
    expect(
      await screen.findByRole('link', { name: 'Sign in as operator' }),
    ).toHaveProperty(
      'href',
      'https://station.example.test:8443/operator/sign-in',
    );
    expect(
      screen.queryByRole('button', { name: 'Enable Project sharing' }),
    ).toBeNull();
  });

  test('a caller without any enable path sees no Enable action', async () => {
    const calls = route(reply({ enable: 'unavailable' }), []);
    mount();
    await waitFor(() =>
      expect(calls).toContain('GET /api/projects/example/access/enablement'),
    );
    await screen.findByRole('button', { name: 'Refresh access' });
    expect(
      screen.queryByRole('button', { name: 'Enable Project sharing' }),
    ).toBeNull();
  });

  test('a host without the enablement read keeps offering Enable', async () => {
    const calls = route(
      () => Response.json({ error: 'not_found' }, { status: 404 }),
      [],
    );
    mount();
    expect(
      await screen.findByRole('button', { name: 'Enable Project sharing' }),
    ).toBeTruthy();
    expect(calls).toContain('GET /api/projects/example/access/enablement');
  });
});
