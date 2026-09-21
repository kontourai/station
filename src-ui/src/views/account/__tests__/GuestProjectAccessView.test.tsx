/** @vitest-environment jsdom */

import { humanPrincipal } from '@kontourai/station-contracts/principal';
import {
  PROJECT_MEMBER_ROLES,
  PROJECT_MEMBERSHIP_VERSION,
  type ProjectAccessAdministrationView,
} from '@kontourai/station-contracts/project-membership';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { GuestProjectAccessView } from '../GuestProjectAccessView';

const apiBase = 'https://station.example.test';
const owner = humanPrincipal('deployment', 'owner', 'Owner');
const admin = humanPrincipal('deployment', 'guest-admin', 'Guest Admin');
const at = '2026-09-20T12:00:00.000Z';
const scope = {
  stationId: 'station-one',
  localProjectId: 'local-one',
  localProjectSlug: 'example',
  portableProjectId: 'prj_shared',
};
const project = { id: 'local-one', slug: 'example' };

function adminView(
  overrides: Partial<ProjectAccessAdministrationView> = {},
): ProjectAccessAdministrationView {
  return {
    version: PROJECT_MEMBERSHIP_VERSION,
    actingPrincipal: admin,
    invitationOrigin: apiBase,
    scope: { ...scope },
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
        principal: admin,
        role: 'admin',
        actions: [...PROJECT_MEMBER_ROLES.admin],
        status: 'active',
        revision: 2,
        grantedBy: owner,
        updatedAt: at,
      },
    ],
    invitations: [],
    ...overrides,
  };
}

const observation = (scopes: readonly string[]) =>
  Response.json({
    schemaVersion: 'station.authority-observation/v1',
    environmentId: 'env-one',
    principal: { kind: 'human', id: admin.id },
    grant: {
      kind: 'device',
      deviceId: 'device-one',
      grantedScopes: [...scopes],
    },
  });

const account = (id: string) =>
  Response.json({
    data: {
      principal: { id, kind: 'human', display: id },
      issuer: 'station:test',
      expiresAt: '2099-01-01T00:00:00.000Z',
      contacts: [],
    },
  });

const envelope = (data: unknown) => Response.json({ success: true, data });

interface Stub {
  posts: Array<{ url: string; body: Record<string, unknown> }>;
  access: () => Response;
  observe: () => Response;
  mutate: (url: string, body: Record<string, unknown>) => Response;
}

function invitationResponse(body: Record<string, unknown>) {
  return envelope({
    invitation: {
      id: 'inv-1',
      recipientEmail: null,
      role: body.role,
      actions: [
        ...(PROJECT_MEMBER_ROLES[
          body.role as keyof typeof PROJECT_MEMBER_ROLES
        ] as readonly string[]),
      ],
      invitedBy: admin,
      status: 'pending',
      expiresAt: body.expiresAt,
      createdAt: at,
    },
    token: 't'.repeat(43),
  });
}

function stubFetch(stub: Stub) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/api/account-auth/session')
        return account(admin.id);
      if (url.pathname === '/api/auth/authority') return stub.observe();
      if (url.pathname === `/api/projects/${project.slug}/access`)
        return stub.access();
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body ?? '{}'));
        stub.posts.push({ url: url.pathname, body });
        return stub.mutate(url.pathname, body);
      }
      return new Response('unexpected request', { status: 500 });
    }),
  );
}

const accessKey = [
  'guest-project-access',
  apiBase,
  admin.id,
  project.id,
  project.slug,
] as const;

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onAccountRequired = vi.fn();
  const onAccessLost = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <GuestProjectAccessView
        apiBase={apiBase}
        principalId={admin.id}
        project={project}
        onAccountRequired={onAccountRequired}
        onAccessLost={onAccessLost}
      />
    </QueryClientProvider>,
  );
  return { client, onAccountRequired, onAccessLost };
}

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
vi.mock('../../../hooks/useUnsavedGuard', () => ({
  useUnsavedGuard: () => ({ DiscardModal: () => null }),
}));

afterEach(() => vi.unstubAllGlobals());

test('an approved admin creates a manual invitation link stamped with the captured actor', async () => {
  const stub: Stub = {
    posts: [],
    access: () => envelope(adminView()),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: (url, body) =>
      url.endsWith('/invitations')
        ? invitationResponse(body)
        : envelope({ changed: true }),
  };
  stubFetch(stub);
  mount();

  expect((await screen.findAllByText('Guest Admin')).length).toBeGreaterThan(0);
  expect(screen.getByText('can submit changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
  const link = (await screen.findByDisplayValue(
    /\/account\/join#invitation=/,
  )) as HTMLInputElement;
  expect(link.value).toContain('/account/join#invitation=');
  expect(screen.getByText(/copy the link now, it is shown once/)).toBeTruthy();
  expect(stub.posts).toHaveLength(1);
  expect(stub.posts[0].body).toMatchObject({ expectedActor: admin.id });
});

test('a read-only admin device inspects but cannot submit, with the operator-approval reason', async () => {
  const stub: Stub = {
    posts: [],
    access: () => envelope(adminView()),
    observe: () => observation(['orchestration:read']),
    mutate: () => envelope({ changed: true }),
  };
  stubFetch(stub);
  mount();

  expect((await screen.findAllByText('Guest Admin')).length).toBeGreaterThan(0);
  expect(screen.getByText('view-only')).toBeTruthy();
  expect(
    screen.getByText(/approve collaborator management for this browser/),
  ).toBeTruthy();
  const create = screen.getByRole('button', {
    name: 'Create invitation',
  }) as HTMLButtonElement;
  expect(create.disabled).toBe(true);
  expect(stub.posts).toHaveLength(0);
});

test('a non-admin never sees the enable-sharing action after a 403', async () => {
  const stub: Stub = {
    posts: [],
    access: () => new Response('forbidden', { status: 403 }),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: () => envelope({ changed: true }),
  };
  stubFetch(stub);
  const { onAccessLost } = mount();

  expect(await screen.findByText(/limited to Project admins/)).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Enable Project sharing' }),
  ).toBeNull();
  expect(onAccessLost).not.toHaveBeenCalled();
});

test('self-demotion acknowledges without content and hands back a refreshed view-only list', async () => {
  let demoted = false;
  const stub: Stub = {
    posts: [],
    access: () =>
      demoted
        ? new Response('forbidden', { status: 403 })
        : envelope(adminView()),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: () => {
      demoted = true;
      return envelope({ changed: true });
    },
  };
  stubFetch(stub);
  mount();

  expect((await screen.findAllByText('Guest Admin')).length).toBeGreaterThan(0);
  const select = screen.getByRole('combobox', {
    name: 'Role for Guest Admin',
  }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: 'contributor' } });
  await waitFor(() => expect(stub.posts).toHaveLength(1));
  expect(stub.posts[0].body).toMatchObject({
    principalId: admin.id,
    role: 'contributor',
    expectedActor: admin.id,
  });
  expect(
    await screen.findByText(/You changed your own Project role/),
  ).toBeTruthy();
  expect(await screen.findByText(/limited to Project admins/)).toBeTruthy();
});

test('a stale revision refuses honestly, refreshes, and never retries the mutation', async () => {
  const stub: Stub = {
    posts: [],
    access: () => envelope(adminView()),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: () => new Response('conflict', { status: 409 }),
  };
  stubFetch(stub);
  mount();

  expect((await screen.findAllByText('Guest Admin')).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Confirm change' }),
  );
  expect(
    await screen.findByText(/Someone else changed Project access first/),
  ).toBeTruthy();
  expect(stub.posts).toHaveLength(1);
});

test('a confirmation opened under one scope never submits as a newer cached scope', async () => {
  // The capture seam: a revoke confirmation holds scope A, then a refresh
  // replaces the cached administration with scope B (same local id/slug,
  // different station identity) before Confirm. The client must send A's
  // captured intent — never silently retarget onto B. Server scope/actor
  // checks stay the authority; this only proves no B mutation is sent.
  const contributor = humanPrincipal(
    'deployment',
    'guest-contributor',
    'Guest Contributor',
  );
  const viewA = adminView({
    members: [
      ...adminView().members,
      {
        principal: contributor,
        role: 'contributor',
        actions: [...PROJECT_MEMBER_ROLES.contributor],
        status: 'active',
        revision: 7,
        grantedBy: owner,
        updatedAt: at,
      },
    ],
  });
  let current: ProjectAccessAdministrationView = viewA;
  const stub: Stub = {
    posts: [],
    access: () => envelope(current),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: () => envelope({ changed: true }),
  };
  stubFetch(stub);
  const { client } = mount();

  expect(await screen.findByText('Guest Contributor')).toBeTruthy();
  // Owner has no revoke control; admin self-row revokes first, so the
  // contributor's control is the last one.
  const revokes = screen.getAllByRole('button', { name: 'Revoke access' });
  fireEvent.click(revokes[revokes.length - 1]);
  await screen.findByRole('button', { name: 'Confirm change' });

  current = {
    ...viewA,
    scope: { ...viewA.scope, stationId: 'station-two' },
  };
  client.setQueryData(accessKey, current);
  // Only the station identity changed, so the stale confirmation stays
  // open; confirming it must still send scope A with actor A.
  fireEvent.click(
    await screen.findByRole('button', { name: 'Confirm change' }),
  );
  await waitFor(() => expect(stub.posts).toHaveLength(1));
  expect(stub.posts[0].body).toMatchObject({
    principalId: contributor.id,
    revision: 7,
    status: 'revoked',
    expectedActor: admin.id,
  });
  const sentScope = stub.posts[0].body.scope as Record<string, string>;
  expect(sentScope.stationId).toBe('station-one');
  expect(sentScope.portableProjectId).toBe('prj_shared');
  expect(sentScope.localProjectId).toBe('local-one');
});

test('switching accounts clears the one-time invitation link', async () => {
  const stub: Stub = {
    posts: [],
    access: () => envelope(adminView()),
    observe: () => observation(['orchestration:read', 'orchestration:operate']),
    mutate: (url, body) =>
      url.endsWith('/invitations')
        ? invitationResponse(body)
        : envelope({ changed: true }),
  };
  stubFetch(stub);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const other = humanPrincipal('deployment', 'other-admin', 'Other Admin');
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <GuestProjectAccessView
        apiBase={apiBase}
        principalId={admin.id}
        project={project}
        onAccountRequired={vi.fn()}
        onAccessLost={vi.fn()}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Create invitation' }),
  );
  await screen.findByDisplayValue(/\/account\/join#invitation=/);
  rerender(
    <QueryClientProvider client={client}>
      <GuestProjectAccessView
        apiBase={apiBase}
        principalId={other.id}
        project={project}
        onAccountRequired={vi.fn()}
        onAccessLost={vi.fn()}
      />
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(
      screen.queryByDisplayValue(/\/account\/join#invitation=/),
    ).toBeNull(),
  );
});
