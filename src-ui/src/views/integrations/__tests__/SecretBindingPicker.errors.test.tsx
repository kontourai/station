// @vitest-environment jsdom

import { StationHttpError } from '@kontourai/station-sdk/client';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const refusal = new StationHttpError(
  400,
  'Validation failed: expectedRevision Expected a non-negative integer.',
  {
    details: {
      fieldErrors: { expectedRevision: ['Expected a non-negative integer.'] },
    },
  },
);

vi.mock('@kontourai/station-sdk/secret-bindings-query', () => ({
  useSecretBindingsQuery: () => ({
    data: [],
    error: refusal,
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

/**
 * #2708: a validation refusal's thrown message is field-qualified for CLI and
 * agent readers. This surface shows the server's reason, never the schema key.
 */
describe('SecretBindingPicker load failure', () => {
  test('shows the server reason, not the field key or the validation prefix', () => {
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
