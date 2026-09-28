// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { AgentIcon } from '../components/icons/AgentIcon';
import { identiconHue } from '../utils/identicon';

describe('AgentIcon deterministic identicon fallback (station#1424)', () => {
  test('an agent with no icon and no recognized brand renders a seed-derived hue swatch with its initials, human-visibly', () => {
    const { container, getByText } = render(
      <AgentIcon agent={{ name: 'Widget Builder', slug: 'widget-builder' }} />,
    );
    // Human-visible: the initials text a reader actually sees.
    expect(getByText('WB')).toBeTruthy();

    const swatch = container.querySelector('.brand-icon--identicon');
    expect(swatch).toBeTruthy();
    expect(
      (swatch as HTMLElement).style.getPropertyValue('--identicon-hue'),
    ).toBe(String(identiconHue('widget-builder')));
  });

  test('two different unbranded agents get different deterministic hues', () => {
    const { container: a } = render(
      <AgentIcon agent={{ name: 'Alpha Agent', slug: 'alpha-agent' }} />,
    );
    const { container: b } = render(
      <AgentIcon agent={{ name: 'Beta Agent', slug: 'beta-agent' }} />,
    );
    const hueA = a
      .querySelector('.brand-icon--identicon')
      ?.getAttribute('style');
    const hueB = b
      .querySelector('.brand-icon--identicon')
      ?.getAttribute('style');
    expect(hueA).toBeTruthy();
    expect(hueB).toBeTruthy();
    expect(hueA).not.toBe(hueB);
  });

  test('a recognized brand (Claude) never uses the identicon swatch — the real mark still wins', () => {
    const { container } = render(
      <AgentIcon agent={{ name: 'Claude Code', slug: 'claude' }} />,
    );
    expect(container.querySelector('.brand-icon--identicon')).toBeNull();
    expect(container.querySelector('.brand-icon--claude')).toBeTruthy();
  });

  describe('station#1424 review fix (S5): seeded only from a committed identifier', () => {
    // Retyping during creation (AgentEditorIdentityFields.tsx's live
    // preview) must never colorize from the live-typed name.
    test.each([
      ['Untitled Agent', 'UA'],
      ['A Longer Typed Name', 'AL'],
    ])(
      'an agent named %j with neither slug nor id gets NO identicon — the flat fallback, not a name-derived guess',
      (name, initials) => {
        const { container, getByText } = render(<AgentIcon agent={{ name }} />);
        // Initials still render (the existing plain fallback)...
        expect(getByText(initials)).toBeTruthy();
        //...but never colorized from the live-typed name.
        expect(container.querySelector('.brand-icon--identicon')).toBeNull();
      },
    );

    test('a committed slug seeds the identicon even when name keeps changing (post-commit stability)', () => {
      const { container: renamed } = render(
        <AgentIcon agent={{ name: 'Renamed Agent', slug: 'stable-slug' }} />,
      );
      const { container: original } = render(
        <AgentIcon agent={{ name: 'Original Name', slug: 'stable-slug' }} />,
      );
      const expectedHue = String(identiconHue('stable-slug'));
      for (const container of [renamed, original]) {
        const swatch = container.querySelector<HTMLElement>(
          '.brand-icon--identicon',
        );
        expect(swatch).not.toBeNull();
        expect(swatch?.style.getPropertyValue('--identicon-hue')).toBe(
          expectedHue,
        );
      }
    });
  });
});
