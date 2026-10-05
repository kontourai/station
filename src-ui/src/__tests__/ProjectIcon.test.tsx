/**
 * @vitest-environment jsdom
 */

import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  displayableProjectIcon,
  ProjectIcon,
} from '../components/icons/ProjectIcon';

// The writer's shape: discovery and the picker store base64 data URLs.
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function mark(ui: React.ReactElement) {
  const { container } = render(ui);
  return container.firstElementChild as HTMLElement | null;
}

describe('ProjectIcon', () => {
  test('draws a stored image through BrandIcon', () => {
    const el = mark(
      <ProjectIcon project={{ name: 'Station', icon: PNG }} size={18} />,
    );
    expect(el?.classList.contains('brand-icon')).toBe(true);
    expect(el?.querySelector('img')?.getAttribute('src')).toBe(PNG);
    expect(el?.style.width).toBe('18px');
  });

  test('draws a glyph as text', () => {
    const el = mark(
      <ProjectIcon project={{ name: 'Station', icon: '🧭' }} size={18} />,
    );
    expect(el?.querySelector('.brand-icon__glyph')?.textContent).toBe('🧭');
    expect(el?.querySelector('img')).toBeNull();
  });

  test.each([
    ['a local absolute path', '/Users/me/secrets/logo.png'],
    ['a remote URL', 'https://example.com/logo.png'],
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ])(
    'a refused value (%s) is never drawn: the colour stands in',
    (_label, icon) => {
      expect(displayableProjectIcon(icon)).toBeUndefined();
      const el = mark(
        <ProjectIcon
          project={{ name: 'Station', icon }}
          size={12}
          accent="var(--event-tool-call)"
        />,
      );
      expect(el?.querySelector('img')).toBeNull();
      expect(el?.textContent).toBe('');
      expect(el?.classList.contains('project-icon--dot')).toBe(true);
      expect(el?.style.backgroundColor).toBe('var(--event-tool-call)');
    },
  );

  test('with no icon, the fallback is the accent swatch the surface asks for', () => {
    const dot = mark(
      <ProjectIcon project={{ name: 'Station' }} size={12} accent="red" />,
    );
    expect(dot?.classList.contains('project-icon--dot')).toBe(true);
    expect([dot?.style.width, dot?.style.height]).toEqual(['6px', '6px']);

    const bar = mark(
      <ProjectIcon
        project={{ name: 'Station' }}
        size={28}
        accent="red"
        fallback="bar"
      />,
    );
    expect([bar?.style.width, bar?.style.height]).toEqual(['3px', '22px']);

    const initials = mark(
      <ProjectIcon
        project={{ name: 'Station' }}
        size={48}
        fallback="initials"
      />,
    );
    expect(initials?.querySelector('.brand-icon__initials')?.textContent).toBe(
      'ST',
    );
  });

  test('a swatch-only class never lands on an icon', () => {
    const icon = mark(
      <ProjectIcon
        project={{ name: 'Station', icon: PNG }}
        size={28}
        accent="red"
        fallback="bar"
        swatchClassName="bar-only"
      />,
    );
    expect(icon?.classList.contains('bar-only')).toBe(false);
    const bar = mark(
      <ProjectIcon
        project={{ name: 'Station' }}
        size={28}
        accent="red"
        fallback="bar"
        swatchClassName="bar-only"
      />,
    );
    expect(bar?.classList.contains('bar-only')).toBe(true);
  });

  test('draws nothing when there is no icon and nothing to fall back to', () => {
    expect(mark(<ProjectIcon project={{ name: 'Station' }} size={12} />)).toBe(
      null,
    );
    expect(
      mark(
        <ProjectIcon
          project={{ name: 'Station' }}
          size={12}
          accent="red"
          fallback="none"
        />,
      ),
    ).toBe(null);
  });

  test('is decorative beside a name, and labelled when it stands alone', () => {
    const decorative = mark(
      <ProjectIcon project={{ name: 'Station', icon: PNG }} size={18} />,
    );
    expect(decorative?.getAttribute('aria-hidden')).toBe('true');
    expect(decorative?.getAttribute('role')).toBeNull();

    const labelled = mark(
      <ProjectIcon
        project={{ name: 'Station', icon: PNG }}
        size={18}
        label="Station"
      />,
    );
    expect(labelled?.getAttribute('role')).toBe('img');
    expect(labelled?.getAttribute('aria-label')).toBe('Station');

    const labelledSwatch = mark(
      <ProjectIcon
        project={{ name: 'Station' }}
        size={12}
        accent="red"
        label="Station"
      />,
    );
    expect(labelledSwatch?.getAttribute('role')).toBe('img');
    expect(labelledSwatch?.getAttribute('aria-label')).toBe('Station');
  });
});
