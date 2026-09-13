/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SystemSection } from '../views/settings/SystemSection';

vi.mock('@kontourai/station-sdk', () => ({
  useSystemStatusForApiBaseQuery: () => ({ data: undefined }),
}));
vi.mock('../views/settings/BuildProvenance', () => ({
  BuildProvenance: () => null,
  InstalledAppBuildProvenance: () => null,
}));
vi.mock('../views/settings/CoreUpdateCheck', () => ({
  CoreUpdateCheck: () => null,
}));
const platform = { isDesktop: false, isTauri: false };
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platform,
}));
vi.mock('../views/settings/DesktopUpdateCheck', () => ({
  DesktopUpdateCheck: () => (
    <button type="button">Check for desktop app updates</button>
  ),
}));

describe('SystemSection', () => {
  it('exposes separate desktop and server update cards', () => {
    const props = {
      apiBase: 'http://station.test',
      config: {} as never,
      onChange: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(async () => undefined),
      onResetToDefaults: vi.fn(),
    };
    const view = render(<SystemSection {...props} />);
    // Browser/web: no desktop card at all, but the server card keeps its own
    // label — the two update paths are distinct surfaces, not one row.
    expect(
      screen.queryByRole('button', { name: 'Check for desktop app updates' }),
    ).toBeNull();
    expect(screen.queryByText('Desktop app updates')).toBeNull();
    expect(screen.getByText('Connected Station server')).not.toBeNull();
    platform.isDesktop = true;
    platform.isTauri = true;
    try {
      view.rerender(<SystemSection {...props} />);
      expect(
        screen.getByRole('button', { name: 'Check for desktop app updates' }),
      ).not.toBeNull();
      // The desktop card is its own catalog row, rendered above the server.
      const desktopCard = screen
        .getByText('Desktop app updates')
        .closest('[data-catalog-id]');
      const serverCard = screen
        .getByText('Connected Station server')
        .closest('[data-catalog-id]');
      expect(desktopCard?.getAttribute('data-catalog-id')).toBe(
        'desktop-app-updates',
      );
      expect(serverCard?.getAttribute('data-catalog-id')).toBe(
        'core-app-updates',
      );
      expect(
        desktopCard!.compareDocumentPosition(serverCard!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    } finally {
      platform.isDesktop = false;
      platform.isTauri = false;
    }
  });
  it('distinguishes settings JSON from a full Station-home backup', () => {
    render(
      <SystemSection
        apiBase="http://station.test"
        config={{} as never}
        onChange={vi.fn()}
        onExport={vi.fn()}
        onImport={vi.fn(async () => undefined)}
        onResetToDefaults={vi.fn()}
      />,
    );

    expect(screen.getByText('Settings Export & Import')).not.toBeNull();
    expect(
      screen.getByText(
        /This does not include projects, sessions, or credentials/,
      ),
    ).not.toBeNull();
    expect(screen.getByText('station home backup')).not.toBeNull();
  });

  it('reports a changed Log Level through the Settings save model', () => {
    const onChange = vi.fn();
    render(
      <SystemSection
        apiBase="http://station.test"
        config={{ logLevel: 'info' } as never}
        onChange={onChange}
        onExport={vi.fn()}
        onImport={vi.fn(async () => undefined)}
        onResetToDefaults={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('Log Level'), {
      target: { value: 'debug' },
    });
    expect(onChange).toHaveBeenCalledWith({ logLevel: 'debug' });
  });
});
