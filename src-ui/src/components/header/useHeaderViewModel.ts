import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { telemetry, useEngineConnectionsQuery } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { getPathForView } from '../../app-shell/routing';
import type { AgentData } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigationActions } from '../../contexts/NavigationContext';
import { useShowSurface } from '../../contexts/useShowSurface';
import { useLaunchChat } from '../../hooks/useActiveChatSessions';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import type { NavigationView } from '../../types';
import { resolveAgentExecution } from '../../utils/execution';
import { getInitials } from '../../utils/layout';
import { selectFirstChatTarget } from '../agent-selection-policy';
import { subscribeHelpMenuRequests } from './helpMenuRequest';
import { getHeaderBreadcrumb, getHelpPrompts } from './utils';

interface UseHeaderViewModelOptions {
  currentView?: NavigationView;
  agents: AgentData[];
  onNavigate: (view: NavigationView) => void;
}

export function useHeaderViewModel({
  currentView,
  agents,
  onNavigate,
}: UseHeaderViewModelOptions) {
  const { navigate } = useNavigationActions();
  // #928 C2a: the brand link means Home BY NAME, so it reveals the Home
  // surface (placed in `main`; the model navigates to `/`) rather than
  // navigating to `/` and showing whatever surface occupies `main`.
  const showSurface = useShowSurface();
  const { apiBase } = useApiBase();
  const { user: authUser } = useAuth();
  const launchChat = useLaunchChat(apiBase);
  const { data: agentConnections = [] } = useEngineConnectionsQuery() as {
    data?: ConnectionConfig[];
  };

  const [showHelp, setShowHelp] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  // The account menu moved to the sidebar footer (`SidebarAccountControl`);
  // its "Ask Station for help" row opens this header's menu, which keeps the
  // current view's prompts and Project-scoped chat target.
  useEffect(() => subscribeHelpMenuRequests(() => setShowHelp(true)), []);

  const helpPrompts = getHelpPrompts(currentView);
  const breadcrumb = getHeaderBreadcrumb(currentView);
  const userName = authUser?.name || authUser?.alias || 'User';
  const userInitials = getInitials(userName);

  function handleHelpPrompt(prompt: string) {
    setShowHelp(false);
    // archive#1004 MED: thread the header's current project identity
    // (if any) so a project-owned agent is never picked from the global
    // context — the same A3 rule ChatDockTabBar's selection already
    // applies.
    const chatTarget = selectFirstChatTarget({
      agents,
      agentConnections,
      selectedProjectSlug: breadcrumb?.projectSlug,
    });
    if (!chatTarget) {
      navigate(getPathForView({ type: 'connections-engines' })!);
      telemetry.track('ui.chat.entry', {
        source: 'header-help',
        outcome: 'no-target',
        projectScoped: breadcrumb?.projectSlug ? 1 : 0,
      });
      return;
    }
    void launchChat(
      chatTarget.slug,
      chatTarget.name,
      prompt,
      breadcrumb?.projectSlug,
      undefined,
      resolveAgentExecution(chatTarget),
    ).then(
      () => {
        telemetry.track('ui.chat.entry', {
          source: 'header-help',
          outcome: 'launched',
          projectScoped: breadcrumb?.projectSlug ? 1 : 0,
        });
      },
      () => {
        telemetry.track('ui.chat.entry', {
          source: 'header-help',
          outcome: 'send-failed',
          projectScoped: breadcrumb?.projectSlug ? 1 : 0,
        });
      },
    );
  }

  return {
    breadcrumb,
    helpPrompts,
    showHelp,
    showNotifications,
    showOverflow,
    userInitials,
    closeHelp: () => setShowHelp(false),
    closeNotifications: () => setShowNotifications(false),
    closeOverflow: () => setShowOverflow(false),
    handleHelpPrompt,
    openConnectionModal: openConnectionsModal,
    /**
     * OPEN, not toggle. Every caller is a menu ROW ("Ask Station for help" in
     * the sidebar account menu, by request, and in the `⋯` overflow), and a row that toggles
     * closes an already-open help menu instead of showing it — the press then
     * reads as doing nothing (#1552 review L3). The toolbar button that made a
     * toggle the right shape was removed in D1.
     */
    openHelp: () => setShowHelp(true),
    /**
     * OPEN, not toggle (#2081). `useMenuTriggerToggle` decides between opening
     * and closing from the state the bell was in when it was PRESSED, and calls
     * `closeNotifications` for the close half — so a toggle here would only be
     * consulted on the open path, where toggling an already-open popover would
     * shut it. That window is small (a hotkey or deep link landing between the
     * press and its click) and an idempotent open removes it rather than
     * documenting it.
     */
    openNotifications: () => setShowNotifications(true),
    toggleOverflow: () => setShowOverflow((current) => !current),
    goHome: () => showSurface('home'),
    openProfile: () => {
      if (currentView?.type === 'profile') {
        // A toggle's return: back to `/` and whatever occupies `main`, not
        // Home by name — that is `goHome`'s meaning, not this one's (#1523).
        navigate('/');
      } else {
        onNavigate({ type: 'profile' });
      }
    },
  };
}
