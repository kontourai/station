/** @vitest-environment jsdom */
import type { PersonalAccessToken } from '@kontourai/station-contracts/personal-tokens';
import type { StationPerson } from '@kontourai/station-contracts/station-groups';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { OwnAccessTokensPanel } from '../OwnAccessTokensPanel';
import { PeopleSection } from '../PeopleSection';

/**
 * #3557: Settings › People and "Your access tokens", driven through the REAL
 * SDK request functions against a stubbed `fetch`, so each assertion reaches
 * the route, method and body a Station would receive — not a mocked hook.
 */

const API = 'http://station.test';
const STANDARD = 'orchestration:read orchestration:operate terminal:operate';
const FULL = `${STANDARD} coding:exec approval:full-access`;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

let calls: Call[] = [];
type Handler = (call: Call) => Response | undefined;
let handler: Handler = () => undefined;

const json = (body: unknown, status = 200) => Response.json(body, { status });

function token(overrides: Partial<PersonalAccessToken> = {}) {
  return {
    id: 'tok-1',
    name: 'Release script',
    ownerPrincipalId: 'human:tailscale:ada',
    scope: 'orchestration:read',
    effectiveScope: 'orchestration:read',
    createdAt: Date.now() - 86_400_000,
    expiresAt: null,
    lastUsedAt: null,
    ...overrides,
  } satisfies PersonalAccessToken;
}

function ada(overrides: Partial<StationPerson> = {}): StationPerson {
  return {
    principalId: 'human:tailscale:ada',
    displayName: 'Ada',
    group: 'member',
    assigned: false,
    devices: [
      {
        id: 'dev-ada',
        name: 'Ada’s laptop',
        scope: FULL,
        effectiveScope: STANDARD,
      },
    ],
    tokens: [],
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
  handler = () => undefined;
  _setApiBase(API);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      const call = {
        method: init?.method ?? 'GET',
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return handler(call) ?? json({ error: 'not_found' }, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** A People route that answers from `people`, which a test may change. */
function peopleRoute(people: () => StationPerson[]): Handler {
  return (call) =>
    call.method === 'GET' && call.path === '/api/pairing/people'
      ? json({ people: people() })
      : undefined;
}

const writes = () => calls.filter((call) => call.method !== 'GET');

describe('People section', () => {
  test('changing a group PUTs it and shows the new group', async () => {
    let current = ada();
    const list = peopleRoute(() => [current]);
    handler = (call) => {
      if (
        call.method === 'PUT' &&
        call.path === '/api/pairing/people/human%3Atailscale%3Aada/group'
      ) {
        current = ada({ group: 'admin', assigned: true });
        return json({ person: current, revocations: {} });
      }
      return list(call);
    };
    mount(<PeopleSection />);

    const select = (await screen.findByLabelText(
      'Group for Ada',
    )) as HTMLSelectElement;
    expect(select.value).toBe('member');
    fireEvent.change(select, { target: { value: 'admin' } });

    await waitFor(() => expect(select.value).toBe('admin'));
    expect(writes()).toEqual([
      {
        method: 'PUT',
        path: '/api/pairing/people/human%3Atailscale%3Aada/group',
        body: { group: 'admin' },
      },
    ]);
    expect(screen.getByText(/approve other devices/)).toBeTruthy();
  });

  test('a 401 group change says the operator credential is needed and keeps the group', async () => {
    const list = peopleRoute(() => [ada()]);
    handler = (call) =>
      call.method === 'PUT'
        ? json({ error: 'authentication_required' }, 401)
        : list(call);
    mount(<PeopleSection />);

    const select = (await screen.findByLabelText(
      'Group for Ada',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'admin' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('operator credential');
    expect(alert.textContent).toContain('can only view');
    expect(select.value).toBe('member');
  });

  test('a device the group caps says so; one it does not, does not', async () => {
    handler = peopleRoute(() => [
      ada({
        devices: [
          {
            id: 'dev-capped',
            name: 'Capped laptop',
            scope: FULL,
            effectiveScope: STANDARD,
          },
          {
            id: 'dev-plain',
            name: 'Plain phone',
            // Same permissions in a different order is not a limit.
            scope: 'terminal:operate orchestration:read orchestration:operate',
            effectiveScope: STANDARD,
          },
        ],
      }),
    ]);
    mount(<PeopleSection />);

    const devices = await screen.findByRole('list', {
      name: 'Devices for Ada',
    });
    const [capped, plain] = within(devices).getAllByRole('listitem');
    expect(capped?.textContent).toContain('Limited by Member group');
    expect(plain?.textContent).not.toContain('Limited');
  });

  test('a new token’s secret is shown once and is gone after Done', async () => {
    let tokens: PersonalAccessToken[] = [];
    const list = peopleRoute(() => [ada({ tokens })]);
    handler = (call) => {
      if (
        call.method === 'POST' &&
        call.path === '/api/pairing/people/human%3Atailscale%3Aada/tokens'
      ) {
        const minted = token({
          name: 'CI',
          scope: 'orchestration:read orchestration:operate',
          effectiveScope: 'orchestration:read orchestration:operate',
        });
        tokens = [minted];
        return json({ token: minted, secret: 'stp_secret_value' }, 201);
      }
      return list(call);
    };
    mount(<PeopleSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: '  CI  ' },
    });
    fireEvent.click(screen.getByLabelText(/Read & operate/));
    fireEvent.change(screen.getByLabelText('Expires after'), {
      target: { value: 'never' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    const secret = await screen.findByDisplayValue('stp_secret_value');
    expect(screen.getByText(/won’t be shown again/)).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/api/pairing/people/human%3Atailscale%3Aada/tokens',
        // "Never" sends no expiry; the name is trimmed.
        body: { name: 'CI', scope: 'orchestration:read orchestration:operate' },
      },
    ]);
    expect(secret).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('stp_secret_value')).toBeNull(),
    );
    expect(document.body.textContent).not.toContain('stp_secret_value');
    // The list now carries the token, without its secret.
    const listed = await screen.findByRole('list', { name: 'Tokens for Ada' });
    expect(listed.textContent).toContain('CI');
    expect(listed.textContent).toContain('Read & operate');
  });

  test('revoking a token asks first, then DELETEs it', async () => {
    const list = peopleRoute(() => [ada({ tokens: [token()] })]);
    handler = (call) =>
      call.method === 'DELETE' ? json({ revoked: true }) : list(call);
    mount(<PeopleSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Revoke token Release script',
      }),
    );
    expect(writes()).toEqual([]);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(writes()).toEqual([
        {
          method: 'DELETE',
          path: '/api/pairing/people/human%3Atailscale%3Aada/tokens/tok-1',
          body: undefined,
        },
      ]),
    );
  });

  test('no one tied to a device shows the empty state', async () => {
    handler = peopleRoute(() => []);
    mount(<PeopleSection />);
    expect(
      await screen.findByText('No one else has a device tied to them yet.'),
    ).toBeTruthy();
  });

  test('a caller the route refuses sees no People section at all', async () => {
    handler = () => json({ error: { code: 'insufficient_scope' } }, 403);
    const { container } = mount(<PeopleSection />);
    await waitFor(() => expect(calls).toHaveLength(1));
    // Give the refusal time to settle into the query before reading the DOM.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });
});

describe('Your access tokens', () => {
  test('a device tied to no person sees nothing, not an error', async () => {
    handler = () => json({ error: { code: 'person_device_required' } }, 403);
    const { container } = mount(<OwnAccessTokensPanel />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
  });

  test('a person’s own device lists and mints their tokens on the self-service route', async () => {
    let tokens: PersonalAccessToken[] = [token()];
    handler = (call) => {
      if (call.path !== '/api/access/tokens') return undefined;
      if (call.method === 'GET') return json({ tokens });
      const minted = token({ id: 'tok-2', name: 'Notebook' });
      tokens = [...tokens, minted];
      return json({ token: minted, secret: 'stp_own_secret' }, 201);
    };
    mount(<OwnAccessTokensPanel />);

    expect(await screen.findByText('Your access tokens')).toBeTruthy();
    expect(screen.getByText('Release script')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New token' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Notebook' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    expect(await screen.findByDisplayValue('stp_own_secret')).toBeTruthy();
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/api/access/tokens',
        // The defaults: Read, 90 days.
        body: {
          name: 'Notebook',
          scope: 'orchestration:read',
          expiresInDays: 90,
        },
      },
    ]);
  });

  test('a mint the device may not make says why', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json({ tokens: [] })
        : json({ error: { code: 'scope_exceeds_access' } }, 400);
    mount(<OwnAccessTokensPanel />);

    fireEvent.click(await screen.findByRole('button', { name: 'New token' }));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Too much' },
    });
    fireEvent.click(screen.getByLabelText(/Read & operate/));
    fireEvent.click(screen.getByRole('button', { name: 'Create token' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'more access than it has',
    );
  });
});
