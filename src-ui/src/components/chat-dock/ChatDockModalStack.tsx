import type { ConversationListItem } from '@kontourai/station-sdk';
import type { AgentData } from '../../contexts/AgentsContext';
import type { ProjectMetadata } from '../../contexts/ProjectsContext';
import type { ChatSession } from '../../types';
import type { ReplayCaptureSource } from '../chat/ReplayCaptureControls';
import { LazyBoundary } from '../LazyBoundary';

// The session picker is mount-gated on a boolean that only a click flips, so
// its body (session lists) loads with the first open instead of with the app
// shell. ChatSettingsPanel has no internal state or effects (`if (!isOpen)
// return null` is its whole gate), so mount-gating it is behavior-identical
// and lets it load with the first open too. The New chat draft is not here:
// it renders in the dock body (`DockStartComposer`).
const loadChatSettingsPanel = () =>
  import('../chat/ChatSettingsPanel').then((m) => ({
    default: m.ChatSettingsPanel,
  }));
const loadSessionPickerModal = () =>
  import('../modals/SessionPickerModal').then((m) => ({
    default: m.SessionPickerModal,
  }));

interface ChatDockModalStackProps {
  agents: AgentData[];
  projects: ProjectMetadata[];
  sessions: ChatSession[];
  showChatSettings: boolean;
  showSessionPicker: boolean;
  chatFontSize: number;
  defaultFontSize: number;
  showReasoning: boolean;
  showToolDetails: boolean;
  autoHideEnabled: boolean;
  onCloseSettings: () => void;
  onCloseSessionPicker: () => void;
  onSessionPickerSelect: (
    conversation: ConversationListItem,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onChatFontSizeChange: (fn: (prev: number) => number) => void;
  onShowReasoningChange: (show: boolean) => void;
  onShowToolDetailsChange: (show: boolean) => void;
  onAutoHideChange: (v: boolean) => void;
  /** #3310: the settings panel's "Summarize chat" entry point. */
  sessionSummary?: {
    isGenerating: boolean;
    onGenerate: () => void;
    agentSlug: string;
    conversationId: string;
  };
  onReplayConversation?: () => void;
  replayCaptureSource?: ReplayCaptureSource;
}

export function ChatDockModalStack({
  agents,
  projects,
  sessions,
  showChatSettings,
  showSessionPicker,
  chatFontSize,
  defaultFontSize,
  showReasoning,
  showToolDetails,
  autoHideEnabled,
  onCloseSettings,
  onCloseSessionPicker,
  onSessionPickerSelect,
  onChatFontSizeChange,
  onShowReasoningChange,
  onShowToolDetailsChange,
  onAutoHideChange,
  sessionSummary,
  onReplayConversation,
  replayCaptureSource,
}: ChatDockModalStackProps) {
  return (
    <>
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
            onReplayConversation,
            replayCaptureSource,
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
