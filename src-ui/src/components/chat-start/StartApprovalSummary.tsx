import type { ProjectChatApprovalDefault } from '@kontourai/station-contracts/project-chat-defaults';
import { useRef, useState } from 'react';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { type AgentData, useAgents } from '../../contexts/AgentsContext';
import { useConfig } from '../../contexts/ConfigContext';
import {
  type ApprovalMode,
  approvalModeChipLabel,
  approvalModeDescription,
  resolveEffectiveApprovalMode,
} from '../../utils/approvalMode';
import { ArrowDownGlyph } from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';

/** The chat composer's own picker, loaded only when opened (ApprovalModeChip). */
const loadComposerModeSheet = () =>
  import('../badges/ComposerModeSheet').then((module) => ({
    default: module.ComposerModeSheet,
  }));

/**
 * Startup intent; a running session's chip separately reports engine
 * confirmation. With `onPick`, the chip opens the chat composer's approval
 * picker, and the pick is this start's own (it outranks every default, as a
 * pick in a running chat does).
 */
export function StartApprovalSummary({
  agent,
  executionAgentId,
  projectDefault,
  projectDefaultUnavailable = false,
  pick,
  onPick,
  sheetLayer,
}: {
  agent: AgentData;
  executionAgentId?: string;
  /** The selected Project's approval layer, as the server resolved it. */
  projectDefault?: ProjectChatApprovalDefault;
  /** A Project is selected but its layer could not be read. */
  projectDefaultUnavailable?: boolean;
  /** This start's own pick, if one was made. */
  pick?: ApprovalMode;
  onPick?: (mode: ApprovalMode) => void;
  /** The picker's layer; `dialog` inside a dialog. */
  sheetLayer?: 'dialog' | 'popover';
}) {
  const account = useAccountPreferences();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const config = useConfig();
  const actual = useAgents().find(
    (entry) => entry.slug === (executionAgentId ?? agent.slug),
  );
  const engine = actual?.execution?.agentConnectionId;
  const personalDefault =
    engine === 'codex'
      ? account.data?.values.interactiveApprovalModes?.codex
      : engine === 'claude'
        ? account.data?.values.interactiveApprovalModes?.claude
        : engine === 'muse'
          ? account.data?.values.interactiveApprovalModes?.muse
          : undefined;
  const resolved = resolveEffectiveApprovalMode({
    engineConnectionId: engine,
    sessionOverride: pick,
    agentDefault: actual?.execution?.approvalMode,
    projectDefault,
    projectDefaultUnavailable,
    personalDefault,
    stationDefault: config?.defaultApprovalMode,
  });
  if (engine !== 'codex' && engine !== 'claude' && engine !== 'muse')
    return null;
  const label =
    resolved.source === 'project unavailable'
      ? 'Set when the chat starts'
      : resolved.mode === 'connection-default'
        ? 'Engine settings'
        : approvalModeChipLabel(resolved.mode);
  const title = `${
    resolved.source === 'session override'
      ? 'Chosen for this chat.'
      : resolved.source === 'project unavailable'
        ? "This project's new-chat settings could not be read here; Station applies them when the chat starts."
        : resolved.mode === 'connection-default'
          ? engine === 'codex'
            ? approvalModeDescription('connection-default', 'codex')
            : 'The engine has not reported its active approval mode yet.'
          : `Requested at startup, from ${resolved.source}.`
  }${
    resolved.source !== 'session override' &&
    projectDefault?.fallback === 'no-history'
      ? ' No chat in this project has been recorded yet, so the last-used mode is not available.'
      : resolved.source !== 'session override' &&
          projectDefault?.fallback === 'full-access-not-granted'
        ? ' Your last chat here ran with full access, which is only reused when you can grant it.'
        : ''
  }`;
  const visible = `Permissions: ${label}${
    resolved.source === 'account default'
      ? ' · your default'
      : resolved.source === 'agent default'
        ? ' · Agent default'
        : resolved.source === 'project last used'
          ? ' · last used here'
          : resolved.source === 'project default'
            ? ' · project default'
            : resolved.source === 'station default'
              ? ' · Station default'
              : ''
  }`;
  const text = <span className="start-composer__chip-text">{visible}</span>;
  if (!onPick)
    return (
      <span
        className="start-composer__chip start-composer__chip--status"
        title={title}
      >
        {text}
      </span>
    );
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="choice-trigger start-composer__chip start-composer__chip--approval"
        aria-haspopup="dialog"
        aria-expanded={isSheetOpen}
        aria-label={`${visible}. ${title}`}
        title={title}
        onClick={() => setIsSheetOpen((open) => !open)}
      >
        {text}
        <ArrowDownGlyph className="choice-caret" />
      </button>
      {isSheetOpen && (
        <LazyBoundary
          load={loadComposerModeSheet}
          componentProps={{
            triggerRef,
            effectiveMode: resolved.mode,
            engineConnectionId: engine,
            onClose: () => setIsSheetOpen(false),
            onSelect: onPick,
            sourceNote:
              resolved.source === 'session override'
                ? 'Only this chat'
                : `From ${resolved.source === 'account default' ? 'your saved default' : resolved.source}`,
            isNewSession: true,
            layer: sheetLayer,
          }}
          pending={null}
        />
      )}
    </>
  );
}
