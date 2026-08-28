/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProjectSidebarHeader } from '../components/project-sidebar/ProjectSidebarHeader';

function renderHeader({
  collapsed = false,
  isMobile = false,
}: {
  collapsed?: boolean;
  isMobile?: boolean;
} = {}) {
  const onCloseMobile = vi.fn();
  const onGoHome = vi.fn();
  const onToggleCollapse = vi.fn();
  const result = render(
    <ProjectSidebarHeader
      appName="Station"
      collapsed={collapsed}
      isMobile={isMobile}
      onCloseMobile={onCloseMobile}
      onGoHome={onGoHome}
      onToggleCollapse={onToggleCollapse}
    />,
  );

  return {
    ...result,
    onCloseMobile,
    onGoHome,
    onToggleCollapse,
  };
}

describe('ProjectSidebarHeader', () => {
  test('keeps Home and explicit desktop collapse controls separate', () => {
    const expanded = renderHeader();
    const collapse = screen.getByRole('button', {
      name: 'Collapse sidebar',
    });

    expect(collapse.getAttribute('title')).toBe('Collapse sidebar');
    const home = screen.getByRole('button', { name: 'Station home' });
    expect(home.tagName).toBe('BUTTON');
    expect(home.getAttribute('type')).toBe('button');
    expect(home.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(
      screen.queryByRole('button', { name: 'Close navigation' }),
    ).toBeNull();

    fireEvent.click(collapse);
    expect(expanded.onToggleCollapse).toHaveBeenCalledOnce();
    expect(expanded.onGoHome).not.toHaveBeenCalled();

    fireEvent.click(home);
    expect(expanded.onGoHome).toHaveBeenCalledOnce();

    expanded.rerender(
      <ProjectSidebarHeader
        appName="Station"
        collapsed
        isMobile={false}
        onCloseMobile={expanded.onCloseMobile}
        onGoHome={expanded.onGoHome}
        onToggleCollapse={expanded.onToggleCollapse}
      />,
    );

    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(expand.getAttribute('title')).toBe('Expand sidebar');
    fireEvent.click(expand);
    expect(expanded.onToggleCollapse).toHaveBeenCalledTimes(2);
    expect(expanded.onGoHome).toHaveBeenCalledOnce();
  });

  test('places the collapse button after the brand-name lockup on desktop (header lockup order)', () => {
    const { container } = renderHeader();

    const header = container.querySelector('.sidebar__header');
    const children = Array.from(header?.children ?? []);
    const homeIndex = children.findIndex((el) =>
      el.classList.contains('sidebar__home-button'),
    );
    const collapseIndex = children.findIndex((el) =>
      el.classList.contains('sidebar__collapse-button'),
    );

    // Desktop DOM order: home-button (logo + brand) -> collapse-button, so
    // the collapse button's own `margin-left: auto` pushes itself to the
    // header's right edge instead of pushing the brand name away from the
    // logo (archive#1629).
    expect(homeIndex).toBeGreaterThanOrEqual(0);
    expect(
      children[homeIndex]?.querySelector('.sidebar__brand-name'),
    ).toBeTruthy();
    expect(collapseIndex).toBeGreaterThan(homeIndex);
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
    expect(mobile.onToggleCollapse).not.toHaveBeenCalled();
    expect(mobile.onGoHome).not.toHaveBeenCalled();
  });
});
