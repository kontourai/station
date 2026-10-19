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
}: {
  agent: AgentData;
  executionAgentId?: string;
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
    personalDefault,
    stationDefault: config?.defaultApprovalMode,
  });
  if (engine !== 'codex' && engine !== 'claude' && engine !== 'muse')
    return null;
  const label =
    resolved.mode === 'connection-default'
      ? 'Engine settings'
      : approvalModeChipLabel(resolved.mode);
  return (
    <span
      className="start-composer__chip"
      title={
        resolved.mode === 'connection-default'
          ? 'The engine has not reported its active approval mode yet.'
          : `Requested at startup, from ${resolved.source}.`
      }
    >
      <span className="start-composer__chip-text">
        Permissions: {label}
        {resolved.source === 'account default'
          ? ' · your default'
          : resolved.source === 'agent default'
            ? ' · Agent default'
            : resolved.source === 'station default'
              ? ' · Station default'
              : ''}
      </span>
    </span>
  );
}
