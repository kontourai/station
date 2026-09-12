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
    <button type="button">Check for Desktop Updates</button>
  ),
}));

describe('SystemSection', () => {
  it('exposes native update checks only in the desktop shell', () => {
    const props = {
      apiBase: 'http://station.test',
      config: {} as never,
      onChange: vi.fn(),
      onExport: vi.fn(),
      onImport: vi.fn(async () => undefined),
      onResetToDefaults: vi.fn(),
    };
    const view = render(<SystemSection {...props} />);
    expect(
      screen.queryByRole('button', { name: 'Check for Desktop Updates' }),
    ).toBeNull();
    platform.isDesktop = true;
    platform.isTauri = true;
    try {
      view.rerender(<SystemSection {...props} />);
      expect(
        screen.getByRole('button', { name: 'Check for Desktop Updates' }),
      ).not.toBeNull();
      expect(screen.getByText('Connected Station updates')).not.toBeNull();
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
