/** @vitest-environment jsdom */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

/**
 * station#3122 stage 3, route wiring. `HomeRolePane.test.tsx` proves the
 * granted Pane's mounting and recovery machinery; these prove the route:
 * with no grant — the state every Station without plugins is in — the render
 * is the stage-2 one; the role component mounts ONLY for a server-derived
 * `granted` status; a `lapsed` status renders the floor plus the derived
 * reason and never the role component; and no browser-writable value can
 * stand in for any of it (the status seam is the server query, and a
 * localStorage record is read by nothing).
 */

const roleSeam = vi.hoisted(() => ({
  status: undefined as unknown,
  revoke: vi.fn(),
}));

vi.mock('../views/home/useWorkspaceHomeRole', () => ({
  useWorkspaceHomeRoleStatus: () => roleSeam.status,
  useRevokeWorkspaceHomeRole: () => roleSeam.revoke,
}));

const rolePaneProps = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock('../views/home/HomeRolePane', () => ({
  HomeRolePane: (props: {
    grant: unknown;
    builtinHome: React.ReactNode;
    onRevoke: () => void;
  }) => {
    rolePaneProps.seen.push(props);
    return (
      <div data-testid="home-role-pane">
        <div data-testid="role-floor">{props.builtinHome}</div>
      </div>
    );
  },
}));

vi.mock('../views/home/useHomeViewModel', () => ({
  useHomeViewModel: () => ({ workItems: [], projects: [] }),
}));

vi.mock('../views/home/HomeWorkspacePane', () => ({
  HomeWorkspacePaneBindingProvider: ({
    children,
  }: {
    children: React.ReactNode;
  }) => <>{children}</>,
  HomeWorkspacePane: () => <div data-testid="home-surface" />,
}));

vi.mock('../contexts/ConfigContext', () => ({ useConfig: () => null }));

// Route chrome from #3636, not part of the Home role; it unconditionally
// calls `useConfigActions`, which the minimal ConfigContext mock above
// deliberately does not provide.
vi.mock('../components/first-run/FirstRunHomeChapter', () => ({
  FirstRunHomeChapter: () => null,
}));

import { HomeView } from '../views/HomeView';

afterEach(() => {
  roleSeam.status = undefined;
  roleSeam.revoke = vi.fn();
  rolePaneProps.seen = [];
  window.localStorage.clear();
});

test('with no grant, the root renders the built-in Home exactly as stage 2 did', () => {
  roleSeam.status = { state: 'none' };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.getByTestId('home-surface')).toBeTruthy();
  // No role chrome of any kind exists without a grant.
  expect(screen.queryByTestId('home-role-pane')).toBeNull();
});

test('while the status has not resolved, the floor renders — never a blank root, never granted code', () => {
  roleSeam.status = undefined;
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.getByTestId('home-surface')).toBeTruthy();
  expect(screen.queryByTestId('home-role-pane')).toBeNull();
});

test('with a granted status, the role component receives the grant, the built-in floor, and revocation', async () => {
  const grant = { descriptor: { name: 'Granted Home' } };
  roleSeam.status = { state: 'granted', grant };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  await waitFor(() =>
    expect(screen.getByTestId('home-role-pane')).toBeTruthy(),
  );
  const props = rolePaneProps.seen[0] as {
    grant: unknown;
    onRevoke: () => void;
  };
  expect(props.grant).toBe(grant);
  // The floor handed down is the real built-in Home element.
  expect(screen.getByTestId('role-floor')).toBeTruthy();
  expect(screen.getByTestId('home-surface')).toBeTruthy();
  // Revocation is the server store's mutation, not a local approximation.
  expect(props.onRevoke).toBe(roleSeam.revoke);
});

test('a lapsed status renders the floor with the derived reason — the role component never mounts', () => {
  roleSeam.status = {
    state: 'lapsed',
    reason: 'version-changed',
    paneName: 'Granted Home',
    pluginId: 'third-party-home',
  };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.getByTestId('home-surface')).toBeTruthy();
  expect(screen.queryByTestId('home-role-pane')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain(
    'no longer holds the Home role',
  );
  expect(screen.getByRole('status').textContent).toContain(
    'installed version is not the one that was approved',
  );
});

test('a grant record planted in localStorage — the self-grant attack — mounts nothing', () => {
  // Before the re-scope the grant lived at this key, where same-origin
  // plugin code could write it. Nothing may read it any more: the ONLY seam
  // into the role render is the server-derived status.
  window.localStorage.setItem(
    'station:workspace-home-role',
    JSON.stringify({
      version: '1.0',
      descriptor: { name: 'Forged Home' },
      instance: {},
      grantedAt: new Date().toISOString(),
      projectionFields: ['id'],
    }),
  );
  roleSeam.status = { state: 'none' };
  render(<HomeView continuation={null} onNavigate={() => undefined} />);
  expect(screen.getByTestId('home-surface')).toBeTruthy();
  expect(screen.queryByTestId('home-role-pane')).toBeNull();
});
