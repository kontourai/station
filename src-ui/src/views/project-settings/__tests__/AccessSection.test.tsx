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
