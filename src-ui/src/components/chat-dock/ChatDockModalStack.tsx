import type { ConversationListItem } from '@kontourai/station-sdk';
import type { AgentData } from '../../contexts/AgentsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { ChatSession } from '../../types';
import type { EffectiveModelSource } from '../../utils/execution';
import { LazyBoundary } from '../LazyBoundary';
import type { NewChatModalMode } from '../modals/NewChatModal';

export const FORK_REPLAY_ONLY_DISCLOSURE =
  'Station replays the selected transcript only. Engine cursor, tool state, and approval state do not carry.';

// Both pickers are already mount-gated on a boolean that only a click flips,
// so their bodies (agent grouping, context search, session lists) load with
// the first open instead of with the app shell.
// ChatSettingsPanel has no internal state or effects (`if (!isOpen) return
// null` is its whole gate), so mount-gating it is behavior-identical and lets
// it load with the first open like its siblings above.
const loadChatSettingsPanel = () =>
  import('../chat/ChatSettingsPanel').then((m) => ({
    default: m.ChatSettingsPanel,
  }));
const loadNewChatModal = () =>
  import('../modals/NewChatModal').then((m) => ({ default: m.NewChatModal }));
const loadSessionPickerModal = () =>
  import('../modals/SessionPickerModal').then((m) => ({
    default: m.SessionPickerModal,
  }));

interface ChatDockModalStackProps {
  agents: AgentData[];
  projects: ProjectMetadata[];
  activeProjectSlug?: string | null;
  newChatProjectOverride?: { slug: string; name: string } | null;
  sessions: ChatSession[];
  showNewChatModal: boolean;
  newChatRequestEpoch?: number;
  showChatSettings: boolean;
  showSessionPicker: boolean;
  chatFontSize: number;
  defaultFontSize: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  autoHideEnabled: boolean;
  onSelectNewChat: (
    agent: AgentData,
    projectSlug?: string,
    projectName?: string,
    initialMessage?: string,
    modelOverride?: string,
    modelSource?: EffectiveModelSource,
    defaultModel?: string,
    defaultModelSource?: EffectiveModelSource,
    providerOptions?: Record<string, unknown>,
    providerId?: string,
    providerType?: string,
  ) => void;
  onCloseNewChat: () => void;
  onCloseSettings: () => void;
  onCloseSessionPicker: () => void;
  onSessionPickerSelect: (
    conversation: ConversationListItem,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onChatFontSizeChange: (fn: (prev: number) => number) => void;
  onShowReasoningChange: (show: boolean) => void;
  onShowToolDetailsChange: (show: boolean) => void;
  onAutoHideChange: (v: boolean) => void;
  /** #3310: the settings panel's "Summarize session" entry point. */
  sessionSummary?: {
    isGenerating: boolean;
    onGenerate: () => void;
    agentSlug: string;
    conversationId: string;
  };
  forkSource?: { id: string; agentSlug: string } | null;
  forkMode?: Omit<NewChatModalMode, 'disclosure'>;
  onForkAgentSelect?: ChatDockModalStackProps['onSelectNewChat'];
}

export function ChatDockModalStack({
  agents,
  projects,
  activeProjectSlug,
  newChatProjectOverride,
  sessions,
  showNewChatModal,
  newChatRequestEpoch,
  showChatSettings,
  showSessionPicker,
  chatFontSize,
  defaultFontSize,
  showReasoning,
  showToolDetails,
  autoHideEnabled,
  onSelectNewChat,
  onCloseNewChat,
  onCloseSettings,
  onCloseSessionPicker,
  onSessionPickerSelect,
  onChatFontSizeChange,
  onShowReasoningChange,
  onShowToolDetailsChange,
  onAutoHideChange,
  sessionSummary,
  forkSource,
  forkMode,
  onForkAgentSelect,
}: ChatDockModalStackProps) {
  const handleNewChatSelect: ChatDockModalStackProps['onSelectNewChat'] = (
    agent,
    ...args
  ) => {
    if (forkSource && onForkAgentSelect) onForkAgentSelect(agent, ...args);
    else onSelectNewChat(agent, ...args);
  };

  const requestAuthority = useHostRequestAuthorityScope();

  return (
    <>
      {showNewChatModal && (
        <LazyBoundary
          key={newChatRequestEpoch}
          load={loadNewChatModal}
          componentProps={{
            agents,
            projects,
            requestAuthority,
            activeProjectSlug:
              newChatProjectOverride?.slug ?? activeProjectSlug,
            onSelect: handleNewChatSelect,
            onClose: onCloseNewChat,
            mode: forkMode
              ? { ...forkMode, disclosure: FORK_REPLAY_ONLY_DISCLOSURE }
              : undefined,
          }}
          pending={null}
        />
      )}

      {showChatSettings && (
        <LazyBoundary
          load={loadChatSettingsPanel}
          componentProps={{
            isOpen: showChatSettings,
            onClose: onCloseSettings,
            chatFontSize,
            setChatFontSize: onChatFontSizeChange,
            defaultFontSize,
            showReasoning,
            setShowReasoning: onShowReasoningChange,
            showToolDetails,
            setShowToolDetails: onShowToolDetailsChange,
            autoHideEnabled,
            setAutoHideEnabled: onAutoHideChange,
            sessionSummary,
          }}
          pending={null}
        />
      )}

      {showSessionPicker && (
        <LazyBoundary
          load={loadSessionPickerModal}
          componentProps={{
            isOpen: showSessionPicker,
            agents,
            projects,
            requestAuthority,
            activeConversationIds: sessions
              .map((s) => s.conversationId)
              .filter(Boolean) as string[],
            onSelect: onSessionPickerSelect,
            onClose: onCloseSessionPicker,
          }}
          pending={null}
        />
      )}
    </>
  );
}
