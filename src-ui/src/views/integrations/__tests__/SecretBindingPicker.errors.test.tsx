// @vitest-environment jsdom

import { StationHttpError } from '@kontourai/station-sdk/client';
import { listSecretBindings } from '@kontourai/station-sdk/secret-bindings';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const query = vi.hoisted(() => ({ error: null as unknown }));

vi.mock('@kontourai/station-sdk/secret-bindings-query', () => ({
  useSecretBindingsQuery: () => ({
    data: [],
    error: query.error,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useIntegrationSecretBindingQuery: () => ({
    data: undefined,
    error: null,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useBindSecretBindingMutation: () => ({ isPending: false }),
  useUnbindSecretBindingMutation: () => ({ isPending: false }),
  useRefreshSecretBindingState: () => vi.fn(),
}));

import { SecretBindingPicker } from '../SecretBindingPicker';

afterEach(() => {
  vi.unstubAllGlobals();
  query.error = null;
});

/**
 * #2708: a validation refusal's thrown message is field-qualified for CLI and
 * agent readers. This surface shows the server's reason, never the schema key.
 * The error is the one the REAL secret-bindings fetcher throws for the shared
 * validation middleware's body, so a fetcher that dropped `details` fails here.
 */
describe('SecretBindingPicker load failure', () => {
  test('shows the server reason, not the field key or the validation prefix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Validation failed',
            details: {
              formErrors: [],
              fieldErrors: {
                expectedRevision: ['Expected a non-negative integer.'],
              },
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    query.error = await listSecretBindings('http://localhost').catch(
      (caught: unknown) => caught,
    );
    expect(query.error).toBeInstanceOf(StationHttpError);

    render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['GITHUB_TOKEN']}
        requireSave={false}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'Binding configuration could not be loaded: Expected a non-negative integer.',
    );
    expect(alert.textContent).not.toContain('expectedRevision');
    expect(alert.textContent).not.toContain('Validation failed');
  });
});
