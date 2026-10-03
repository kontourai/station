/** @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SectionNav } from '../components/SectionNav';
import { settingsSectionNavItems } from '../views/SettingsView';

test('Settings offers topic links that stay within Settings', () => {
  render(
    <SectionNav
      aria-label="Settings sections"
      items={settingsSectionNavItems((section) => `/settings?view=${section}`)}
      activeKey="general"
      onNavigate={() => {}}
    />,
  );
  expect(screen.getAllByRole('navigation')).toHaveLength(1);
  expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
    'General',
    'Appearance',
    'Chat',
    'Notifications & voice',
    'Keyboard shortcuts',
    'Devices',
    'Privacy & sharing',
    'My knowledge',
    'Advanced',
  ]);
  for (const link of screen.getAllByRole('link')) {
    expect(link.getAttribute('href')).toMatch(/^\/settings\?view=/);
  }
  expect(
    screen.getByRole('link', { name: 'General' }).getAttribute('aria-current'),
  ).toBe('location');
});
