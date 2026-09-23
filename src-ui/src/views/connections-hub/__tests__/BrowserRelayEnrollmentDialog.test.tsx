/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  close: vi.fn(),
  credentials: null as { username: string; password: string } | null,
  signal: null as AbortSignal | null,
}));

vi.mock('../../../lib/browserRelayRouteBinding', () => ({
  captureBrowserRelayRoute: mocks.capture,
}));
vi.mock('../../../lib/browserRelayEnrollmentController', () => ({
  BrowserRelayEnrollmentController: class {
    constructor(
      private readonly options: {
        onState(state: string): void;
      },
    ) {}
    enroll(
      credentials: { username: string; password: string },
      signal: AbortSignal,
    ) {
      mocks.credentials = { ...credentials };
      mocks.signal = signal;
      this.options.onState('awaiting-approval');
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    }
  },
}));
vi.mock('../../../lib/browserRelayApplicationAuthority', () => ({
  stageBrowserRelayApplicationAuthority: vi.fn(),
  publishBrowserRelayApplicationAuthority: vi.fn(),
  removeProvisionalBrowserRelayApplicationAuthority: vi.fn(),
}));

import { BrowserRelayEnrollmentDialog } from '../BrowserRelayEnrollmentDialog';

const connection = {
  id: 'saved-route',
  name: 'Home Station',
  url: 'https://station.example.test',
  brokerRoute: {
    brokerOrigin: 'https://broker.example.test',
    scope: {
      stationId: '11111111-1111-4111-8111-111111111111',
      enrollmentId: '22222222-2222-4222-8222-222222222222',
      routingGeneration: 1,
      browserOrigin: window.location.origin,
    },
  },
} as Parameters<typeof BrowserRelayEnrollmentDialog>[0]['connection'];

beforeEach(() => {
  mocks.capture.mockReset();
  mocks.close.mockReset();
  mocks.credentials = null;
  mocks.signal = null;
});

it('refuses to send account credentials when the encrypted Station route is absent', async () => {
  mocks.capture.mockReturnValue(null);
  render(
    <BrowserRelayEnrollmentDialog
      connection={connection}
      onClose={mocks.close}
    />,
  );
  fireEvent.change(screen.getByLabelText('Station account name'), {
    target: { value: 'zach' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'local-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify account' }));
  expect(
    await screen.findByText(
      'Reconnect to this Station before verifying your account.',
    ),
  ).toBeTruthy();
  expect(mocks.credentials).toBeNull();
});

it('clears the password while waiting for operator Device approval and cancels on close', async () => {
  mocks.capture.mockReturnValue({
    transport: vi.fn(),
    isCurrent: () => true,
  });
  render(
    <BrowserRelayEnrollmentDialog
      connection={connection}
      onClose={mocks.close}
    />,
  );
  fireEvent.change(screen.getByLabelText('Station account name'), {
    target: { value: 'zach' },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: 'local-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify account' }));
  expect(
    await screen.findByText(
      'Waiting for the Station operator to approve this Device…',
    ),
  ).toBeTruthy();
  expect(mocks.credentials).toEqual({
    username: 'zach',
    password: 'local-password',
  });
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe(
    '',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
  await waitFor(() => expect(mocks.signal?.aborted).toBe(true));
  expect(mocks.close).toHaveBeenCalledOnce();
});
