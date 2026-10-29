import type { SettingDefinition } from '@kontourai/station-contracts/settings-registry';

const SUMMARIES: Readonly<Record<string, string>> = {
  approvalGuardian:
    'Use a second model to screen approval requests. Adds a model call for each screening.',
  defaultApprovalMode:
    'Permissions for new sessions, including unattended runs. Full access removes the sandbox and approval prompts.',
  defaultMaxTurns:
    'Fallback step limit for VoltAgent runs. Strands and native engines do not apply it.',
  defaultMaxOutputTokens:
    'Maximum tokens per response. Leave empty to use the model’s limit.',
  defaultWorkspaceIsolation:
    'Start chats in the shared checkout or a separate Git worktree. Worktrees require a Git repository.',
  workspaceCheckpoints:
    'Keep Git snapshots of each turn for 90 days. Uses disk space; changes apply after restarting Station.',
  usageLimitAutoResume:
    'Resend a Claude Code or Codex turn stopped by a usage limit once the limit resets. Spends quota while you are away.',
  defaultModel:
    'Fallback model for managed turns after the agent, Project, and model connection defaults.',
  distributionProfile:
    'Choose the layout sources offered to Projects. Changes apply after restarting Station.',
  registryUrl:
    'Source for installable resources. Applies after restarting Station.',
  terminalShell: 'Choose the shell used by Station terminals on the host.',
  mcpUiHost:
    'Display interactive MCP tool interfaces in sandboxed chat frames.',
  mobileDeviceHubUrl:
    'Local device helper address. Applies after restarting Station.',
  disableDefaultSkillRegistries:
    'Use only your skill registries after restarting Station.',
  surfaceTrustFromVeritasEvidence:
    'Include the latest workspace Veritas evidence in each project’s Trust panel.',
  attachedSessionsOutsideProjects:
    'Import conversations outside projects into Activity and search. Turning off stops new imports; existing history stays.',
};

/** Keep operational details available without turning each row into a paragraph. */
export function SettingDescription({
  definition,
}: {
  definition: SettingDefinition;
}) {
  const summary = SUMMARIES[definition.key];
  if (!summary) return <>{definition.description}</>;
  return (
    <>
      {summary}
      <details className="settings__help-details">
        <summary>Details</summary>
        <p>{definition.description}</p>
      </details>
    </>
  );
}
