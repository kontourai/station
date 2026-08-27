/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

let authState: 'authenticated' | 'unauthenticated' | 'unknown' =
  'unauthenticated';
const refetch = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useEnrolmentQuery: () => ({
    data: {
      authState,
      detail:
        authState === 'authenticated'
          ? 'person@example.com (ChatGPT)'
          : undefined,
      command: {
        command: 'codex',
        args: ['login'],
        env: { CODEX_HOME: '/private/profile' },
        description: 'Signs in with Codex itself.',
      },
    },
    error: null,
    isLoading: false,
    isFetching: false,
    refetch,
  }),
}));

import { CredentialProfileEnrolment } from '../views/CredentialProfileEnrolment';

describe('CredentialProfileEnrolment', () => {
  test.each([
    ['authenticated', 'Signed in'],
    ['unauthenticated', 'Signed out'],
    ['unknown', 'Sign-in status unknown'],
  ] as const)('renders %s as its own sign-in state', (state, label) => {
    authState = state;
    render(
      <CredentialProfileEnrolment
        connectionId="codex"
        profileRef="work-account"
      />,
    );

    expect(screen.getByText(label)).toBeTruthy();
    if (state === 'unknown') {
      expect(screen.queryByText('Signed out')).toBeNull();
    }
  });

  test('reveals the user-run command and re-checks only when asked', () => {
    authState = 'authenticated';
    render(
      <CredentialProfileEnrolment
        connectionId="codex"
        profileRef="work-account"
      />,
    );

    expect(screen.getByText('person@example.com (ChatGPT)')).toBeTruthy();
    fireEvent.click(screen.getByText('Show sign-in command'));
    expect(screen.getByText('codex')).toBeTruthy();
    expect(screen.getByText('login')).toBeTruthy();
    expect(screen.getByText('CODEX_HOME=/private/profile')).toBeTruthy();
    expect(screen.getByText('Signs in with Codex itself.')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: "I've run it — check again" }),
    );
    expect(refetch).toHaveBeenCalledOnce();
  });
});
