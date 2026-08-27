export interface CommandLauncherSuggestion {
  id: string;
  label: string;
  intent: string;
}

export const COMMAND_LAUNCHER_SUGGESTIONS: CommandLauncherSuggestion[] = [
  {
    id: 'build',
    label: 'Build the next slice',
    intent: 'Build the next complete slice for this task.',
  },
  {
    id: 'review',
    label: 'Review current work',
    intent: 'Review the current work and report actionable findings.',
  },
  {
    id: 'explain',
    label: 'Explain this task',
    intent: 'Explain the current task, its context, and the next useful step.',
  },
];

export interface CommandLauncherContext {
  project: string | null | undefined;
  agent: string | null | undefined;
  model: string | null | undefined;
  mode: string | null | undefined;
  attachments: string[];
}

export interface CommandLauncherPreview {
  intent: string;
  project: string;
  agent: string;
  model: string;
  mode: string;
  attachments: string[];
  attachmentSummary: string;
}

function reported(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized || fallback;
}

export function buildCommandLauncherPreview(
  intent: string,
  context: CommandLauncherContext,
): CommandLauncherPreview {
  const attachments = context.attachments
    .map((attachment) => attachment.trim())
    .filter(Boolean);

  return {
    intent: intent.trim(),
    project: reported(context.project, 'Project unavailable'),
    agent: reported(context.agent, 'Agent unavailable'),
    model: reported(context.model, 'Model not reported'),
    mode: reported(context.mode, 'Mode unavailable'),
    attachments,
    attachmentSummary:
      attachments.length === 0
        ? 'None'
        : `${attachments.length}: ${attachments.join(', ')}`,
  };
}

export interface CommandLauncherSendBoundary<TAttachment> {
  handleInputChange: (intent: string) => void;
  handleSend: (
    intent: string,
    attachments: TAttachment[],
  ) => void | Promise<void>;
}

export async function submitCommandLauncherIntent<TAttachment>(
  intent: string,
  attachments: TAttachment[],
  boundary: CommandLauncherSendBoundary<TAttachment>,
) {
  const normalized = intent.trim();
  if (!normalized) return;
  boundary.handleInputChange(normalized);
  await boundary.handleSend(normalized, attachments);
}
