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
 * #2708: the load failure the picker shows is the error the REAL
 * secret-bindings fetcher throws for the route's own failure body. The route
 * (`src-server/routes/secret-bindings.ts`) answers a plain string `error` and
 * no validation `details`, so what the picker shows is that sentence; the
 * fetcher's error keeps the status it arrived under.
 */
describe('SecretBindingPicker load failure', () => {
  test('shows the route reason and keeps the status on the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'Secret binding consumer service unavailable.',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    query.error = await listSecretBindings('http://localhost').catch(
      (caught: unknown) => caught,
    );
    expect(query.error).toBeInstanceOf(StationHttpError);
    expect(query.error).toMatchObject({ status: 503 });

    render(
      <SecretBindingPicker
        integrationId="github"
        envNames={['GITHUB_TOKEN']}
        requireSave={false}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Binding configuration could not be loaded: Secret binding consumer service unavailable.',
    );
  });
});
