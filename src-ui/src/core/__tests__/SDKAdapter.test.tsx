/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  activeLayoutQuery: vi.fn(),
  layoutsQuery: vi.fn(),
  setApiBase: vi.fn(),
  setLayoutContext: vi.fn(),
  setProviderFunctions: vi.fn(),
  shellToast: vi.fn(),
}));

const ambientNavigation = {
  selectedProject: 'ambient-project',
  selectedProjectLayout: 'ambient-layout',
  dockState: false,
  setDockState: vi.fn(),
};

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  _setApiBase: mocks.setApiBase,
  _setLayoutContext: mocks.setLayoutContext,
  _setProviderFunctions: mocks.setProviderFunctions,
  useProjectLayoutsQuery: mocks.layoutsQuery,
  useProjectLayoutQuery: mocks.activeLayoutQuery,
}));

vi.mock('../../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => ({}),
}));
vi.mock('../../contexts/AgentsContext', () => ({ useAgents: () => [] }));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../../contexts/ConversationsContext', () => ({
  useConversations: () => [],
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ambientNavigation,
}));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.shellToast }),
}));
vi.mock('../../hooks/useActiveChatSessions', () => ({
  useSendMessage: () => vi.fn(),
  useCreateChatSession: () => vi.fn(),
  useOpenConversation: () => vi.fn(),
  useLaunchChat: () => vi.fn(),
}));

import { useLayout, useNavigation, useToast } from '@kontourai/station-sdk';
import { SDKAdapter } from '../SDKAdapter';

const paneLayout = {
  name: 'Bound Pane',
  slug: 'pane-instance',
  tabs: [],
};

function Probe() {
  const navigation = useNavigation();
  const layout = useLayout('ambient-layout');
  const { showToast } = useToast();
  return (
    <>
      <output data-testid="project">{navigation.selectedProject}</output>
      <output data-testid="selected-layout">
        {navigation.selectedProjectLayout ?? 'none'}
      </output>
      <output data-testid="layout">{layout.data?.slug}</output>
      <button
        type="button"
        onClick={() =>
          showToast({
            type: 'success',
            message: 'Bound toast',
            duration: 123,
          })
        }
      >
        Toast
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.layoutsQuery.mockReturnValue({ data: [] });
  mocks.activeLayoutQuery.mockReturnValue({ data: undefined });
});

test('binds SDK navigation and layout reads to the admitted Pane Project', () => {
  const { rerender } = render(
    <SDKAdapter layout={paneLayout} boundProjectSlug="project-alpha">
      <Probe />
    </SDKAdapter>,
  );

  expect(screen.getByTestId('project').textContent).toBe('project-alpha');
  expect(screen.getByTestId('selected-layout').textContent).toBe('none');
  expect(screen.getByTestId('layout').textContent).toBe('pane-instance');
  expect(mocks.layoutsQuery).toHaveBeenCalledWith('project-alpha', {
    enabled: true,
  });
  expect(mocks.activeLayoutQuery).toHaveBeenCalledWith('project-alpha', '', {
    enabled: false,
  });
  expect(ambientNavigation).toMatchObject({
    selectedProject: 'ambient-project',
    selectedProjectLayout: 'ambient-layout',
  });

  rerender(
    <SDKAdapter layout={paneLayout} boundProjectSlug="project-beta">
      <Probe />
    </SDKAdapter>,
  );
  expect(screen.getByTestId('project').textContent).toBe('project-beta');
  expect(ambientNavigation.selectedProject).toBe('ambient-project');
});

test('normalizes the documented object-form plugin toast at the shell seam', () => {
  render(
    <SDKAdapter layout={paneLayout} boundProjectSlug="project-alpha">
      <Probe />
    </SDKAdapter>,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Toast' }));
  expect(mocks.shellToast).toHaveBeenCalledWith(
    'Bound toast',
    undefined,
    123,
    undefined,
  );
});
