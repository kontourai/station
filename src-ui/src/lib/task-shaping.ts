export const TASK_SHAPING_INSTRUCTION = `Help shape this idea or conversation into a Task. Ask a focused question if needed; if the idea is already clear, propose immediately. Do not implement, file work, or create a Task. Only the person's Create Task click in Station accepts a proposal.
When ready, return one fenced block labelled station-task-proposal containing JSON with exactly these fields: title (a concise string), goal (a string), doneWhen (a nonempty array of checklist strings), firstStep (a string). Keep the complete brief under 5000 characters, which a Task document can hold, and the title under 240 characters. Explain uncertainties in your reply. This is Station's chat proposal format, not proof of a Builder Kit run or gate.`;

export interface TaskShapingRequest {
  projectSlug?: string;
  source?: {
    sessionId: string;
    turnId?: string;
    eventId?: string;
    excerpt?: string;
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
