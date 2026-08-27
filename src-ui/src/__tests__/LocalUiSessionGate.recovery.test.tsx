/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';

vi.mock('../components/GuidedConnect', () => ({
  GuidedConnect: ({
    onSessionEstablished,
  }: {
    onSessionEstablished?: () => void;
  }) => (
    <button type="button" onClick={onSessionEstablished}>
      Complete pairing
    </button>
  ),
}));

function ProtectedDataProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div>Protected application mounted</div>;
}

afterEach(() => {
  resetLocalUiBootstrapForTests();
  vi.restoreAllMocks();
});

describe('LocalUiSessionGate pairing recovery (station#2093)', () => {
  test('rechecks exactly once after pairing succeeds and mounts protected providers when the new cookie authenticates', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
        <ProtectedDataProbe onMount={protectedMount} />
      </LocalUiSessionGate>,
    );
    await screen.findByRole('button', { name: 'Complete pairing' });

    fireEvent.click(screen.getByRole('button', { name: 'Complete pairing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete pairing' }));

    await waitFor(() => expect(protectedMount).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:42693/api/system/identity',
      'http://127.0.0.1:42693/api/system/identity',
    ]);
  });

  test('keeps recovery actionable when the success recheck fails without automatic fanout or retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 }));
    const protectedMount = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(
      <LocalUiSessionGate apiBase="http://127.0.0.1:42693">
        <ProtectedDataProbe onMount={protectedMount} />
      </LocalUiSessionGate>,
    );
    await screen.findByRole('button', { name: 'Complete pairing' });
    fireEvent.click(screen.getByRole('button', { name: 'Complete pairing' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(
      screen.getByRole('button', { name: 'Complete pairing' }),
    ).toBeTruthy();
    expect(protectedMount).not.toHaveBeenCalled();
  });
});
