/** @vitest-environment jsdom */
import type { PersonalAccessToken } from '@kontourai/station-contracts/personal-tokens';
import type { StationPerson } from '@kontourai/station-contracts/station-groups';
import { _setApiBase } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
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
    ownerPrincipalId: 'human:tailscale-serve:ada@example.com',
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
    principalId: 'human:tailscale-serve:ada@example.com',
    displayName: 'ada@example.com',
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
    canHoldTokens: true,
    ...overrides,
  };
}

/** An account-bound person: their id is the deployment account principal. */
function grace(overrides: Partial<StationPerson> = {}): StationPerson {
  return {
    principalId: `human:deployment:${'a'.repeat(64)}`,
    displayName: 'Grace Hopper',
    group: 'member',
    assigned: false,
    devices: [
      {
        id: 'dev-grace',
        name: 'Grace’s browser',
        scope: 'orchestration:read',
        effectiveScope: 'orchestration:read',
      },
    ],
    tokens: [],
    canHoldTokens: false,
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
  return {
    client,
    ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>),
  };
}

/** Whether a query under `prefix` has settled into an error. */
function settledInError(client: QueryClient, prefix: string) {
  return client
    .getQueryCache()
    .findAll({ queryKey: [prefix] })
    .some((query) => query.state.status === 'error');
}

const PEOPLE_KEY = 'station-people';
const OWN_KEY = 'own-access-tokens';
const ADA_PATH =
  '/api/pairing/people/human%3Atailscale-serve%3Aada%40example.com';

/** Opens the New token form, fills it and submits. */
async function createToken(
  newLabel: string,
  name: string,
  options: { operate?: boolean; expiry?: string } = {},
) {
  fireEvent.click(await screen.findByRole('button', { name: newLabel }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  if (options.operate) fireEvent.click(screen.getByLabelText(/Read & operate/));
  if (options.expiry)
    fireEvent.change(screen.getByLabelText('Expires after'), {
      target: { value: options.expiry },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
}

/** A People route that answers from `people`, which a test may change. */
function peopleRoute(people: () => StationPerson[]): Handler {
  return (call) =>
    call.method === 'GET' && call.path === '/api/pairing/people'
      ? json({ people: people() })
      : undefined;
}

const writes = () => calls.filter((call) => call.method !== 'GET');

/** One person's list item. */
function personItem(principalId: string): HTMLElement {
  const item = document.querySelector(
    `[data-principal-id="${principalId}"]`,
  ) as HTMLElement | null;
  if (!item) throw new Error(`no person ${principalId}`);
  return item;
}

/** A person's row toggle, found by their display name. */
function toggleButton(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^▸?\\s*${name}`) });
}

function toggle(name: string) {
  fireEvent.click(toggleButton(name));
}

/** Seven people, enough for the filter. */
function crowd(): StationPerson[] {
  return ['ada', 'grace', 'lin', 'mei', 'omar', 'priya', 'tomas'].map((login) =>
    ada({
      principalId: `human:tailscale-serve:${login}@example.com`,
      displayName: `${login}@example.com`,
    }),
  );
}
const NEW_FOR_ADA = 'New token for ada@example.com';

describe('People section', () => {
  test('promoting PUTs the group at once and shows it', async () => {
    let current = ada();
    const list = peopleRoute(() => [current]);
    handler = (call) => {
      if (call.method === 'PUT' && call.path === `${ADA_PATH}/group`) {
        current = ada({ group: 'admin', assigned: true });
        return json({ person: current, revocations: {} });
      }
      return list(call);
    };
    mount(<PeopleSection />);

    const select = (await screen.findByLabelText(
      'Group for ada@example.com',
    )) as HTMLSelectElement;
    expect(select.value).toBe('member');
    fireEvent.change(select, { target: { value: 'admin' } });

    await waitFor(() => expect(select.value).toBe('admin'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(writes()).toEqual([
      { method: 'PUT', path: `${ADA_PATH}/group`, body: { group: 'admin' } },
    ]);
  });

  test('demoting asks first, then reports the full access it reset', async () => {
    let current = ada({ group: 'admin', assigned: true });
    const list = peopleRoute(() => [current]);
    handler = (call) => {
      if (call.method === 'PUT') {
        current = ada();
        return json({
          person: current,
          revocations: { 'dev-ada': { conversations: [] } },
        });
      }
      return list(call);
    };
    mount(<PeopleSection />);

    const select = (await screen.findByLabelText(
      'Group for ada@example.com',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'member' } });

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('full access');
    expect(writes()).toEqual([]);
    expect(select.value).toBe('admin');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(select.value).toBe('member'));
    expect(writes()).toEqual([
      { method: 'PUT', path: `${ADA_PATH}/group`, body: { group: 'member' } },
    ]);
    expect(
      await screen.findByText('Full access was reset on 1 device.'),
    ).toBeTruthy();
  });

  test('a cancelled demotion changes nothing', async () => {
    handler = peopleRoute(() => [ada({ group: 'admin', assigned: true })]);
    mount(<PeopleSection />);
    const select = (await screen.findByLabelText(
      'Group for ada@example.com',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'member' } });
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(writes()).toEqual([]);
    expect(select.value).toBe('admin');
  });

  test('a 401 group change says the operator credential is needed and keeps the group', async () => {
    const list = peopleRoute(() => [ada()]);
    handler = (call) =>
      call.method === 'PUT'
        ? json({ error: 'authentication_required' }, 401)
        : list(call);
    mount(<PeopleSection />);

    const select = (await screen.findByLabelText(
      'Group for ada@example.com',
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'admin' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('operator credential');
    expect(alert.textContent).toContain('can only view');
    expect(select.value).toBe('member');
  });

  test('a group store that cannot take the change says so', async () => {
    const list = peopleRoute(() => [ada()]);
    handler = (call) =>
      call.method === 'PUT'
        ? json({ error: 'groups_unavailable' }, 503)
        : list(call);
    mount(<PeopleSection />);
    fireEvent.change(
      await screen.findByLabelText('Group for ada@example.com'),
      {
        target: { value: 'admin' },
      },
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Groups can’t be changed on this Station right now',
    );
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
      name: 'Devices for ada@example.com',
    });
    const [capped, plain] = within(devices).getAllByRole('listitem');
    expect(capped?.textContent).toContain('Limited by Member group');
    expect(plain?.textContent).not.toContain('Limited');
  });

  test('a new token’s secret is shown once, focus follows, and it is gone after Done', async () => {
    let tokens: PersonalAccessToken[] = [];
    const list = peopleRoute(() => [ada({ tokens })]);
    handler = (call) => {
      if (call.method === 'POST' && call.path === `${ADA_PATH}/tokens`) {
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
    const { client } = mount(<PeopleSection />);

    fireEvent.click(await screen.findByRole('button', { name: NEW_FOR_ADA }));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: '  CI  ' },
    });
    fireEvent.click(screen.getByLabelText(/Read & operate/));
    fireEvent.change(screen.getByLabelText('Expires after'), {
      target: { value: 'never' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const secret = await screen.findByDisplayValue('stp_secret_value');
    expect(screen.getByText(/won’t be shown again/)).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Copy' }),
      ),
    );
    // The secret is never inside a live region; only the copy result is.
    expect(secret.closest('[role="status"],[role="alert"],[aria-live]')).toBe(
      null,
    );
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: `${ADA_PATH}/tokens`,
        // "Never" sends no expiry; the name is trimmed.
        body: { name: 'CI', scope: 'orchestration:read orchestration:operate' },
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue('stp_secret_value')).toBeNull(),
    );
    expect(document.body.textContent).not.toContain('stp_secret_value');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: NEW_FOR_ADA }),
      ),
    );
    // Nor does the mutation cache keep it once captured.
    await waitFor(() =>
      expect(
        JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state),
        ),
      ).not.toContain('stp_secret_value'),
    );
    const listed = await screen.findByRole('list', {
      name: 'Tokens for ada@example.com',
    });
    expect(listed.textContent).toContain('CI');
    expect(listed.textContent).toContain('Read & operate');
  });

  test('Cancel returns focus to + New', async () => {
    handler = peopleRoute(() => [ada()]);
    mount(<PeopleSection />);
    fireEvent.click(await screen.findByRole('button', { name: NEW_FOR_ADA }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: NEW_FOR_ADA }),
      ),
    );
  });

  test.each([
    ['refused', () => json({ error: { code: 'insufficient_scope' } }, 403)],
    ['failing', () => json({ error: 'boom' }, 500)],
  ])(
    'the secret survives a list refetch that comes back %s after the mint',
    async (label, afterMint) => {
      let minted = false;
      const list = peopleRoute(() => [ada()]);
      handler = (call) => {
        if (call.method === 'POST') {
          minted = true;
          return json({ token: token(), secret: 'stp_keep_me' }, 201);
        }
        return minted && call.method === 'GET' ? afterMint() : list(call);
      };
      const { client } = mount(<PeopleSection />);

      await createToken(NEW_FOR_ADA, 'CI');
      expect(await screen.findByDisplayValue('stp_keep_me')).toBeTruthy();
      await waitFor(() =>
        expect(settledInError(client, PEOPLE_KEY)).toBe(true),
      );
      expect(screen.getByDisplayValue('stp_keep_me')).toBeTruthy();
      if (label === 'failing') {
        // A failure that is not a refusal keeps the cached list, marked as
        // not refreshed, with the secret still inside its owner's card.
        const card = personItem('human:tailscale-serve:ada@example.com');
        expect(within(card).getByDisplayValue('stp_keep_me')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toContain(
          'couldn’t be refreshed',
        );
      }
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      await waitFor(() =>
        expect(screen.queryByDisplayValue('stp_keep_me')).toBeNull(),
      );
    },
  );

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
          path: `${ADA_PATH}/tokens/tok-1`,
          body: undefined,
        },
      ]),
    );
  });

  test('a person who cannot hold tokens gets no + New, says why, and can still lose one', async () => {
    const list = peopleRoute(() => [
      ada(),
      grace({ tokens: [token({ id: 'tok-g', name: 'Old script' })] }),
    ]);
    handler = (call) =>
      call.method === 'DELETE' ? json({ revoked: true }) : list(call);
    mount(<PeopleSection />);

    await screen.findByText('Grace Hopper');
    toggle('Grace Hopper');
    toggle('ada@example.com');
    const card = personItem(`human:deployment:${'a'.repeat(64)}`);
    const scoped = within(card);
    expect(scoped.queryByRole('button', { name: /New token/ })).toBeNull();
    expect(card.textContent).toContain('Tailscale identity');
    expect(screen.getByRole('button', { name: NEW_FOR_ADA })).toBeTruthy();

    fireEvent.click(
      scoped.getByRole('button', { name: 'Revoke token Old script' }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await waitFor(() =>
      expect(writes().map((call) => call.method)).toEqual(['DELETE']),
    );
  });

  test('a revoke the token store cannot take says so and keeps the dialog', async () => {
    const list = peopleRoute(() => [ada({ tokens: [token()] })]);
    handler = (call) =>
      call.method === 'DELETE'
        ? json({ error: 'tokens_unavailable' }, 503)
        : list(call);
    mount(<PeopleSection />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Revoke token Release script',
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(dialog.textContent).toContain('right now'));
  });

  test('people start collapsed, summarised, and marked when a device is limited', async () => {
    handler = peopleRoute(() => [
      ada(),
      grace({ tokens: [token({ id: 'tok-g' })] }),
    ]);
    mount(<PeopleSection />);

    await screen.findByText('Grace Hopper');
    const adaToggle = toggleButton('ada@example.com');
    expect(adaToggle.getAttribute('aria-expanded')).toBe('false');
    expect(adaToggle.textContent).toContain('1 device · 0 tokens');
    // Ada's one device is capped by her group; Grace's is not.
    expect(adaToggle.textContent).toContain('1 limited');
    expect(toggleButton('Grace Hopper').textContent).toContain(
      '1 device · 1 token',
    );
    expect(toggleButton('Grace Hopper').textContent).not.toContain('limited');
    // Collapsed: no principal id, no devices, no tokens.
    expect(screen.queryByText('human:tailscale-serve:ada@example.com')).toBe(
      null,
    );
    expect(screen.queryByRole('list', { name: /Devices for/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New token/ })).toBeNull();
  });

  test('a row opens and closes from its native toggle button', async () => {
    handler = peopleRoute(() => [ada(), grace()]);
    mount(<PeopleSection />);
    await screen.findByText('Grace Hopper');
    const adaToggle = toggleButton('ada@example.com');

    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('true');
    const bodyId = adaToggle.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId as string)?.textContent).toContain(
      'human:tailscale-serve:ada@example.com',
    );
    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('false');

    // Keyboard operation is the platform's: the toggle is a native button
    // (Enter and Space activate it), focusable, and not a div with a handler.
    // jsdom does not synthesise that activation; the screenshot run drives it.
    expect(adaToggle.tagName).toBe('BUTTON');
    expect(adaToggle.getAttribute('type')).toBe('button');
    adaToggle.focus();
    expect(document.activeElement).toBe(adaToggle);
  });

  test('the only person opens by themselves, and can still be closed', async () => {
    handler = peopleRoute(() => [ada()]);
    mount(<PeopleSection />);
    await screen.findByText('human:tailscale-serve:ada@example.com');
    const adaToggle = toggleButton('ada@example.com');
    expect(adaToggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('the Group picker does not open or close the row', async () => {
    handler = peopleRoute(() => [ada(), grace()]);
    mount(<PeopleSection />);
    await screen.findByText('Grace Hopper');
    const select = screen.getByLabelText('Group for ada@example.com');
    fireEvent.click(select);
    fireEvent.keyDown(select, { key: 'Enter' });
    expect(toggleButton('ada@example.com').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  test('an open form or an unshown secret keeps its person open', async () => {
    const list = peopleRoute(() => [ada(), grace()]);
    handler = (call) =>
      call.method === 'POST'
        ? json({ token: token({ name: 'CI' }), secret: 'stp_pinned' }, 201)
        : list(call);
    mount(<PeopleSection />);
    await screen.findByText('Grace Hopper');
    const adaToggle = toggleButton('ada@example.com');
    fireEvent.click(adaToggle);

    // With the form open, collapsing is refused.
    fireEvent.click(screen.getByRole('button', { name: NEW_FOR_ADA }));
    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Name')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'CI' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByDisplayValue('stp_pinned')).toBeTruthy();

    // With the secret showing, too.
    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByDisplayValue('stp_pinned')).toBeTruthy();

    // After Done the row may close again.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(adaToggle);
    expect(adaToggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('a filter appears at six people and matches name or principal id', async () => {
    handler = peopleRoute(() => crowd().slice(0, 5));
    const first = mount(<PeopleSection />);
    await screen.findByText('omar@example.com');
    expect(screen.queryByLabelText('Filter')).toBeNull();
    first.unmount();

    handler = peopleRoute(crowd);
    mount(<PeopleSection />);
    await screen.findByText('tomas@example.com');
    const filter = screen.getByLabelText('Filter');
    fireEvent.change(filter, { target: { value: 'PRIYA' } });
    expect(screen.getAllByRole('button', { expanded: false })).toHaveLength(1);
    expect(screen.getByText('priya@example.com')).toBeTruthy();
    expect(screen.queryByText('ada@example.com')).toBeNull();

    fireEvent.change(filter, { target: { value: 'tailscale-serve:mei' } });
    expect(screen.getByText('mei@example.com')).toBeTruthy();
    expect(screen.queryByText('priya@example.com')).toBeNull();

    fireEvent.change(filter, { target: { value: 'zzz' } });
    expect(screen.getByText('Nobody matches that filter.')).toBeTruthy();
  });

  test('one secret at a time: while one shows, every other + New waits', async () => {
    const mei = ada({
      principalId: 'human:tailscale-serve:mei@example.com',
      displayName: 'mei@example.com',
    });
    const list = peopleRoute(() => [ada(), mei]);
    handler = (call) =>
      call.method === 'POST'
        ? json({ token: token({ name: 'CI' }), secret: 'stp_first' }, 201)
        : list(call);
    mount(<PeopleSection />);
    await screen.findByText('mei@example.com');
    toggle('ada@example.com');
    await createToken(NEW_FOR_ADA, 'CI');
    expect(await screen.findByDisplayValue('stp_first')).toBeTruthy();

    toggle('mei@example.com');
    const meiNew = within(
      personItem('human:tailscale-serve:mei@example.com'),
    ).getByRole('button', { name: 'New token for mei@example.com' });
    // Waiting, not disabled: focusable, and described by a visible reason.
    expect(meiNew.getAttribute('aria-disabled')).toBe('true');
    expect((meiNew as HTMLButtonElement).disabled).toBe(false);
    expect(
      within(personItem('human:tailscale-serve:mei@example.com')).getByRole(
        'button',
        {
          name: 'New token for mei@example.com',
          description: 'Finish with the token that is showing first.',
        },
      ),
    ).toBe(meiNew);
    meiNew.focus();
    expect(document.activeElement).toBe(meiNew);
    fireEvent.click(meiNew);
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByDisplayValue('stp_first')).toBeTruthy();
    expect(writes().filter((call) => call.method === 'POST')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(
        within(personItem('human:tailscale-serve:mei@example.com'))
          .getByRole('button', { name: 'New token for mei@example.com' })
          .getAttribute('aria-disabled'),
      ).toBeNull(),
    );
  });

  test('the only person, opened by default, stays open when a refetch adds a second', async () => {
    let people = [ada()];
    handler = peopleRoute(() => people);
    const { client } = mount(<PeopleSection />);
    await screen.findByText('human:tailscale-serve:ada@example.com');
    people = [
      ...people,
      ada({
        principalId: 'human:tailscale-serve:mei@example.com',
        displayName: 'mei@example.com',
      }),
    ];
    await act(() => client.invalidateQueries({ queryKey: ['station-people'] }));
    await screen.findByText('mei@example.com');
    expect(toggleButton('ada@example.com').getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  test('the only person stays open when a refetch adds a second, even mid-revoke', async () => {
    let people = [ada({ tokens: [token()] })];
    handler = peopleRoute(() => people);
    const { client } = mount(<PeopleSection />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Revoke token Release script',
      }),
    );
    expect(await screen.findByRole('alertdialog')).toBeTruthy();

    people = [
      ...people,
      ada({
        principalId: 'human:tailscale-serve:mei@example.com',
        displayName: 'mei@example.com',
      }),
    ];
    await act(() => client.invalidateQueries({ queryKey: ['station-people'] }));
    await screen.findByText('mei@example.com');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(toggleButton('ada@example.com').getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(toggleButton('mei@example.com').getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  test('a filter keeps the row with an unshown secret, and the row with a draft', async () => {
    const list = peopleRoute(crowd);
    handler = (call) =>
      call.method === 'POST'
        ? json({ token: token({ name: 'CI' }), secret: 'stp_filtered' }, 201)
        : list(call);
    mount(<PeopleSection />);
    await screen.findByText('tomas@example.com');

    toggle('ada@example.com');
    await createToken(NEW_FOR_ADA, 'CI');
    expect(await screen.findByDisplayValue('stp_filtered')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    // A draft in Omar's row survives a filter that does not match him.
    toggle('omar@example.com');
    fireEvent.click(
      screen.getByRole('button', { name: 'New token for omar@example.com' }),
    );
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Half-typed' },
    });
    fireEvent.change(screen.getByLabelText('Filter'), {
      target: { value: 'priya' },
    });
    expect(screen.getByText('priya@example.com')).toBeTruthy();
    expect(screen.getByText('omar@example.com')).toBeTruthy();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Half-typed',
    );
    expect(screen.queryByText('mei@example.com')).toBeNull();
  });

  test('a secret survives a filter that does not match its owner', async () => {
    const list = peopleRoute(crowd);
    handler = (call) =>
      call.method === 'POST'
        ? json({ token: token({ name: 'CI' }), secret: 'stp_kept' }, 201)
        : list(call);
    mount(<PeopleSection />);
    await screen.findByText('tomas@example.com');
    toggle('ada@example.com');
    await createToken(NEW_FOR_ADA, 'CI');
    expect(await screen.findByDisplayValue('stp_kept')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter'), {
      target: { value: 'priya' },
    });
    expect(screen.getByText('ada@example.com')).toBeTruthy();
    expect(
      within(
        personItem('human:tailscale-serve:ada@example.com'),
      ).getByDisplayValue('stp_kept'),
    ).toBeTruthy();
  });

  test('Done on a secret whose person left the list focuses the section', async () => {
    let minted = false;
    const list = peopleRoute(() => (minted ? [] : [ada()]));
    handler = (call) => {
      if (call.method === 'POST') {
        minted = true;
        return json({ token: token(), secret: 'stp_orphan' }, 201);
      }
      return list(call);
    };
    mount(<PeopleSection />);
    await createToken(NEW_FOR_ADA, 'CI');
    expect(await screen.findByDisplayValue('stp_orphan')).toBeTruthy();
    await screen.findByText('Nothing here yet');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe('section-people'),
    );
  });

  test('no one tied to a device shows the empty state', async () => {
    handler = peopleRoute(() => []);
    mount(<PeopleSection />);
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
  });

  test('a caller the route refuses sees no People section at all', async () => {
    handler = () => json({ error: { code: 'insufficient_scope' } }, 403);
    const { client, container } = mount(<PeopleSection />);
    await waitFor(() => expect(settledInError(client, PEOPLE_KEY)).toBe(true));
    expect(container.textContent).toBe('');
  });

  test('a server failure is shown, not hidden', async () => {
    handler = () => json({ error: 'boom' }, 500);
    mount(<PeopleSection />);
    expect(await screen.findByText('People could not be listed')).toBeTruthy();
  });
});

describe('Your access tokens', () => {
  test('a device tied to no person sees nothing, not an error', async () => {
    handler = () => json({ error: { code: 'person_device_required' } }, 403);
    const { client, container } = mount(<OwnAccessTokensPanel />);
    await waitFor(() => expect(settledInError(client, OWN_KEY)).toBe(true));
    expect(container.textContent).toBe('');
  });

  test('a server failure is shown, not hidden', async () => {
    handler = () => json({ error: 'boom' }, 500);
    mount(<OwnAccessTokensPanel />);
    expect(
      await screen.findByText('Your tokens could not be listed'),
    ).toBeTruthy();
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
    const { client } = mount(<OwnAccessTokensPanel />);

    expect(await screen.findByText('Your access tokens')).toBeTruthy();
    expect(screen.getByText('Release script')).toBeTruthy();
    await createToken('New token for you', 'Notebook');

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
    await waitFor(() =>
      expect(
        JSON.stringify(
          client
            .getMutationCache()
            .getAll()
            .map((mutation) => mutation.state),
        ),
      ).not.toContain('stp_own_secret'),
    );
  });

  test('the secret survives the panel being refused after the mint', async () => {
    let minted = false;
    handler = (call) => {
      if (call.method === 'POST') {
        minted = true;
        return json({ token: token(), secret: 'stp_still_here' }, 201);
      }
      return minted
        ? json({ error: { code: 'person_device_required' } }, 403)
        : json({ tokens: [] });
    };
    const { client } = mount(<OwnAccessTokensPanel />);
    await createToken('New token for you', 'CI');
    expect(await screen.findByDisplayValue('stp_still_here')).toBeTruthy();
    await waitFor(() => expect(settledInError(client, OWN_KEY)).toBe(true));
    expect(screen.getByDisplayValue('stp_still_here')).toBeTruthy();
  });

  test('an account-bound person minting their own token is told why not', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json({ tokens: [] })
        : json({ error: { code: 'account_bound_person' } }, 400);
    mount(<OwnAccessTokensPanel />);
    await createToken('New token for you', 'Script');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Tailscale identity',
    );
  });

  test('a mint the token store cannot take says so', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json({ tokens: [] })
        : json({ error: { code: 'tokens_unavailable' } }, 503);
    mount(<OwnAccessTokensPanel />);
    await createToken('New token for you', 'Script');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'right now',
    );
  });

  test('a mint the device may not make says why', async () => {
    handler = (call) =>
      call.method === 'GET'
        ? json({ tokens: [] })
        : json({ error: { code: 'scope_exceeds_access' } }, 400);
    mount(<OwnAccessTokensPanel />);
    await createToken('New token for you', 'Too much', { operate: true });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'more access than this device has',
    );
  });
});
