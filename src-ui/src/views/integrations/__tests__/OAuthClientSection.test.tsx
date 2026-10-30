/** @vitest-environment jsdom */
import type { IntegrationViewModel } from '@kontourai/station-sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  unbind: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  bindingsRefetch: vi.fn(),
  bindingsError: null as Error | null,
  configured: {
    integrationId: 'gmail',
    secretEnvBindingIds: {},
  } as {
    integrationId: string;
    secretEnvBindingIds: Record<string, string>;
    oauthClientSecretBindingId?: string;
  },
  bindings: [] as Array<Record<string, unknown>>,
}));

vi.mock('@kontourai/station-sdk/secret-bindings-query', () => ({
  useSecretBindingsQuery: () => ({
    data: mocks.bindingsError ? undefined : mocks.bindings,
    isLoading: false,
    isError: Boolean(mocks.bindingsError),
    error: mocks.bindingsError,
    refetch: mocks.bindingsRefetch,
  }),
  useIntegrationSecretBindingQuery: () => ({
    data: mocks.configured,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useBindOAuthClientSecretMutation: () => ({
    mutateAsync: mocks.bind,
    isPending: false,
  }),
  useUnbindOAuthClientSecretMutation: () => ({
    mutateAsync: mocks.unbind,
    isPending: false,
  }),
  useRefreshSecretBindingState: () => mocks.refresh,
}));

import { OAuthClientSection } from '../OAuthClientSection';

const base: IntegrationViewModel = {
  id: 'gmail',
  kind: 'mcp',
  transport: 'streamable-http',
  endpoint: 'https://gmailmcp.googleapis.com/mcp/v1',
};

let latest: IntegrationViewModel = base;
function Harness({
  initial = base,
  isNew = false,
}: {
  initial?: IntegrationViewModel;
  isNew?: boolean;
}) {
  const [form, setForm] = useState(initial);
  latest = form;
  return (
    <OAuthClientSection
      editForm={form}
      isNew={isNew}
      locked={false}
      requireSave={false}
      onUpdate={(update) => setForm(update)}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  latest = base;
  mocks.bindingsError = null;
  mocks.configured = { integrationId: 'gmail', secretEnvBindingIds: {} };
  mocks.bindings = [
    {
      id: 'gmail-client',
      name: 'Gmail client secret',
      revision: 2,
      availability: { backend: 'keychain', available: true },
      grants: [],
    },
    {
      id: 'alice-only',
      name: 'Alice key',
      revision: 1,
      owner: { kind: 'principal', principalId: 'human:x' },
      availability: { backend: 'env', available: true },
      grants: [],
    },
  ];
});

/**
 * One change event per keystroke, each appending to the field's live value,
 * as a person typing does. A field that re-derives its text from the parsed
 * list drops the space before the next key reads it.
 */
function typeInto(element: HTMLElement, text: string) {
  const field = element as HTMLInputElement | HTMLTextAreaElement;
  for (const character of text)
    fireEvent.change(field, { target: { value: field.value + character } });
}

describe('OAuthClientSection', () => {
  test('typing scopes key by key keeps the spaces between them', () => {
    render(<Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} />);
    const scopes = screen.getByLabelText(
      'Default scopes',
    ) as HTMLTextAreaElement;
    typeInto(scopes, 'mail.readonly mail.compose');
    expect(scopes.value).toBe('mail.readonly mail.compose');
    expect(latest.oauthClient?.scopes).toEqual([
      'mail.readonly',
      'mail.compose',
    ]);
    // Leaving the field lists one scope per line, so long URLs stay readable.
    fireEvent.blur(scopes);
    expect(scopes.value).toBe('mail.readonly\nmail.compose');
    expect(scopes.tagName).toBe('TEXTAREA');
  });

  test('a client secret cannot be bound until an authorization server is declared', () => {
    render(<Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} />);
    fireEvent.change(screen.getByLabelText('Client secret'), {
      target: { value: 'gmail-client' },
    });
    expect(
      (screen.getByRole('button', { name: 'Bind' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText('Save an authorization server first to bind a secret.'),
    ).toBeTruthy();
  });

  test('the authorization server is offered while the client fields are folded, for registered clients too', () => {
    render(<Harness />);
    expect(
      screen
        .getByRole('button', { name: 'Use your own OAuth client' })
        .getAttribute('aria-expanded'),
    ).toBe('false');
    fireEvent.change(
      screen.getByLabelText('Authorization server (recommended)'),
      { target: { value: 'https://accounts.example.com' } },
    );
    expect(latest.oauthClient).toEqual({
      issuer: 'https://accounts.example.com',
    });
  });

  test('the declared authorization server is part of the client draft', () => {
    render(<Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} />);
    fireEvent.change(
      screen.getByLabelText('Authorization server (recommended)'),
      {
        target: { value: ' https://accounts.google.com ' },
      },
    );
    expect(latest.oauthClient).toEqual({
      clientId: 'c',
      issuer: 'https://accounts.google.com',
    });
  });

  test('stays folded until opened, then edits the client into the integration draft', () => {
    render(<Harness />);
    const toggle = screen.getByRole('button', {
      name: 'Use your own OAuth client',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText('Client ID')).toBeNull();

    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: ' 123.apps.googleusercontent.com ' },
    });
    fireEvent.change(screen.getByLabelText('Default scopes'), {
      target: {
        value: 'https://www.googleapis.com/auth/gmail.readonly  openid',
      },
    });
    expect(latest.oauthClient).toEqual({
      clientId: '123.apps.googleusercontent.com',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'openid'],
    });

    // Clearing every field removes the client rather than saving an empty one.
    fireEvent.change(screen.getByLabelText('Client ID'), {
      target: { value: '' },
    });
    fireEvent.change(screen.getByLabelText('Default scopes'), {
      target: { value: '' },
    });
    expect(latest).not.toHaveProperty('oauthClient');
  });

  test('opens itself and flags the server when a client ID is required', () => {
    render(
      <Harness
        initial={{
          ...base,
          probe: {
            ok: false,
            toolCount: 0,
            checkedAt: '2026-10-28T00:00:00.000Z',
            authorization: { state: 'client-id-required', reason: 'x' },
          },
        }}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'Use your own OAuth client' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('Client ID required')).toBeTruthy();
  });

  test('binds a shared secret binding as the client secret and offers no person-owned one', async () => {
    mocks.bind.mockResolvedValue({ outcome: 'complete' });
    render(
      <Harness
        initial={{
          ...base,
          oauthClient: { clientId: 'c', issuer: 'https://accounts.google.com' },
        }}
      />,
    );
    const select = screen.getByLabelText('Client secret') as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      '',
      'gmail-client',
    ]);
    fireEvent.change(select, { target: { value: 'gmail-client' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind' }));
    await waitFor(() =>
      expect(mocks.bind).toHaveBeenCalledWith({
        id: 'gmail-client',
        integrationId: 'gmail',
        expectedRevision: 2,
      }),
    );
    expect(mocks.refresh).toHaveBeenCalled();
  });

  test('shows the bound secret and removes it', async () => {
    mocks.configured = {
      integrationId: 'gmail',
      secretEnvBindingIds: {},
      oauthClientSecretBindingId: 'gmail-client',
    };
    mocks.unbind.mockResolvedValue({ outcome: 'complete' });
    render(<Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} />);
    expect(screen.getByText('Gmail client secret')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(mocks.unbind).toHaveBeenCalledWith({
        id: 'gmail-client',
        integrationId: 'gmail',
        expectedRevision: 2,
      }),
    );
  });

  test('a new integration must be saved before choosing a secret', () => {
    render(
      <Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} isNew />,
    );
    expect(
      screen.getByText('Save the integration to choose a secret binding.'),
    ).toBeTruthy();
  });

  test('a failed binding read offers a retry that refetches', () => {
    mocks.bindingsError = new Error('offline');
    render(<Harness initial={{ ...base, oauthClient: { clientId: 'c' } }} />);
    expect(screen.getByText('Could not load secret bindings')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.bindingsRefetch).toHaveBeenCalled();
  });
});
