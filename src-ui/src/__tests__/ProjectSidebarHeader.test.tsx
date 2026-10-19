/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';

function renderHeader({
  isMobile = false,
  channelBadge,
}: {
  isMobile?: boolean;
  channelBadge?: string;
} = {}) {
  const onCloseMobile = vi.fn();
  const onGoHome = vi.fn();
  const result = render(
    <ProjectSidebarHeader
      appName="Station"
      homeLabel={
        channelBadge ? `Station ${channelBadge} v0.1.2` : 'Station v0.1.2'
      }
      channelBadge={channelBadge}
      isMobile={isMobile}
      onCloseMobile={onCloseMobile}
      onGoHome={onGoHome}
    />,
  );

  return {
    ...result,
    onCloseMobile,
    onGoHome,
  };
}

describe('ProjectSidebarHeader', () => {
  test('keeps the brand as Home while the app header owns desktop collapse', () => {
    const expanded = renderHeader();
    const home = screen.getByRole('button', { name: 'Station v0.1.2 home' });
    expect(home.getAttribute('type')).toBe('button');
    expect(home.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.queryByRole('button', { name: 'Collapse sidebar' }),
    ).toBeNull();
    fireEvent.click(home);
    expect(expanded.onGoHome).toHaveBeenCalledOnce();
  });

  test('keeps an installed channel out of the wordmark and visible as a badge', () => {
    const { container } = renderHeader({ channelBadge: 'Nightly' });
    const home = screen.getByRole('button', {
      name: 'Station Nightly v0.1.2 home',
    });

    expect(home.getAttribute('title')).toBe('Station Nightly v0.1.2 home');
    expect(
      container.querySelector('.sidebar__brand-name > span')?.textContent,
    ).toBe('Station');
    expect(
      container.querySelector('.sidebar__channel-badge')?.textContent,
    ).toBe('Nightly');
    expect(
      container.querySelector('.sidebar__brand-name')?.children[1]?.className,
    ).toBe('sidebar__channel-badge');
  });

  test('keeps the mobile close control as the drawer focus target', () => {
    const mobile = renderHeader({ isMobile: true });
    const close = screen.getByRole('button', { name: 'Close navigation' });

    expect(close.getAttribute('title')).toBe('Close navigation');
    expect(mobile.container.querySelector('.sidebar__mobile-close')).toBe(
      close,
    );
    expect(
      screen.queryByRole('button', { name: 'Collapse sidebar' }),
    ).toBeNull();

    fireEvent.click(close);
    expect(mobile.onCloseMobile).toHaveBeenCalledOnce();
    expect(mobile.onGoHome).not.toHaveBeenCalled();
  });
});
