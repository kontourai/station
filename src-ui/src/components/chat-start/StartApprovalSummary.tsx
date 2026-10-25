import type { ProjectChatApprovalDefault } from '@kontourai/station-contracts/project-chat-defaults';
import { useAccountPreferences } from '../../contexts/AccountPreferencesContext';
import { type AgentData, useAgents } from '../../contexts/AgentsContext';
import { useConfig } from '../../contexts/ConfigContext';
import {
  approvalModeChipLabel,
  resolveEffectiveApprovalMode,
} from '../../utils/approvalMode';

/** Startup intent; a running session's chip separately reports engine confirmation. */
export function StartApprovalSummary({
  agent,
  executionAgentId,
  projectDefault,
  projectDefaultUnavailable = false,
}: {
  agent: AgentData;
  executionAgentId?: string;
  /** The selected Project's approval layer, as the server resolved it. */
  projectDefault?: ProjectChatApprovalDefault;
  /** A Project is selected but its layer could not be read. */
  projectDefaultUnavailable?: boolean;
}) {
  const account = useAccountPreferences();
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
  return (
    <span
      className="start-composer__chip"
      title={`${
        resolved.source === 'project unavailable'
          ? "This project's new-chat settings could not be read here; Station applies them when the chat starts."
          : resolved.mode === 'connection-default'
            ? 'The engine has not reported its active approval mode yet.'
            : `Requested at startup, from ${resolved.source}.`
      }${
        projectDefault?.fallback === 'no-history'
          ? ' No chat in this project has been recorded yet, so the last-used mode is not available.'
          : projectDefault?.fallback === 'full-access-not-granted'
            ? ' Your last chat here ran with full access, which is only reused when you can grant it.'
            : ''
      }`}
    >
      <span className="start-composer__chip-text">
        Permissions: {label}
        {resolved.source === 'account default'
          ? ' · your default'
          : resolved.source === 'agent default'
            ? ' · Agent default'
            : resolved.source === 'project last used'
              ? ' · last used here'
              : resolved.source === 'project default'
                ? ' · project default'
                : resolved.source === 'station default'
                  ? ' · Station default'
                  : ''}
      </span>
    </span>
  );
}
