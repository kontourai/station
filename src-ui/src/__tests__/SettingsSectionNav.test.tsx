/**
 * @vitest-environment jsdom
 *
 * archive#4463's named bug was Settings' all-caps `STATION`/`DEFAULTS` group
 * labels rendering inline in the same row as its Title-case links — two label
 * vocabularies colliding in one control — and its fix was a flat item list
 * with a silent `dividerAfter` marking each boundary.
 *
 * #2144 decision 6 brings NAMED groups back, so this file's contract changes
 * with it, and the two things that make the reversal legitimate are what it
 * now pins:
 *
 * - The label is a real HEADING, not another pill. A divider told a sighted
 *   reader the subject had changed and told a screen-reader user nothing; the
 *   whole point of naming the groups is that both get it. A test that only
 *   counted children would pass for a `<span>` and miss that entirely.
 * - The strip is still ONE landmark. Group headings live inside a single
 *   `<nav aria-label="Settings sections">`; four nav landmarks would be four
 *   things to skip past.
 *
 * It also pins the SET UP rows — links that leave this page for another
 * route — because they are the ones that can go wrong silently: a nav-only key
 * that leaked into the section vocabulary would be validated away by
 * `useSectionNavigation` and scroll to the top instead of opening Agents.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  APP_DESTINATION_REGISTRY,
  DEVELOPER_TOOLS_FLAG,
} from '../app-shell/destination-registry';
import { SectionNav } from '../components/SectionNav';
import { settingsSectionNavItems } from '../views/SettingsView';
import { SETTINGS_SECTIONS } from '../views/settings/settings-catalog';

const hrefForSection = (section: string) => `/settings?view=${section}`;

/** The flagless projection the default argument uses — no Developer row. */
const NAV_ONLY = APP_DESTINATION_REGISTRY.getSettingsNav();

describe('settingsSectionNavItems', () => {
  test('is Overview, then the nav-only rows, then exactly one item per SETTINGS_SECTIONS entry', () => {
    const items = settingsSectionNavItems(hrefForSection);
    expect(items).toHaveLength(1 + NAV_ONLY.length + SETTINGS_SECTIONS.length);
    expect(items[0]).toMatchObject({ key: 'overview', label: 'Overview' });

    const navOnly = items.slice(1, 1 + NAV_ONLY.length);
    expect(navOnly.map((item) => item.key)).toEqual(
      NAV_ONLY.map((entry) => `nav:${entry.id}`),
    );
    // The HREF is the destination's own route, not a `?view=` on this page:
    // these rows leave Settings.
    expect(navOnly.map((item) => item.href)).toEqual(
      NAV_ONLY.map((entry) => entry.route),
    );

    const leafKeys = items.slice(1 + NAV_ONLY.length).map((item) => item.key);
    expect(leafKeys).toEqual(SETTINGS_SECTIONS.map((section) => section.id));
  });

  test('no nav-only key is a settings section key', () => {
    // The failure this prevents is silent: `useSectionNavigation` validates
    // against the section vocabulary and falls back to overview for anything
    // it does not recognise, so a colliding key would turn "open Plugins"
    // into "scroll to the top" with no error anywhere.
    const sectionKeys = new Set<string>([
      'overview',
      ...SETTINGS_SECTIONS.map((section) => section.id),
    ]);
    for (const entry of NAV_ONLY) {
      expect(sectionKeys.has(`nav:${entry.id}`)).toBe(false);
    }
  });

  test('opens each group at its first item, in page order, and never over an empty group', () => {
    const items = settingsSectionNavItems(hrefForSection);
    const labelled = items.filter((item) => item.groupLabel);
    expect(labelled.map((item) => item.groupLabel)).toEqual([
      'SET UP',
      'THIS STATION',
      'CONTROL',
      'YOU',
      'KNOWLEDGE',
    ]);
    // A `groupLabel` is carried BY an item, so a heading can only exist where
    // a row does — an empty group cannot render a label over nothing.
    expect(labelled).toHaveLength(
      new Set(labelled.map((item) => item.key)).size,
    );
    // Each label opens its group: the item carrying it is that group's first.
    expect(labelled.map((item) => item.key)).toEqual([
      `nav:${NAV_ONLY[0]!.id}`,
      ...(['this-station', 'control', 'you', 'knowledge'] as const).map(
        (group) =>
          SETTINGS_SECTIONS.find((section) => section.group === group)!.id,
      ),
    ]);
  });

  test('places a nav-only row in ITS OWN group, not all of them under SET UP', () => {
    // The defect this catches shipped once: every nav-only row was emitted as
    // one SET UP block, so Developer — which the registry puts under THIS
    // STATION, beside this Station's own sections — appeared among the entity
    // lists instead. Invisible to the flagless projection, because Developer
    // is the only nav-only row in another group and it is not in it.
    const withDeveloper = settingsSectionNavItems(
      hrefForSection,
      APP_DESTINATION_REGISTRY.getSettingsNav(new Set([DEVELOPER_TOOLS_FLAG])),
    );
    const keys = withDeveloper.map((item) => item.key);
    const groupOf = (key: string) => {
      const index = keys.indexOf(key);
      for (let cursor = index; cursor >= 0; cursor -= 1) {
        const label = withDeveloper[cursor]!.groupLabel;
        if (label) return label;
      }
      return null;
    };
    expect(groupOf('nav:developer')).toBe('THIS STATION');
    expect(groupOf('nav:agents')).toBe('SET UP');
    // And it leads its group rather than trailing the sections: it is a
    // surface, and the heading opens on it.
    expect(
      withDeveloper.find((item) => item.groupLabel === 'THIS STATION'),
    ).toMatchObject({ key: 'nav:developer' });
  });

  test('renders no heading for a group with nothing in it', () => {
    // Every group is populated today, so this drives the branch with a
    // fixture rather than waiting for a section to become conditional: with
    // no nav-only rows at all, SET UP holds nothing and must not appear.
    const labels = settingsSectionNavItems(hrefForSection, []).map(
      (item) => item.groupLabel,
    );
    expect(labels).not.toContain('SET UP');
    expect(labels.filter(Boolean)).toEqual([
      'THIS STATION',
      'CONTROL',
      'YOU',
      'KNOWLEDGE',
    ]);
  });

  test('no longer draws the silent dividers the labels replace', () => {
    const items = settingsSectionNavItems(hrefForSection);
    expect(items.filter((item) => item.dividerAfter)).toEqual([]);
  });
});

describe('Settings section nav rendered through SectionNav', () => {
  function renderNav() {
    return render(
      <SectionNav
        aria-label="Settings sections"
        items={settingsSectionNavItems(hrefForSection)}
        activeKey="overview"
        onNavigate={() => {}}
      />,
    );
  }

  test('group names are real headings a screen reader announces, inside one landmark', () => {
    renderNav();
    // Exactly one navigation landmark, whatever the grouping does.
    expect(screen.getAllByRole('navigation')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });

    // Headings, not decoration: found BY ROLE, which a `<span>` or an
    // `aria-hidden` element could not satisfy — the exact failure archive#4463
    // left behind when it replaced the labels with dividers.
    const headings = screen.getAllByRole('heading');
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'SET UP',
      'THIS STATION',
      'CONTROL',
      'YOU',
      'KNOWLEDGE',
    ]);
    for (const heading of headings) {
      expect(nav.contains(heading)).toBe(true);
      expect(heading.getAttribute('aria-hidden')).toBeNull();
    }
  });

  test('every other child of the strip is a link — nothing else shares the row', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = screen.getAllByRole('link');
    const headings = screen.getAllByRole('heading');
    expect(Array.from(nav.children)).toHaveLength(
      links.length + headings.length,
    );
    for (const child of Array.from(nav.children)) {
      expect(['A', 'H2']).toContain(child.tagName);
    }
  });

  test('the nav-only rows render as ordinary links to their own routes', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    for (const entry of NAV_ONLY) {
      const link = screen.getByRole('link', { name: entry.label });
      expect(nav.contains(link)).toBe(true);
      expect(link.getAttribute('href')).toBe(entry.route);
      // Not a section: nothing here may claim to be the current view.
      expect(link.getAttribute('aria-current')).toBeNull();
    }
  });
});
