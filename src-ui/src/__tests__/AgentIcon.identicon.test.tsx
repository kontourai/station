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

  test('the same agent always resolves to the same hue across separate renders', () => {
    const { container: first } = render(
      <AgentIcon agent={{ name: 'Repeat Agent', slug: 'repeat-agent' }} />,
    );
    const { container: second } = render(
      <AgentIcon agent={{ name: 'Repeat Agent', slug: 'repeat-agent' }} />,
    );
    expect(
      first.querySelector('.brand-icon--identicon')?.getAttribute('style'),
    ).toBe(
      second.querySelector('.brand-icon--identicon')?.getAttribute('style'),
    );
  });

  test('a recognized brand (Claude) never uses the identicon swatch — the real mark still wins', () => {
    const { container } = render(
      <AgentIcon agent={{ name: 'Claude Code', slug: 'claude' }} />,
    );
    expect(container.querySelector('.brand-icon--identicon')).toBeNull();
    expect(container.querySelector('.brand-icon--claude')).toBeTruthy();
  });

  describe('station#1424 review fix (S5): seeded only from a committed identifier', () => {
    test('an agent with neither slug nor id gets NO identicon — the flat fallback, not a name-derived guess', () => {
      const { container, getByText } = render(
        <AgentIcon agent={{ name: 'Untitled Agent' }} />,
      );
      // Initials still render (the existing plain fallback)...
      expect(getByText('UA')).toBeTruthy();
      //...but never colorized from the live-typed name.
      expect(container.querySelector('.brand-icon--identicon')).toBeNull();
    });

    test("retyping the name with no committed slug/id never changes the (absent) identicon — reproduces AgentEditorIdentityFields.tsx's live preview during agent creation", () => {
      const { container: first } = render(<AgentIcon agent={{ name: 'A' }} />);
      const { container: second } = render(
        <AgentIcon agent={{ name: 'A Longer Typed Name' }} />,
      );
      // Both are the flat fallback — neither is a hue swatch of any kind —
      // so there is nothing to cycle keystroke to keystroke.
      expect(first.querySelector('.brand-icon--identicon')).toBeNull();
      expect(second.querySelector('.brand-icon--identicon')).toBeNull();
    });

    test('a committed slug seeds the identicon even when name keeps changing (post-commit stability)', () => {
      const { container: renamed } = render(
        <AgentIcon agent={{ name: 'Renamed Agent', slug: 'stable-slug' }} />,
      );
      const { container: original } = render(
        <AgentIcon agent={{ name: 'Original Name', slug: 'stable-slug' }} />,
      );
      expect(
        renamed.querySelector('.brand-icon--identicon')?.getAttribute('style'),
      ).toBe(
        original.querySelector('.brand-icon--identicon')?.getAttribute('style'),
      );
    });
  });
});
