// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { memo } from 'react';
import { expect, test, vi } from 'vitest';

const inputs = vi.hoisted(() => ({
  agents: [],
  layouts: [],
  conversations: [
    {
      id: 'conv',
      resourceId: 'assistant',
      createdAt: '2026-10-17',
      updatedAt: '2026-10-17',
    },
  ],
  actions: {},
  auth: {},
  toast: { showToast: vi.fn() },
  send: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  launch: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  useProjectLayoutsQuery: () => ({ data: inputs.layouts }),
  useProjectLayoutQuery: () => ({ data: undefined }),
  useConversationsQuery: () => ({ data: inputs.conversations }),
}));
vi.mock('../../contexts/AgentsContext', () => ({
  useAgents: () => inputs.agents,
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'https://station.test' }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => inputs.auth }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => inputs.toast,
}));
vi.mock('../../contexts/ActiveChatsContext', () => ({
  useActiveChatActions: () => inputs.actions,
}));
vi.mock('../../hooks/useActiveChatSessionMessaging', () => ({
  useSendMessage: () => inputs.send,
}));
vi.mock('../../hooks/useActiveChatSessions', async () => {
  const { useLaunchChat } = await import(
    '../../hooks/useActiveChatSessionLifecycle'
  );
  return {
    useSendMessage: () => inputs.send,
    useCreateChatSession: () => inputs.create,
    useOpenConversation: () => inputs.open,
    useLaunchChat,
  };
});
vi.mock('../../hooks/useIsMobile', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useIsMobile')>()),
  useIsMobile: () => false,
}));

import { useConversations, useNavigation } from '@kontourai/station-sdk';
import {
  NavigationProvider,
  navigationStore,
} from '../../contexts/NavigationContext';
import { SDKAdapter } from '../SDKAdapter';

test('mounted plugin consumers ignore parent and non-SDK navigation changes while observing data and dock updates', () => {
  let renders = 0;
  const Probe = memo(function Probe() {
    const conversations = useConversations();
    const navigation = useNavigation();
    renders += 1;
    return (
      <output data-testid="plugin">
        {conversations.length}:{navigation.isDockOpen ? 'open' : 'closed'}
      </output>
    );
  });
  const layout = { slug: 'assistant', name: 'Assistant', tabs: [] };
  function Harness({ tick }: { tick: number }) {
    return (
      <div data-tick={tick}>
        <NavigationProvider>
          <SDKAdapter layout={layout}>
            <Probe />
          </SDKAdapter>
        </NavigationProvider>
      </div>
    );
  }
  navigationStore.updateParams({ dock: null, fontSize: null });
  const view = render(<Harness tick={0} />);
  const initial = renders;
  for (let tick = 1; tick <= 5; tick += 1)
    view.rerender(<Harness tick={tick} />);
  const afterParents = renders;
  for (let size = 12; size < 17; size += 1)
    act(() => navigationStore.updateParams({ fontSize: String(size) }));
  const afterFontChanges = renders;
  act(() => navigationStore.setDockState(true));
  const afterDock = renders;
  expect(screen.getByTestId('plugin').textContent).toBe('1:open');
  inputs.conversations = [
    ...inputs.conversations,
    { ...inputs.conversations[0], id: 'conv-2' },
  ];
  view.rerender(<Harness tick={6} />);
  expect(screen.getByTestId('plugin').textContent).toBe('2:open');
  const afterData = renders;
  view.unmount();
  expect({
    initial,
    afterParents,
    afterFontChanges,
    afterDock,
    afterData,
  }).toEqual({
    initial: 1,
    afterParents: 1,
    afterFontChanges: 1,
    afterDock: 2,
    afterData: 3,
  });
});
