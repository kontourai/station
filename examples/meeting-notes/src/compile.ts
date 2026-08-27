/**
 * Compile step: raw transcript -> extraction agent -> compiled record with a
 * provenance link back to the raw record (`s203-knowledge-meeting-notes`
 * plan, Wave 1 Task 3).
 *
 * The extraction prompt wording (`EXTRACTION_PROMPT_PREFIX`) is vendored
 * VERBATIM from `examples/meeting-transcription/src/MeetingTranscriptionModal
 * .tsx`'s `handleSend` (read-only precedent — never forked/reworded), per
 * the plan's explicit instruction: "reuse it verbatim so the compile step's
 * behavior is provably the same capability already dogfooded, just now
 * writing to a Kit record instead of dumping into chat."
 *
 * The compile call goes through the SDK's `invokeAgent()` function directly
 * (not the `useAgentInvokeMutation` hook, whose `mutationFn` drops
 * `options` entirely — verified in `packages/sdk/src/query-domains/
 * workspace.ts`) against a plugin-contributed agent (`agents/compile/
 * agent.json`, `plugin.json`'s `agents` field — the same additive
 * agent-contribution mechanism `examples/demo-layout` already uses for its
 * "assistant" agent). This is the existing chat/model seam
 * (`POST /agents/:slug/invoke`, `schema` option already supported by that
 * route per `src-server/routes/invoke-agent.ts`) — no new model plumbing.
 */

import type {
  CreateInput,
  KitProvenance,
} from '@kontourai/station-contracts/knowledge-store';
import { invokeAgent } from '@kontourai/station-sdk';

/** Verbatim from `MeetingTranscriptionModal.handleSend` — do not reword. */
export const EXTRACTION_PROMPT_PREFIX =
  'Here is a meeting transcript. Please extract the key action items, decisions made, and any important points:';

export function buildExtractionPrompt(transcript: string): string {
  return `${EXTRACTION_PROMPT_PREFIX}\n\n${transcript}`;
}

/** JSON schema requested from the `compile` agent (Q3/AC1a: structured
 * extraction, not free-form chat text). */
export const COMPILE_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'actionItems'],
  additionalProperties: false,
} as const;

export interface CompileResult {
  title: string;
  summary: string;
  actionItems: string[];
}

/** Narrows an agent-invoke response's `response` field into a
 * `CompileResult`, never trusting an untyped model response past this
 * boundary. */
export function parseCompileResult(value: unknown): CompileResult | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== 'string') return null;
  if (typeof candidate.summary !== 'string') return null;
  if (
    !Array.isArray(candidate.actionItems) ||
    !candidate.actionItems.every((item) => typeof item === 'string')
  ) {
    return null;
  }
  return {
    title: candidate.title,
    summary: candidate.summary,
    actionItems: candidate.actionItems,
  };
}

/** Immutable creation-provenance agent identifiers (store-contract.md §4.1's
 * `agent` field) — distinct strings for the capture vs. compile step so the
 * mutation log/provenance honestly names which step wrote which record. */
export const CAPTURE_PROVENANCE_AGENT = 'station.meeting-notes.capture';
export const COMPILE_PROVENANCE_AGENT = 'station.meeting-notes.compile';

/** `raw` record input for "Save transcript" — verbatim transcript, no
 * extraction applied yet. */
export function buildRawRecordInput(transcript: string): CreateInput {
  const provenance: KitProvenance = { agent: CAPTURE_PROVENANCE_AGENT };
  return {
    type: 'raw',
    title: `Meeting transcript — ${new Date().toISOString()}`,
    body: transcript,
    category: 'meeting-transcript',
    provenance,
  };
}

/** `compiled` record input for "Compile" — AC1a: `links` carries the
 * `{target_id: rawId, kind:'source'}` forward edge and `provenance.source_ids`
 * names the same raw record, so `getLinks(compiledId).forward` and the
 * record's own provenance agree. */
export function buildCompiledRecordInput(
  rawId: string,
  result: CompileResult,
): CreateInput {
  const actionItemsSection =
    result.actionItems.length > 0
      ? `Action items:\n${result.actionItems.map((item) => `- ${item}`).join('\n')}`
      : null;
  const body = [result.summary, actionItemsSection]
    .filter((section): section is string => !!section)
    .join('\n\n');
  const provenance: KitProvenance = {
    agent: COMPILE_PROVENANCE_AGENT,
    source_ids: [rawId],
  };
  return {
    type: 'compiled',
    title: result.title,
    body,
    category: 'meeting-note',
    links: [{ target_id: rawId, kind: 'source' }],
    provenance,
  };
}

/**
 * Invokes the plugin-contributed `compile` agent over the vendored
 * extraction prompt, requesting `COMPILE_RESULT_SCHEMA`. Resolves to a
 * validated `CompileResult` or throws — callers must not fall back to a
 * partially-parsed shape.
 */
export async function invokeCompileAgent(
  transcript: string,
): Promise<CompileResult> {
  const prompt = buildExtractionPrompt(transcript);
  const result = await invokeAgent('compile', prompt, {
    schema: COMPILE_RESULT_SCHEMA,
  });
  const parsed = parseCompileResult(
    (result as { response?: unknown })?.response,
  );
  if (!parsed) {
    throw new Error(
      'The compile agent did not return the expected {title, summary, actionItems} JSON shape.',
    );
  }
  return parsed;
}
