/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { Suspense } from 'react';
import { describe, expect, test, vi } from 'vitest';

let isBlockingFullScreen = false;
let providerMounts = 0;
let providerUnmounts = 0;
// AppViewContent reads no onboarding state: project creation is never gated
// by the setup launcher. The hook is still mocked as blocking in the
// project-new test below, so a gate that starts reading it goes red there.
vi.mock('../contexts/onboarding-setup-store', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../contexts/onboarding-setup-store')
  >()),
  useOnboardingSetupState: () => ({
    visible: isBlockingFullScreen,
    isBlockingFullScreen,
    content: isBlockingFullScreen ? { title: 'Setup' } : null,
    dismiss: vi.fn(),
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  FullScreenLoader: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock('../components/modals/NewProjectModal', () => ({
  NewProjectModal: () => <div data-testid="new-project-modal">New Project</div>,
}));
vi.mock('../pages/NotificationsPage', () => ({
  NotificationsPage: () => <div>Notifications</div>,
}));
vi.mock('../pages/ProfilePage', () => ({
  ProfilePage: () => <div>Profile</div>,
}));
vi.mock('../views/ACPConnectionsView', () => ({
  ACPConnectionsView: () => <div>Custom engines</div>,
}));
vi.mock('../views/AgentConnectionView', () => ({
  AgentConnectionView: () => <div>AgentConnection</div>,
}));
vi.mock('../views/AgentsView', () => ({
  AgentsView: () => (
    <div data-testid="agents-view">
      Agents
      <button type="button">Agent row</button>
    </div>
  ),
}));
vi.mock('../views/ConnectionsHub', () => ({
  ConnectionsHub: () => <div>ConnectionsHub</div>,
}));
vi.mock('../views/IntegrationsView', () => ({
  IntegrationsView: () => <div>Integrations</div>,
}));
vi.mock('../views/KnowledgeConnectionView', () => ({
  KnowledgeConnectionView: () => <div>Knowledge</div>,
}));
vi.mock('../views/HomeView', () => ({
  HomeView: () => <div data-testid="home-view">Home</div>,
}));
vi.mock('../views/DeveloperView', () => ({
  DeveloperView: () => <div>Developer</div>,
}));
vi.mock('../views/PluginManagementView', () => ({
  PluginManagementView: () => <div>Plugins</div>,
}));
vi.mock('../views/ProjectPage', () => ({
  ProjectPage: () => <div>Project</div>,
}));
vi.mock('../views/ProjectSettingsView', () => ({
  ProjectSettingsView: () => <div>ProjectSettings</div>,
}));
// Publishes a page title the way a real split-pane view does, so the header's
// behaviour across a route change is observable here rather than only in
// `PageFrame`'s own tests.
vi.mock('../views/ProviderSettingsView', async () => {
  const { usePageHeader } = await import(
    '../components/page-frame/page-frame-context'
  );
  const { useEffect, useRef } = await import('react');
  return {
    ProviderSettingsView: () => {
      usePageHeader({ title: 'Providers' });
      const instance = useRef(`provider-${providerMounts + 1}`);
      useEffect(() => {
        providerMounts += 1;
        return () => {
          providerUnmounts += 1;
        };
      }, []);
      return (
        <div data-provider-instance={instance.current}>ProviderSettings</div>
      );
    },
  };
});
// The Connections section frame wraps every `/connections/*` view and reads
// live query state; this suite is about the page header across a route
// change, so it stands in for the frame's own chrome and keeps publishing
// whatever title the wrapped view publishes.
vi.mock('../views/ConnectionsSectionFrame', () => ({
  ConnectionsSectionFrame: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('../views/RegistryView', () => ({
  RegistryView: () => <div>Registry</div>,
}));
vi.mock('../views/ScheduleView', () => ({
  ScheduleView: () => <div data-testid="schedule-view">Schedule</div>,
}));
vi.mock('../views/ConsoleBoardView', () => ({
  ConsoleBoardView: () => <div>ConsoleBoard</div>,
}));
vi.mock('../views/SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view">Settings</div>,
}));
vi.mock('../views/SkillsView', () => ({ SkillsView: () => <div>Skills</div> }));
vi.mock('../views/TaskWorkspaceView', () => ({
  TaskWorkspaceView: ({ taskId }: { taskId: string }) => (
    <div data-testid="task-workspace-view">Task {taskId}</div>
  ),
}));
vi.mock('../app-shell/RouteViewBoundary', () => ({
  RouteViewBoundary: ({
    children,
    routeKey,
  }: {
    children: React.ReactNode;
    routeKey: string;
  }) => (
    <div data-route-key={routeKey}>
      <Suspense fallback={<div>Loading route</div>}>{children}</Suspense>
    </div>
  ),
}));
vi.mock('../app-shell/ProjectLayoutRenderer', () => ({
  ProjectLayoutRenderer: () => <div>Layout</div>,
}));

import { AppViewContent } from '../app-shell/AppViewContent';

const baseProps = {
  agents: [],
  apiBase: 'http://localhost:3242',
  availableModels: [],
  onNavigate: vi.fn(),
  onShowHome: vi.fn(),
  onReturnToOutlet: vi.fn(),
  onSettingsSaved: vi.fn(),
};

describe('AppViewContent — R3 un-stacking', () => {
  test('renders the route frame declared for the route, and nothing for a route with none', async () => {
    const { container, unmount } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'schedule' }} />,
    );
    await screen.findByRole('heading', { level: 1, name: 'Schedule' });
    expect(container.querySelector('.page-frame__header')).not.toBeNull();
    unmount();

    // `home` is the recorded exception: its own is a prompt, so the shell
    // must not put a page header above it.
    const home = render(
      <AppViewContent {...baseProps} currentView={{ type: 'home' }} />,
    );
    await screen.findByTestId('home-view');
    expect(home.container.querySelector('.page-frame__header')).toBeNull();
  });

  test('wraps every route in the shared entrance, split-pane routes included', async () => {
    // SHELL-05: the entrance used to live on `.page`, which the eight
    // split-pane routes never render — Agents is one of them, so it had no
    // page-level entrance at all. The wrapper is the seam every route passes
    // through, which is what makes that inherited rather than re-declared.
    const { rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'agents' }} />,
    );
    expect(
      (await screen.findByTestId('agents-view')).closest('.route-transition'),
    ).not.toBeNull();

    rerender(
      <AppViewContent {...baseProps} currentView={{ type: 'schedule' }} />,
    );
    expect(
      (await screen.findByTestId('schedule-view')).closest('.route-transition'),
    ).not.toBeNull();
  });

  test('remounts the entrance wrapper on a route change so it replays', async () => {
    // A cached route chunk swaps synchronously; without a keyed remount the
    // wrapper element survives and a CSS animation that already ran does not
    // run again, so the second visit to a route would enter with no motion.
    const { rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'schedule' }} />,
    );
    const first = (await screen.findByTestId('schedule-view')).closest(
      '.route-transition',
    );
    rerender(
      <AppViewContent {...baseProps} currentView={{ type: 'settings' }} />,
    );
    const second = (await screen.findByTestId('settings-view')).closest(
      '.route-transition',
    );
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  test('lazy-loads the Task workspace with a Task-specific route boundary key', async () => {
    const { rerender } = render(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'task', taskId: 'task-alpha' }}
      />,
    );
    expect((await screen.findByTestId('task-workspace-view')).textContent).toBe(
      'Task task-alpha',
    );
    expect(
      screen
        .getByTestId('task-workspace-view')
        .closest('[data-route-key]')
        ?.getAttribute('data-route-key'),
    ).toBe('task:task-alpha');

    rerender(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'task', taskId: 'task-beta' }}
      />,
    );
    expect((await screen.findByTestId('task-workspace-view')).textContent).toBe(
      'Task task-beta',
    );
    expect(
      screen
        .getByTestId('task-workspace-view')
        .closest('[data-route-key]')
        ?.getAttribute('data-route-key'),
    ).toBe('task:task-beta');
  });
  test('a setup reminder cannot suppress explicit project creation', async () => {
    isBlockingFullScreen = true;

    render(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'project-new' }}
        projectsLoading={false}
      />,
    );

    expect(await screen.findByTestId('new-project-modal')).toBeTruthy();
  });
});

describe('AppViewContent — the page header while a route loads', () => {
  // The frame is above Suspense, so on a cold load the header renders before
  // the view that would publish its title exists. Both assertions below are
  // deliberately made SYNCHRONOUSLY, before the lazy chunk resolves — that
  // window is the whole subject.
  test('names the route from the first paint, before its chunk resolves', () => {
    render(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'connections-models' }}
      />,
    );

    expect(screen.getByText('Loading route')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 1 });
    // The sidebar's own word for this surface, from `destination-registry.ts`,
    // not a second copy written into the frame table.
    expect(heading.textContent).toBe('Connections');
  });

  test('shows the arriving route’s name while it loads, never the departing one’s title', async () => {
    const { rerender } = render(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'connections-models' }}
      />,
    );
    await screen.findByText('ProviderSettings');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Providers',
    );

    rerender(
      <AppViewContent {...baseProps} currentView={{ type: 'plugins' }} />,
    );

    // Plugins' chunk has not resolved yet: the header must already say
    // Plugins rather than keep naming the page the user just left.
    expect(screen.getByText('Loading route')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).not.toBe('Providers');
    expect(heading.textContent).toBe('Plugins');
  });
});

describe('AppViewContent — not-found', () => {
  test('renders ErrorState with role="alert" and a Go home action for unmatched routes', () => {
    const onShowHome = vi.fn();
    const onReturnToOutlet = vi.fn();

    render(
      <AppViewContent
        {...baseProps}
        onShowHome={onShowHome}
        onReturnToOutlet={onReturnToOutlet}
        currentView={{ type: 'not-found', path: '/nowhere' }}
      />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toBeTruthy();
    expect(screen.getByText('Page not found')).toBeTruthy();

    // #1523: "Go home" says Home, so it means the Home surface — not a return
    // to `/` and whatever occupies `main`.
    fireEvent.click(screen.getByRole('button', { name: 'Go home' }));
    expect(onShowHome).toHaveBeenCalledTimes(1);
    expect(onReturnToOutlet).not.toHaveBeenCalled();
  });
});

describe('AppViewContent — Connections surface continuity', () => {
  test('keeps a section wrapper mounted across its exact list/edit routes', async () => {
    providerMounts = 0;
    providerUnmounts = 0;
    const { container, rerender } = render(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'connections-models' }}
      />,
    );
    await screen.findByText('ProviderSettings');
    const surface = container.querySelector('.route-transition');
    const providerInstance = container
      .querySelector('[data-provider-instance]')
      ?.getAttribute('data-provider-instance');
    expect(providerMounts).toBe(1);
    expect(
      container
        .querySelector('[data-route-key]')
        ?.getAttribute('data-route-key'),
    ).toBe('connections-models');

    rerender(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'connections-model-edit', id: 'model-1' }}
      />,
    );
    expect(container.querySelector('.route-transition')).toBe(surface);
    expect(
      container
        .querySelector('[data-provider-instance]')
        ?.getAttribute('data-provider-instance'),
    ).toBe(providerInstance);
    expect(providerMounts).toBe(1);
    expect(providerUnmounts).toBe(0);
    expect(
      container
        .querySelector('[data-route-key]')
        ?.getAttribute('data-route-key'),
    ).toBe('connections-model-edit:model-1');

    rerender(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'connections-models' }}
      />,
    );
    expect(
      container
        .querySelector('[data-provider-instance]')
        ?.getAttribute('data-provider-instance'),
    ).toBe(providerInstance);
    expect(providerMounts).toBe(1);
    expect(providerUnmounts).toBe(0);
  });
});

describe('AppViewContent — Agents surface continuity', () => {
  test('selecting an agent keeps keyboard focus in the list (#2992)', async () => {
    // Enter on a row navigates `agents` -> `agent-edit:<slug>`. A remount of
    // the surface there detaches the focused row, and the browser hands focus
    // to <body>, so the next key did nothing.
    const { container, rerender } = render(
      <AppViewContent {...baseProps} currentView={{ type: 'agents' }} />,
    );
    const row = await screen.findByRole('button', { name: 'Agent row' });
    const surface = container.querySelector('.route-transition');
    row.focus();
    expect(document.activeElement).toBe(row);

    for (const view of [
      { type: 'agent-edit', slug: 'a' },
      { type: 'agent-edit', slug: 'b' },
      { type: 'agent-new' },
      { type: 'agents' },
    ] as const) {
      rerender(<AppViewContent {...baseProps} currentView={view} />);
      expect(container.querySelector('.route-transition')).toBe(surface);
      expect(row.isConnected).toBe(true);
      expect(document.activeElement).toBe(row);
    }
    // The boundary still sees each exact route, so pending and error state
    // stay per record.
    rerender(
      <AppViewContent
        {...baseProps}
        currentView={{ type: 'agent-edit', slug: 'a' }}
      />,
    );
    expect(
      container
        .querySelector('[data-route-key]')
        ?.getAttribute('data-route-key'),
    ).toBe('agent-edit:a');
  });
});
