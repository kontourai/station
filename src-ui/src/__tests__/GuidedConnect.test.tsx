/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isTauri: false,
  productName: 'Station',
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: native.isTauri,
    isDesktop: false,
    productName: native.productName,
  }),
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionManagerModal: ({
    isOpen,
    initialPanel,
    hostAppName,
    onPairingSucceeded,
  }: {
    isOpen: boolean;
    initialPanel?: string;
    hostAppName?: string;
    onPairingSucceeded?: () => void;
  }) =>
    isOpen ? (
      <div data-host-app-name={hostAppName} data-testid="connection-manager">
        Connection manager: {initialPanel ?? 'list'}
        <button type="button" onClick={onPairingSucceeded}>
          Complete pairing
        </button>
      </div>
    ) : null,
}));

import { GuidedConnect } from '../components/GuidedConnect';

describe('GuidedConnect', () => {
  beforeEach(() => {
    native.isTauri = false;
    native.productName = 'Station';
  });

  test('renders the first-run welcome copy without error framing', () => {
    render(<GuidedConnect />);

    expect(screen.getByText('Connect to your Station host')).toBeTruthy();
    expect(
      screen.getByText(
        'Station runs on your computer or server. Connect this device to start working with your agents.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "On the same network? Use your host's IP address, not localhost.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('connection-manager')).toBeNull();
  });

  test.each([
    ['Pair with a code', 'pair-device'],
    ['Request access', 'request-access'],
    ['Enter a host address', 'add'],
  ] as const)(
    'opens the connection manager on the %s panel',
    (label, panel) => {
      render(<GuidedConnect />);

      fireEvent.click(screen.getByRole('button', { name: label }));

      expect(screen.getByText(`Connection manager: ${panel}`)).toBeTruthy();
    },
  );

  test('does not offer the sample tour unless the access gate asked for it', () => {
    render(<GuidedConnect />);
    expect(
      screen.queryByRole('button', { name: 'See how Station works' }),
    ).toBeNull();
  });

  test('offers the sample tour when the access gate can open it', () => {
    const onExploreSample = vi.fn();
    render(<GuidedConnect onExploreSample={onExploreSample} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'See how Station works' }),
    );

    expect(onExploreSample).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('connection-manager')).toBeNull();
  });

  test('notifies the access gate after a pairing exchange commits', () => {
    const onSessionEstablished = vi.fn();
    render(<GuidedConnect onSessionEstablished={onSessionEstablished} />);

    fireEvent.click(screen.getByRole('button', { name: 'Pair with a code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete pairing' }));

    expect(onSessionEstablished).toHaveBeenCalledTimes(1);
  });

  test('uses the local native package name for Request Access device naming', () => {
    native.isTauri = true;
    native.productName = 'Station Nightly';
    render(<GuidedConnect />);

    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

    expect(
      screen
        .getByTestId('connection-manager')
        .getAttribute('data-host-app-name'),
    ).toBe('Station Nightly');
  });
});
