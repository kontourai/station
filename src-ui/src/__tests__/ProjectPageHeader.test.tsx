/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ProjectPageHeader } from '../views/project-page/ProjectPageHeader';

afterEach(cleanup);

function renderHeader(
  overrides: Partial<Parameters<typeof ProjectPageHeader>[0]> = {},
) {
  const props = {
    project: { name: 'Station' },
    gitStatus: null,
    navigateToSettings: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<ProjectPageHeader {...props} />);
  return { ...props, unmount };
}

describe('ProjectPageHeader identity', () => {
  test('settings remains directly reachable without a local folder editor in the header', () => {
    const props = renderHeader();
    expect(screen.getByRole('heading', { name: 'Station' })).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /working directory/i }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Project settings' }));
    expect(props.navigateToSettings).toHaveBeenCalledOnce();
  });
});

describe('the header draws the project icon', () => {
  test('a stored image is drawn beside the name; a refused value falls back to initials', () => {
    const image = 'data:image/png;base64,iVBORw0KGgo=';
    const first = renderHeader({
      project: {
        name: 'Station',
        icon: image,
      },
    });
    const identity = document.querySelector('.project-page__identity');
    expect(identity?.querySelector('img')?.getAttribute('src')).toBe(image);
    first.unmount();

    renderHeader({
      project: {
        name: 'Station',
        icon: 'https://example.com/logo.png',
      },
    });
    const fallback = document.querySelector('.project-page__identity');
    expect(fallback?.querySelector('img')).toBeNull();
    expect(fallback?.querySelector('.brand-icon__initials')?.textContent).toBe(
      'ST',
    );
  });
});
