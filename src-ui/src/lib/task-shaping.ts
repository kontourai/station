/** Station's prompt/proposal seam. This is not a Builder Kit invocation. */
export interface TaskProposal {
  title: string;
  goal: string;
  doneWhen: string[];
  firstStep: string;
}

export const TASK_SHAPING_INSTRUCTION = `Help shape this idea or conversation into a Task. Ask a focused question if needed; if the idea is already clear, propose immediately. Do not implement, file work, or create a Task. Only the person's Create Task click in Station accepts a proposal.
When ready, return one fenced block labelled station-task-proposal containing JSON with exactly these fields: title (a concise string), goal (a string), doneWhen (a nonempty array of checklist strings), firstStep (a string). Keep the complete brief under 12000 characters and the title under 240 characters. Explain uncertainties in your reply. This is Station's chat proposal format, not proof of a Builder Kit run or gate.`;

export function readTaskProposal(text: string): TaskProposal | null {
  const matches = [
    ...text.matchAll(/```station-task-proposal\s*\n([\s\S]*?)\n```/g),
  ];
  if (matches.length !== 1 || matches[0][1].length > 12_000) return null;
  try {
    const value: unknown = JSON.parse(matches[0][1]);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    if (
      !('title' in value) ||
      !('goal' in value) ||
      !('doneWhen' in value) ||
      !('firstStep' in value)
    )
      return null;
    const { title, goal, doneWhen, firstStep } = value;
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.length > 240 ||
      typeof goal !== 'string' ||
      !goal.trim() ||
      typeof firstStep !== 'string' ||
      !firstStep.trim() ||
      !Array.isArray(doneWhen) ||
      doneWhen.length === 0 ||
      doneWhen.length > 32 ||
      doneWhen.some((item) => typeof item !== 'string' || !item.trim())
    )
      return null;
    return {
      title: title.trim(),
      goal: goal.trim(),
      doneWhen: doneWhen.map((item: string) => item.trim()),
      firstStep: firstStep.trim(),
    };
  } catch {
    return null;
  }
}

export function taskProposalBrief(proposal: TaskProposal): string {
  return `## Goal\n\n${proposal.goal}\n\n## Done when\n\n${proposal.doneWhen.map((item) => `- [ ] ${item}`).join('\n')}\n\n## Suggested first step\n\n${proposal.firstStep}`;
}

export interface TaskShapingRequest {
  projectSlug?: string;
  agentSlug?: string;
  source?: {
    sessionId: string;
    turnId?: string;
    eventId?: string;
    conversationId?: string;
    agentSlug?: string;
    agentName?: string;
  };
}

export const TASK_SHAPING_EVENT = 'station:shape-task';
export function requestTaskShaping(request: TaskShapingRequest = {}) {
  window.dispatchEvent(
    new CustomEvent<TaskShapingRequest>(TASK_SHAPING_EVENT, {
      detail: request,
    }),
  );
}
