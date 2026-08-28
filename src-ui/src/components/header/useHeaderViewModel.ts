import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { telemetry, useAgentConnectionsQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { getPathForView } from '../../app-shell/routing';
import type { AgentData } from '../../contexts/AgentsContext';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useLaunchChat } from '../../hooks/useActiveChatSessions';
import { useShortcutDisplay } from '../../hooks/useKeyboardShortcut';
import { openConnectionsModal } from '../../lib/connectionModalEvents';
import type { NavigationView } from '../../types';
import { resolveAgentExecution } from '../../utils/execution';
import { getInitials } from '../../utils/layout';
import { selectFirstChatTarget } from '../agent-selection-policy';
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
  const settingsShortcut = useShortcutDisplay('app.settings');
  const { navigate } = useNavigation();
  const { apiBase } = useApiBase();
  const { user: authUser } = useAuth();
  const launchChat = useLaunchChat(apiBase);
  const { data: agentConnections = [] } = useAgentConnectionsQuery() as {
    data?: ConnectionConfig[];
  };

  const [showHelp, setShowHelp] = useState(false);
  const [showOverflow, setShowOverflow] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);

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
    settingsShortcut,
    showHelp,
    showNotifications,
    showOverflow,
    userInitials,
    closeHelp: () => setShowHelp(false),
    closeNotifications: () => setShowNotifications(false),
    closeOverflow: () => setShowOverflow(false),
    handleHelpPrompt,
    openConnectionModal: openConnectionsModal,
    toggleHelp: () => setShowHelp((current) => !current),
    toggleNotifications: () => setShowNotifications((current) => !current),
    toggleOverflow: () => setShowOverflow((current) => !current),
    goHome: () => navigate('/'),
    openProfile: () => {
      if (currentView?.type === 'profile') {
        navigate('/');
      } else {
        onNavigate({ type: 'profile' });
      }
    },
  };
}
