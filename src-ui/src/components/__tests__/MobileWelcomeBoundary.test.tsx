// @vitest-environment jsdom
import type { SavedConnection } from '@kontourai/station-connect';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_CONNECTIONS_MODAL_EVENT } from '../../lib/connectionModalEvents';
import { MobileWelcomeBoundary } from '../MobileWelcomeBoundary';

const state = vi.hoisted(() => ({
  isMobile: true,
  connections: [] as SavedConnection[],
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: state.connections }),
}));
vi.mock('../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isMobile: state.isMobile }),
}));

afterEach(cleanup);
beforeEach(() => {
  state.isMobile = true;
  state.connections = [];
});

function savedConnection(): SavedConnection {
  return {
    profileVersion: 4,
    id: 'computer',
    name: 'My computer',
    url: 'https://computer.example',
    endpoints: [
      {
        endpointVersion: 1,
        id: 'direct',
        kind: 'lan-https',
        url: 'https://computer.example',
        priority: 0,
      },
    ],
    selectedEndpointId: 'direct',
    accessMethods: [
      {
        accessVersion: 1,
        id: 'direct',
        kind: 'direct-http',
        endpointId: 'direct',
      },
    ],
    selectedAccessMethodId: 'direct',
    environmentId: null,
    authProtocolVersion: null,
    capabilities: null,
    credentialRef: { credentialVersion: 1, kind: 'connection', id: 'computer' },
    credentialState: 'saved',
  };
}

describe('fresh phone connection entry', () => {
  it('withholds application effects and opens the existing connection flow', () => {
    const applicationMounted = vi.fn();
    function Application() {
      applicationMounted();
      return <div>Workspace</div>;
    }
    const onOpen = vi.fn();
    window.addEventListener(OPEN_CONNECTIONS_MODAL_EVENT, onOpen);
    try {
      render(
        <MobileWelcomeBoundary>
          <Application />
        </MobileWelcomeBoundary>,
      );
      expect(applicationMounted).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
        'Your work',
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Scan pairing QR code' }),
      );
      expect(onOpen).toHaveBeenCalledOnce();
      expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({
        mode: 'pair-device',
      });
    } finally {
      window.removeEventListener(OPEN_CONNECTIONS_MODAL_EVENT, onOpen);
    }
  });

  it.each([
    ['Enter a pairing code', 'pair-code'],
    ['Find nearby Stations', 'discover'],
    ['Other ways to connect', 'list'],
  ])('opens the existing %s fallback directly', (label, mode) => {
    const onOpen = vi.fn();
    window.addEventListener(OPEN_CONNECTIONS_MODAL_EVENT, onOpen);
    try {
      render(
        <MobileWelcomeBoundary>
          <div>Workspace</div>
        </MobileWelcomeBoundary>,
      );
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect((onOpen.mock.calls[0][0] as CustomEvent).detail).toEqual({ mode });
    } finally {
      window.removeEventListener(OPEN_CONNECTIONS_MODAL_EVENT, onOpen);
    }
  });

  it.each(['offline', 'authentication-failed'] as const)(
    'keeps recovery available for a saved Station with %s',
    (reason) => {
      state.connections = [
        { ...savedConnection(), lastError: { reason, at: 1 } },
      ];
      render(
        <MobileWelcomeBoundary>
          <div>Workspace recovery</div>
        </MobileWelcomeBoundary>,
      );
      expect(screen.getByText('Workspace recovery')).toBeTruthy();
      expect(
        screen.queryByRole('button', { name: 'Scan pairing QR code' }),
      ).toBeNull();
    },
  );

  it('hands off to the application when a Station is saved', () => {
    const view = render(
      <MobileWelcomeBoundary>
        <div>Workspace</div>
      </MobileWelcomeBoundary>,
    );
    state.connections = [savedConnection()];
    view.rerender(
      <MobileWelcomeBoundary>
        <div>Workspace</div>
      </MobileWelcomeBoundary>,
    );
    expect(screen.getByText('Workspace')).toBeTruthy();
    state.connections = [];
    view.rerender(
      <MobileWelcomeBoundary>
        <div>Workspace</div>
      </MobileWelcomeBoundary>,
    );
    expect(screen.queryByText('Workspace')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Scan pairing QR code' }),
    ).toBeTruthy();
  });

  it('keeps a desktop first session available without a saved remote Station', () => {
    state.isMobile = false;
    render(
      <MobileWelcomeBoundary>
        <div>Start a chat</div>
      </MobileWelcomeBoundary>,
    );
    expect(screen.getByText('Start a chat')).toBeTruthy();
  });
});
