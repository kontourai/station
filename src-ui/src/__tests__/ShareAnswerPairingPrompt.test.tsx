/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * archive#1423. The reviewer's ruling, as tests: do the pairing REQUEST
 * inline, never the confirm, and say what the grant actually is.
 *
 * The continuity flow ends in `DEFAULT_GRANT_PAIRING_SCOPE` — full authority
 * over the Station, `access:manage` included — so the host-side approve step
 * follows a public access request and never creates protected-route authority
 * from a loopback position.
 * Auto-confirming here would functionally reopen.
 */

const requestCurrentStationAccess = vi.fn();
const navigate = vi.fn();

vi.mock('@kontourai/station-connect', () => ({
  requestCurrentStationAccess: (input: unknown) =>
    requestCurrentStationAccess(input),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test:3141' }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));

const { ShareAnswerPairingPrompt } = await import(
  '../components/chat/ShareAnswerPairingPrompt'
);

beforeEach(() => {
  requestCurrentStationAccess.mockReset();
  requestCurrentStationAccess.mockResolvedValue({ requestId: 'r1' });
  navigate.mockReset();
});

describe('ShareAnswerPairingPrompt', () => {
  it('says the grant is full Station access, not a sharing permission', () => {
    const { container } = render(<ShareAnswerPairingPrompt />);
    const text = container.textContent ?? '';

    expect(text).toContain('full access to this Station');
    expect(text).toContain('managing devices');
    expect(text).toContain('not just sharing');
  });

  it('sends only the REQUEST, and never confirms it', async () => {
    render(<ShareAnswerPairingPrompt />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Request pairing for this browser' }),
    );

    expect(requestCurrentStationAccess).toHaveBeenCalledWith({
      endpoint: 'http://station.test:3141',
      deviceName: 'This browser',
    });
    // The confirm/exchange half must not be reachable from here at all.
    expect(
      await screen.findByText(/will not grant anything until you approve it/),
    ).toBeTruthy();
  });

  it('points at the surface where the operator approves it themselves', async () => {
    render(<ShareAnswerPairingPrompt />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Request pairing for this browser' }),
    );

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Open Connections to approve',
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/connections');
  });

  it('reports a failed request rather than implying the browser is now paired', async () => {
    requestCurrentStationAccess.mockRejectedValue(
      new Error('origin_forbidden'),
    );
    render(<ShareAnswerPairingPrompt />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Request pairing for this browser' }),
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/Request sent/)).toBeNull();
  });
});
