/**
 * @vitest-environment jsdom
 *
 * station#4463 slice 2: the audit's named bug was Settings' all-caps
 * `STATION`/`DEFAULTS` group labels rendering inline in the same row as its
 * Title-case links — two label vocabularies colliding in one control.
 * `settingsSectionNavItems` is the fix's contract: a flat `SectionNavItem[]`
 * with no group-label item type at all, using `dividerAfter` to mark a scope
 * boundary instead. This tests that contract directly, and separately
 * renders it through the real `SectionNav` primitive (fix round: NOT `Tabs`
 * — these are real deep-linkable URL sections, not an in-place tab widget,
 * see `components/SectionNav.tsx`) to prove the nav's DOM never re-admits a
 * group-label node sharing the row.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { SectionNav } from '../components/SectionNav';
import { settingsSectionNavItems } from '../views/SettingsView';
import { SETTINGS_SECTIONS } from '../views/settings/settings-catalog';

const hrefForSection = (section: string) => `/settings?view=${section}`;

describe('settingsSectionNavItems', () => {
  test('is Overview plus exactly one item per SETTINGS_SECTIONS entry — no separate group-label items', () => {
    const items = settingsSectionNavItems(hrefForSection);
    expect(items).toHaveLength(SETTINGS_SECTIONS.length + 1);
    expect(items[0]).toMatchObject({ key: 'overview', label: 'Overview' });
    const leafKeys = items.slice(1).map((item) => item.key);
    expect(leafKeys).toEqual(SETTINGS_SECTIONS.map((section) => section.id));
  });

  test('renders no item that is not a real leaf section or Overview — no separate group-label pseudo-item', () => {
    // The real guard: item count is EXACTLY Overview + one per leaf section
    // (asserted above). This adds the complementary check that every group
    // name appears at most as a leaf section's own title (e.g. the sole
    // Defaults-group section is itself titled "Defaults") and never as an
    // EXTRA item with no corresponding `SETTINGS_SECTIONS` entry.
    const items = settingsSectionNavItems(hrefForSection);
    const sectionIds = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));
    for (const item of items.slice(1)) {
      expect(sectionIds.has(item.key)).toBe(true);
    }
  });

  test('dividerAfter marks only the last item of Station and Defaults — not This device, Knowledge, or Overview', () => {
    const items = settingsSectionNavItems(hrefForSection);
    const byId = new Map(items.map((item) => [item.key, item]));

    const stationIds = SETTINGS_SECTIONS.filter(
      (s) => s.group === 'Station',
    ).map((s) => s.id);
    const defaultsIds = SETTINGS_SECTIONS.filter(
      (s) => s.group === 'Defaults',
    ).map((s) => s.id);
    const thisDeviceIds = SETTINGS_SECTIONS.filter(
      (s) => s.group === 'This device',
    ).map((s) => s.id);
    const knowledgeIds = SETTINGS_SECTIONS.filter(
      (s) => s.group === 'Knowledge',
    ).map((s) => s.id);

    expect(byId.get(stationIds.at(-1)!)?.dividerAfter).toBe(true);
    expect(byId.get(defaultsIds.at(-1)!)?.dividerAfter).toBe(true);
    expect(byId.get(thisDeviceIds.at(-1)!)?.dividerAfter).toBeFalsy();
    for (const id of knowledgeIds) {
      expect(byId.get(id)?.dividerAfter).toBeFalsy();
    }
    expect(byId.get('overview')?.dividerAfter).toBeFalsy();

    // Every non-boundary item must be undefined/false, not just the ones checked above.
    const dividerKeys = items
      .filter((item) => item.dividerAfter)
      .map((item) => item.key);
    expect(dividerKeys).toEqual([stationIds.at(-1), defaultsIds.at(-1)]);
  });
});

describe('Settings section nav rendered through SectionNav', () => {
  test('every rendered link is a real leaf-section anchor — a group label can never share the row', () => {
    render(
      <SectionNav
        aria-label="Settings sections"
        items={settingsSectionNavItems(hrefForSection)}
        activeKey="overview"
        onNavigate={() => {}}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = screen.getAllByRole('link');
    // Every DIRECT non-divider child of the nav is a link — no interposed
    // group-label element, and no unaccounted-for child at all.
    const nonDividerChildren = Array.from(nav.children).filter(
      (child) => !child.classList.contains('section-nav__divider'),
    );
    expect(nonDividerChildren).toHaveLength(links.length);
    for (const child of nonDividerChildren) {
      expect(child.tagName).toBe('A');
    }
  });

  test('draws exactly two dividers (Station→Defaults, Defaults→This device) as real elements, not text', () => {
    const { container } = render(
      <SectionNav
        aria-label="Settings sections"
        items={settingsSectionNavItems(hrefForSection)}
        activeKey="overview"
        onNavigate={() => {}}
      />,
    );
    const dividers = container.querySelectorAll('.section-nav__divider');
    expect(dividers).toHaveLength(2);
    for (const divider of Array.from(dividers)) {
      expect(divider.textContent).toBe('');
      expect(divider.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
