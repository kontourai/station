/** @vitest-environment jsdom */

import { permissionTier } from '@kontourai/station-contracts/plugin';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  PluginPermissionsSection,
  revokeNeedsConfirmation,
} from '../PluginPermissionsSection';

/**
 * archive#3815. The panel used to show only what a plugin was still
 * MISSING, so a permission became invisible the moment it was granted —
 * a user could approve `plugin.server` and never find that out again.
 * These pin the inversion: held permissions lead, and each one can be
 * taken back.
 */

test('what the plugin HOLDS is rendered, in words, with its identifier and a way to remove it', () => {
  const onRevoke = vi.fn();
  render(
    <PluginPermissionsSection
      granted={[
        { permission: 'plugin.server', tier: 'trusted' },
        { permission: 'network.fetch', tier: 'active' },
      ]}
      missing={[]}
      revoking={new Set()}
      onRevoke={onRevoke}
      onReviewPermissions={vi.fn()}
    />,
  );

  // The capability, not the identifier, is the headline — it is the
  // question a person reviewing a grant is actually asking.
  expect(
    screen.getByText('Run server-side plugin code inside Station'),
  ).toBeTruthy();
  expect(
    screen.getByText('Make network requests through the server'),
  ).toBeTruthy();
  // The identifier is still present for the reader who wants it.
  expect(screen.getByText('plugin.server')).toBeTruthy();

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Remove Run server-side plugin code inside Station',
    }),
  );
  expect(onRevoke).toHaveBeenCalledWith({
    permission: 'plugin.server',
    tier: 'trusted',
  });
});

test('a plugin holding nothing says so, rather than rendering an empty list', () => {
  render(
    <PluginPermissionsSection
      granted={[]}
      missing={[]}
      revoking={new Set()}
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );
  // Rendered through the canonical Empty primitive, not a bespoke class.
  expect(screen.getByText('No permissions')).toBeTruthy();
  expect(
    screen.getByText('This plugin holds nothing on this Station.'),
  ).toBeTruthy();
});

test('an outstanding request is shown as a request, and routes to the review page', () => {
  const onReviewPermissions = vi.fn();
  render(
    <PluginPermissionsSection
      granted={[{ permission: 'navigation.dock', tier: 'passive' }]}
      missing={[{ permission: 'tools.invoke', tier: 'active' }]}
      revoking={new Set()}
      onRevoke={vi.fn()}
      onReviewPermissions={onReviewPermissions}
    />,
  );

  expect(screen.getByText('Requested and not granted')).toBeTruthy();
  // A pending ask carries no Remove control — there is nothing to take back.
  expect(
    screen.queryByRole('button', { name: 'Remove Use MCP tools' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review request' }));
  expect(onReviewPermissions).toHaveBeenCalledTimes(1);
});

test('only the row being withdrawn shows pending, not the whole section', () => {
  render(
    <PluginPermissionsSection
      granted={[
        { permission: 'plugin.server', tier: 'trusted' },
        { permission: 'network.fetch', tier: 'active' },
      ]}
      missing={[]}
      revoking={new Set(['plugin.server'])}
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );
  expect(screen.getByText('Removing…')).toBeTruthy();
  // The other row stays actionable.
  expect(
    screen.getByRole('button', {
      name: 'Remove Make network requests through the server',
    }),
  ).toBeTruthy();
});

test('the asymmetry decides which removals ask first', () => {
  // Removing is always safe — it narrows what a plugin may do. What differs
  // is the cost of changing your mind: a trusted grant can only be restored
  // through the isolated host review page, so that one asks.
  expect(revokeNeedsConfirmation('trusted')).toBe(true);
  expect(revokeNeedsConfirmation('active')).toBe(false);
  expect(revokeNeedsConfirmation('passive')).toBe(false);
});

test('a held permission shows its REAL tier, not a cautious default (station#3815)', () => {
  // The bug this pins: a granted permission is by definition not "missing",
  // so deriving its tier from the missing list rendered every held row as
  // Trusted. `navigation.dock` is Passive and `network.fetch` is Active — a
  // review surface that called them Trusted would misinform on exactly the
  // fact that decides how alarmed to be.
  expect(permissionTier('navigation.dock')).toBe('passive');
  expect(permissionTier('network.fetch')).toBe('active');
  expect(permissionTier('plugin.server')).toBe('trusted');
  // Unknown reads as trusted: the cautious answer, never a reassuring one.
  expect(permissionTier('some.future.permission')).toBe('trusted');

  render(
    <PluginPermissionsSection
      granted={[
        {
          permission: 'navigation.dock',
          tier: permissionTier('navigation.dock'),
        },
        { permission: 'network.fetch', tier: permissionTier('network.fetch') },
      ]}
      missing={[]}
      revoking={new Set()}
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );
  expect(screen.getByText('Passive')).toBeTruthy();
  expect(screen.getByText('Active')).toBeTruthy();
  expect(screen.queryByText('Trusted')).toBeNull();
});

test('the hint does not promise immediacy the system cannot deliver (station#3822)', () => {
  render(
    <PluginPermissionsSection
      granted={[{ permission: 'plugin.server', tier: 'trusted' }]}
      missing={[]}
      revoking={new Set()}
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );
  // The first version said "takes effect immediately", which is false while
  // a registered provider keeps serving and in-flight work finishes.
  expect(screen.queryByText(/takes effect immediately/i)).toBeNull();
  expect(
    screen.getByText(/keeps running until the plugin reloads/i),
  ).toBeTruthy();
});

/**
 * archive#4288. Binding a grant to the plugin's content means a permission
 * can stop applying without anyone touching it — so the panel has to say so.
 * A capability that silently vanishes is its own defect.
 */
test('a changed tree is explained by name, not by a permission quietly disappearing', () => {
  render(
    <PluginPermissionsSection
      granted={[{ permission: 'navigation.dock', tier: 'passive' }]}
      missing={[{ permission: 'plugin.server', tier: 'trusted' }]}
      revoking={new Set()}
      contentBinding="changed"
      withheld={['plugin.server']}
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );

  const notice = screen.getByText(/code has changed since these permissions/i);
  expect(notice.textContent).toContain(
    'Run server-side plugin code inside Station',
  );
  expect(notice.textContent).toContain('not in effect until approved again');
});

test('a grant that predates content binding says what Station cannot tell, without claiming it is fine', () => {
  render(
    <PluginPermissionsSection
      granted={[{ permission: 'plugin.server', tier: 'trusted' }]}
      missing={[]}
      revoking={new Set()}
      contentBinding="unverified"
      onRevoke={vi.fn()}
      onReviewPermissions={vi.fn()}
    />,
  );

  expect(
    screen.getByText(/cannot tell whether this plugin's code has changed/i),
  ).toBeTruthy();
  // The permission is still held, and still removable.
  expect(
    screen.getByRole('button', {
      name: 'Remove Run server-side plugin code inside Station',
    }),
  ).toBeTruthy();
});

test.each(['bound', 'none', undefined] as const)(
  'binding %s renders no notice at all — the panel never invents a verdict',
  (binding) => {
    render(
      <PluginPermissionsSection
        granted={[{ permission: 'plugin.server', tier: 'trusted' }]}
        missing={[]}
        revoking={new Set()}
        contentBinding={binding}
        onRevoke={vi.fn()}
        onReviewPermissions={vi.fn()}
      />,
    );

    expect(screen.queryByText(/code has changed/i)).toBeNull();
    expect(screen.queryByText(/cannot tell whether/i)).toBeNull();
  },
);
