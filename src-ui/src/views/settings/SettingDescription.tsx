import type { SettingDefinition } from '@kontourai/station-contracts/settings-registry';

const SUMMARIES: Readonly<Record<string, string>> = {
  approvalGuardian:
    'Use a second model to screen approval requests. Adds a model call for each screening.',
  defaultApprovalMode:
    'Permissions for new sessions, including unattended runs. Full access removes the sandbox and approval prompts.',
  defaultMaxTurns: 'Maximum steps per agent run.',
  defaultMaxOutputTokens:
    'Maximum tokens per response. Leave empty to use the model’s limit.',
  defaultWorkspaceIsolation:
    'Start chats in the shared checkout or a separate Git worktree. Worktrees require a Git repository.',
  workspaceCheckpoints:
    'Keep Git snapshots of each turn for 90 days. Uses disk space; changes apply after restarting Station.',
  usageLimitAutoResume:
    'Resend a Claude Code or Codex turn stopped by a usage limit once the limit resets. Spends quota while you are away.',
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
