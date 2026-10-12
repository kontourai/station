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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AccessSection } from '../../../views/project-settings/AccessSection';

/**
 * #3586: InviteFlow as its consumer mounts it — the Project access panel over
 * the REAL SDK query and mutation, against a stubbed `fetch` — so the
 * assertions reach the request a Station receives and the link it answers.
 */

const host = vi.hoisted(() => ({
  apiBase: 'https://station.example.test',
  authorityKey: 'device-one',
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({ ...host }),
}));

const owner = humanPrincipal('deployment', 'owner', 'Owner');
const at = '2026-09-12T12:00:00.000Z';
const view: ProjectAccessAdministrationView = {
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
  ],
  invitations: [],
};
const TOKEN = 'k'.repeat(43);
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
const clients: QueryClient[] = [];
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  posts.length = 0;
  writeText.mockClear();
  setClientCredentialResolver(() => ({
    origin: host.apiBase,
    requestAuthority: { ...host, isCurrent: () => true },
  }));
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        posts.push({ path: url.pathname, body });
        return Response.json({
          success: true,
          data: {
            invitation: {
              id: 'inv-1',
              recipientEmail: body.email,
              role: body.role,
              actions: [...PROJECT_MEMBER_ROLES.contributor],
              invitedBy: owner,
              status: 'pending',
              expiresAt: body.expiresAt,
              createdAt: at,
            },
            token: TOKEN,
          },
        });
      }
      return Response.json({ success: true, data: view });
    }),
  );
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});

test('creates an email-restricted invitation and reveals its link to copy', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <AccessSection slug="example" projectId="local-one" />
    </QueryClientProvider>,
  );

  const create = (await screen.findByRole('button', {
    name: 'Create invitation',
  })) as HTMLButtonElement;
  await waitFor(() => expect(create.disabled).toBe(false));
  expect(screen.queryByRole('button', { name: 'Copy invitation' })).toBeNull();

  fireEvent.click(screen.getByLabelText('Require a verified email address'));
  // A required email that is still empty holds the form back.
  expect(create.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: '  mei@example.test ' },
  });
  fireEvent.change(screen.getByLabelText('Project role'), {
    target: { value: 'contributor' },
  });
  fireEvent.click(create);

  const link = (await screen.findByRole('textbox', {
    name: 'Invitation link',
  })) as HTMLInputElement;
  expect(link.value).toBe(`${host.apiBase}/account/join#invitation=${TOKEN}`);
  expect(
    screen.getByText('Invitation created. Copy the link to share it.'),
  ).toBeTruthy();
  expect(posts).toHaveLength(1);
  expect(posts[0]?.path).toMatch(/\/invitations$/);
  expect(posts[0]?.body).toMatchObject({
    scope: view.scope,
    email: 'mei@example.test',
    role: 'contributor',
  });
  // Created: the draft clears.
  expect(
    (screen.getByLabelText('Email address') as HTMLInputElement).value,
  ).toBe('');

  fireEvent.click(screen.getByRole('button', { name: 'Copy invitation' }));
  await screen.findByText('Invitation copied.');
  expect(writeText).toHaveBeenCalledWith(link.value);
});
