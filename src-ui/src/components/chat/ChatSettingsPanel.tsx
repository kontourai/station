import {
  useDismissSessionSummaryMutation,
  useShowSessionSummaryMutation,
} from '@kontourai/station-sdk';
import { useId } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import { Toggle } from '../Toggle';

interface ChatSettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  chatFontSize: number;
  setChatFontSize: (fn: (prev: number) => number) => void;
  defaultFontSize: number;
  showReasoning: boolean;
  setShowReasoning: (show: boolean) => void;
  showToolDetails: boolean;
  setShowToolDetails: (show: boolean) => void;
  autoHideEnabled: boolean;
  setAutoHideEnabled: (v: boolean) => void;
  /**
   * archive#3310: "Summarize session" demoted out of the transcript
   * the un-generated state no longer costs a permanent band above every
   * chat, so this gear panel is its entry point (reachable from the desktop
   * header's gear and the mobile overflow's "Chat settings"). Absent when no
   * conversation is active. This is a per-session ACTION, not a device
   * setting — its section says so beside the device-scope caption above.
   */
  sessionSummary?: {
    isGenerating: boolean;
    onGenerate: () => void;
    agentSlug: string;
    conversationId: string;
  };
}

export function ChatSettingsPanel({
  isOpen,
  onClose,
  chatFontSize,
  setChatFontSize,
  defaultFontSize,
  showReasoning,
  setShowReasoning,
  showToolDetails,
  setShowToolDetails,
  autoHideEnabled,
  setAutoHideEnabled,
  sessionSummary,
}: ChatSettingsPanelProps) {
  const reasoningId = useId();
  const toolsId = useId();
  const autoHideId = useId();
  const smoothRevealId = useId();
  const { featureSettings } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const dismissSummary = useDismissSessionSummaryMutation();
  const showSummary = useShowSessionSummaryMutation();
  if (!isOpen) return null;

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      overlayClassName="chat-settings-overlay"
      panelClassName="chat-settings-modal"
      ariaLabelledBy="chat-settings-title"
      initialFocusPolicy="panel"
    >
      <h3 id="chat-settings-title" className="chat-settings-modal__title">
        Chat Settings
      </h3>
      {/* archive#settings-revamp: every control below is device-
            scope (docs/design/settings-architecture.md §3 S4), consistent
            with the /settings "This device" scope caption. */}
      <p className="chat-settings-modal__caption">
        Saved to this device only — never sent to the server.
      </p>

      <fieldset className="chat-settings-modal__section">
        <legend className="chat-settings-modal__label">Font Size</legend>
        <div className="chat-settings-modal__control">
          <button
            type="button"
            className="chat-settings-modal__btn"
            onClick={() => setChatFontSize((prev) => Math.max(10, prev - 1))}
            disabled={chatFontSize <= 10}
          >
            A−
          </button>
          <button
            type="button"
            className={`chat-settings-modal__btn${chatFontSize === defaultFontSize ? ' chat-settings-modal__btn--muted' : ''}`}
            onClick={() => setChatFontSize(() => defaultFontSize)}
          >
            A
          </button>
          <button
            type="button"
            className="chat-settings-modal__btn"
            onClick={() => setChatFontSize((prev) => Math.min(24, prev + 1))}
            disabled={chatFontSize >= 24}
          >
            A+
          </button>
          <span className="chat-settings-modal__value">
            {chatFontSize}px (
            {Math.round((chatFontSize / defaultFontSize) * 100)}%)
          </span>
        </div>
      </fieldset>

      <div className="chat-settings-modal__section">
        <label
          className="chat-settings-modal__checkbox"
          htmlFor={smoothRevealId}
        >
          <Toggle
            id={smoothRevealId}
            checked={featureSettings.smoothReveal ?? false}
            onChange={(checked) =>
              setDeviceSetting('featureSettings', {
                ...featureSettings,
                smoothReveal: checked,
              })
            }
            size="sm"
            describedBy="chat-settings-smooth-reveal-hint"
          />
          <span>Smooth answer reveal</span>
        </label>
        <p
          id="chat-settings-smooth-reveal-hint"
          className="chat-settings-modal__hint"
        >
          Reveal incoming answer text steadily instead of showing network bursts
          all at once
        </p>
      </div>

      <div className="chat-settings-modal__section">
        <label className="chat-settings-modal__checkbox" htmlFor={reasoningId}>
          <Toggle
            id={reasoningId}
            checked={showReasoning}
            onChange={setShowReasoning}
            size="sm"
            describedBy="chat-settings-reasoning-hint"
          />
          <span>Show reasoning</span>
        </label>
        <p
          id="chat-settings-reasoning-hint"
          className="chat-settings-modal__hint"
        >
          Display model reasoning steps in chat messages
        </p>
      </div>

      <div className="chat-settings-modal__section">
        <label className="chat-settings-modal__checkbox" htmlFor={toolsId}>
          <Toggle
            id={toolsId}
            checked={showToolDetails}
            onChange={setShowToolDetails}
            size="sm"
            describedBy="chat-settings-tools-hint"
          />
          <span>Show tool details</span>
        </label>
        <p id="chat-settings-tools-hint" className="chat-settings-modal__hint">
          Allow expanding tool calls to view arguments and results
        </p>
      </div>

      <div className="chat-settings-modal__section">
        <label className="chat-settings-modal__checkbox" htmlFor={autoHideId}>
          <Toggle
            id={autoHideId}
            checked={autoHideEnabled}
            onChange={setAutoHideEnabled}
            size="sm"
            describedBy="chat-settings-autohide-hint"
          />
          <span>Auto-hide dock</span>
        </label>
        <p
          id="chat-settings-autohide-hint"
          className="chat-settings-modal__hint"
        >
          Collapse dock after 5 seconds of inactivity
        </p>
      </div>

      {sessionSummary && (
        <fieldset className="chat-settings-modal__section">
          <legend className="chat-settings-modal__label">This session</legend>
          <div className="chat-settings-modal__control">
            <button
              type="button"
              className="chat-settings-modal__btn"
              disabled={sessionSummary.isGenerating}
              onClick={() => {
                sessionSummary.onGenerate();
                onClose();
              }}
            >
              {sessionSummary.isGenerating
                ? 'Generating summary…'
                : 'Summarize session'}
            </button>
            <button
              type="button"
              className="chat-settings-modal__btn"
              onClick={() => {
                dismissSummary.mutate({
                  agentSlug: sessionSummary.agentSlug,
                  conversationId: sessionSummary.conversationId,
                });
                onClose();
              }}
            >
              Dismiss summary
            </button>
            <button
              type="button"
              className="chat-settings-modal__btn"
              onClick={() => {
                showSummary.mutate({
                  agentSlug: sessionSummary.agentSlug,
                  conversationId: sessionSummary.conversationId,
                });
                onClose();
              }}
            >
              Show dismissed summary
            </button>
          </div>
          <p className="chat-settings-modal__hint">
            Adds a derived summary card above the transcript. Runs on the server
            for this conversation.
          </p>
        </fieldset>
      )}

      <div className="chat-settings-modal__actions">
        <button
          type="button"
          className="chat-settings-modal__done"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </ResponsiveDialogSurface>
  );
}
