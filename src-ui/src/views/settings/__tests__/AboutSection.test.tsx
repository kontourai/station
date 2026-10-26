/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openExternalLink = vi.fn(async (_url: string) => true);
vi.mock('../../../platform/openExternalLink', () => ({
  openExternalLink: (url: string) => openExternalLink(url),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({
    isTauri: false,
    isDevBuild: false,
    productName: 'Station Nightly',
    channel: 'nightly',
  }),
}));
vi.mock('../../../contexts/AccountPreferencesContext', () => ({
  useAccountPreferences: () => ({ status: 'device', saving: false }),
}));

import { AboutSection } from '../AboutSection';

const fetchMock = vi.fn<typeof fetch>();

function renderAbout(onOpenSection = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <AboutSection onOpenSection={onOpenSection} />
    </QueryClientProvider>,
  );
  return onOpenSection;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  openExternalLink.mockClear();
});

describe('Settings → About', () => {
  it('lists the bundled packages only once opened, with each license text', async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        packages: [
          {
            name: 'react',
            version: '19.0.0',
            license: 'MIT',
            text: 'MIT License — react',
          },
          { name: 'tiny', version: '1.0.0', license: 'ISC' },
        ],
      }),
    );
    renderAbout();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Bundled packages' }));
    expect(
      await screen.findByRole('button', { name: '2 packages' }),
    ).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/third-party-licenses.json',
      expect.anything(),
    );
    expect(screen.getByText('MIT License — react')).toBeTruthy();
    expect(
      screen.getByText(/does not ship a license file; it declares ISC/),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter open source packages'), {
      target: { value: 'isc' },
    });
    expect(screen.queryByText('react')).toBeNull();
    expect(screen.getByText('tiny')).toBeTruthy();
  });

  it('offers a retry that refetches when the list is missing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }));
    renderAbout();
    fireEvent.click(screen.getByRole('button', { name: 'Bundled packages' }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(screen.getByText('License list unavailable')).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      Response.json({
        packages: [{ name: 'tiny', version: '1.0.0', license: 'ISC' }],
      }),
    );
    fireEvent.click(retry);
    expect(await screen.findByText('tiny')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('opens legal links outside the app and routes to diagnostics', () => {
    const onOpenSection = renderAbout();
    const legal = screen.getByRole('list', { name: 'Legal links' });
    fireEvent.click(
      within(legal).getByRole('link', { name: 'Privacy policy' }),
    );
    expect(openExternalLink).toHaveBeenCalledWith(
      'https://kontourai.io/privacy/station/',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    expect(onOpenSection).toHaveBeenCalledWith('diagnostics');
  });
});
