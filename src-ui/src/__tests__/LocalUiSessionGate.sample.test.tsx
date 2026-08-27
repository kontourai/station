/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { firstRunStore } from '../components/first-run/first-run-store';
import { LocalUiSessionGate } from '../components/LocalUiSessionGate';
import { resetLocalUiBootstrapForTests } from '../lib/local-ui-bootstrap';

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionManagerModal: () => null,
}));

function ProtectedDataProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div>Protected application mounted</div>;
}

afterEach(() => {
  resetLocalUiBootstrapForTests();
  firstRunStore.reset();
  vi.restoreAllMocks();
});

describe('LocalUiSessionGate unpaired sample (station#2652)', () => {
  test('opens the sample tour without mounting protected providers or pairing', async () => {
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

    fireEvent.click(
      await screen.findByRole('button', { name: 'See how Station works' }),
    );

    expect(await screen.findByTestId('unpaired-sample-workspace')).toBeTruthy();
    expect(protectedMount).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:42693/api/system/identity',
    );

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Connect your Station' })[0],
    );
    expect(
      screen.getByRole('button', { name: 'See how Station works' }),
    ).toBeTruthy();
    expect(protectedMount).not.toHaveBeenCalled();
  });
});
