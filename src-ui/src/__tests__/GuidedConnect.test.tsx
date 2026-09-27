/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isTauri: false,
  isMobile: false,
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
    isMobile: native.isMobile,
    productName: native.productName,
  }),
}));

vi.mock('@kontourai/station-connect', () => ({
  ConnectionManagerModal: ({
    isOpen,
    initialPanel,
    hostAppName,
    hasLocalStation,
    onPairingSucceeded,
  }: {
    isOpen: boolean;
    initialPanel?: string;
    hostAppName?: string;
    hasLocalStation?: boolean;
    onPairingSucceeded?: () => void;
  }) =>
    isOpen ? (
      <div
        data-host-app-name={hostAppName}
        data-has-local-station={String(hasLocalStation)}
        data-testid="connection-manager"
      >
        Connection manager: {initialPanel ?? 'list'}
        <button type="button" onClick={onPairingSucceeded}>
          Complete pairing
        </button>
      </div>
    ) : null,
}));
vi.mock('../views/connections-hub/BrowserRelayRoutes', () => ({
  BrowserRelayRoutes: () => (
    <section aria-label="Browser broker routes">
      Broker route setup ready
    </section>
  ),
}));

import { GuidedConnect } from '../components/GuidedConnect';

describe('GuidedConnect', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    native.isTauri = false;
    native.isMobile = false;
    native.productName = 'Station';
  });

  test('offers only the production app, even from a Nightly web build', () => {
    vi.stubEnv('VITE_NATIVE_APP_UPDATE_CHANNEL', 'nightly');
    render(<GuidedConnect />);
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Installed app')).toBeNull();
    expect(screen.queryByText('Station Nightly')).toBeNull();
    expect(
      screen
        .getByRole('link', { name: 'Open in the Station app' })
        .getAttribute('href'),
    ).toBe('station-stable://open-browser');
    expect(
      screen.getByRole('link', { name: 'Get Station' }).getAttribute('href'),
    ).toBe('https://station.kontourai.io/#start');
  });

  test('does not offer desktop app installation inside the native app', () => {
    native.isTauri = true;
    render(<GuidedConnect />);
    expect(
      screen.queryByRole('link', { name: 'Open in the Station app' }),
    ).toBeNull();
    expect(screen.queryByRole('link', { name: 'Get Station' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Use a broker invitation' }),
    ).toBeNull();
  });

  test('says why this browser landed here inside the full-screen layer (#2612)', () => {
    const { container } = render(
      <GuidedConnect notice="This sign-in link was already used, or a newer one replaced it." />,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(
      'This sign-in link was already used, or a newer one replaced it.',
    );
    // Inside the screen's own layer: it covers the viewport, so a notice
    // rendered beside it (where the gate used to put it) is never seen.
    expect(alert.closest('.guided-connect')).toBe(
      container.querySelector('.guided-connect'),
    );
  });

  test('renders the first-run welcome copy without error framing', () => {
    render(<GuidedConnect />);
    expect(screen.queryByRole('alert')).toBeNull();

    expect(screen.getByText('Connect to a Station')).toBeTruthy();
    expect(
      screen.getByText('Choose the computer where you want to work.'),
    ).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Another Station' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('connection-manager')).toBeNull();
  });

  test('lets a fresh browser open broker trust and invitation setup before pairing', async () => {
    render(<GuidedConnect />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Use a broker invitation' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Browser broker routes' }),
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

  test.each([
    ['web browser profile', false, false, 'true'],
    ['phone client profile', true, true, 'false'],
    ['desktop app profile', true, false, 'true'],
  ] as const)(
    'passes hasLocalStation=%s to the connection manager for a %s',
    (_label, isTauri, isMobile, expected) => {
      native.isTauri = isTauri;
      native.isMobile = isMobile;
      render(<GuidedConnect />);

      fireEvent.click(screen.getByRole('button', { name: 'Request access' }));

      expect(
        screen
          .getByTestId('connection-manager')
          .getAttribute('data-has-local-station'),
      ).toBe(expected);
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
