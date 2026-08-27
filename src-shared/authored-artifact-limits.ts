/**
 * The declared maximum for one durable, user-authored artifact (station#2838):
 * an agent system prompt, Playbook, or Skill body. This is deliberately a
 * separate budget from CHAT_INPUT_MAX_CHARS: artifacts persist and may be
 * model-facing across many future turns, while chat input is one turn's
 * ephemeral request.
 *
 * Why 100,000 characters: this preserves the pre-station#2838 de-facto limit,
 * avoiding a surprising compatibility reduction for existing authored work.
 * It is about 25,000 tokens of ordinary English prose: enough for a detailed
 * reusable instruction artifact, while refusing an accidental or hostile
 * multi-megabyte write before it becomes durable model behavior. The number is
 * intentionally not derived from an engine context window; engines that do
 * not declare one need a separately designed fallback.
 *
 * Length is UTF-16 code units (`String.length`), matching Zod's string limit.
 */
export const AUTHORED_ARTIFACT_MAX_CHARS = 100_000;

/** Return a user-facing refusal that identifies both the artifact and budget. */
export function authoredArtifactBudgetMessage(artifact: string): string {
  return `${artifact} exceeds the authored-artifact budget of ${AUTHORED_ARTIFACT_MAX_CHARS} characters.`;
}
