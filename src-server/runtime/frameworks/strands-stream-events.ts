import type { AgentStreamEvent } from '@strands-agents/sdk';
import { projectToolServerResult } from '../../services/plugins/tool-server-oauth.js';
import type { IStreamChunk } from '../types.js';
import { GENERIC_TOOL_FAILURE_MESSAGE } from '../types.js';

/**
 * Normalize a Strands tool-result `content` into the same raw-output shape the
 * VoltAgent path emits, so the shared UI handler (extractUIBlocks etc.) is
 * framework-agnostic. Strands wraps a FunctionTool's object return as a single
 * `JsonBlock` → `[{ json: <return> }]` (primitives become `{ json: { $value } }`).
 * Unwrap a lone JsonBlock back to its underlying value; leave text/multi-block
 * content as-is. Without this, a managed Strands agent's render_component output
 * (`{ uiBlock }`) is buried in a content-block array and never renders.
 */
export function normalizeStrandsToolOutput(content: unknown): unknown {
  if (Array.isArray(content) && content.length === 1) {
    const block = content[0] as Record<string, unknown> | null;
    if (block && typeof block === 'object' && 'json' in block) {
      const json = block.json as unknown;
      if (json && typeof json === 'object' && '$value' in json) {
        return (json as { $value: unknown }).$value;
      }
      return json;
    }
  }
  return content;
}

export function mapStrandsStreamEvent(
  event: AgentStreamEvent,
): IStreamChunk | null {
  if (event.type === 'modelStreamUpdateEvent') {
    const inner = (event as any).event;
    if (!inner) return null;

    switch (inner.type) {
      case 'modelContentBlockDeltaEvent': {
        const delta = inner.delta;
        if (!delta) return null;
        if (delta.type === 'textDelta') {
          return { type: 'text-delta', text: delta.text || '' };
        }
        if (delta.type === 'reasoningContentDelta') {
          return { type: 'reasoning-delta', text: delta.text || '' };
        }
        if (delta.type === 'toolUseInputDelta') {
          return { type: 'tool-call-delta', argsTextDelta: delta.input || '' };
        }
        return null;
      }

      case 'modelContentBlockStartEvent': {
        const start = inner.start;
        if (start?.type === 'toolUseStart') {
          return {
            type: 'tool-call',
            toolName: start.name,
            toolCallId: start.toolUseId || `tool-${Date.now()}`,
            input: {},
          };
        }
        return null;
      }

      case 'modelMessageStopEvent':
        return { type: 'finish', finishReason: inner.stopReason || 'end_turn' };

      case 'modelMetadataEvent':
        if (inner.usage) {
          return {
            type: 'usage',
            ...(inner.usage.inputTokens !== undefined
              ? { promptTokens: inner.usage.inputTokens }
              : {}),
            ...(inner.usage.outputTokens !== undefined
              ? { completionTokens: inner.usage.outputTokens }
              : {}),
          };
        }
        return null;

      default:
        return null;
    }
  }

  if (event.type === 'toolResultEvent') {
    const result = (event as any).result;
    // archive#3091: `result.error` is the SAME Error object instance
    // `createStrandsFunctionTools` threw (Strands' own `createErrorResult`
    // holds the reference rather than cloning it), so marker own-properties
    // set at the throw site survive here unchanged.
    //
    // archive#3210: the real reason text is surfaced only when
    // `stationComposedReason` is present — the marker meaning
    // `denial-message.ts` composed it, so its tool name is sanitized and any
    // guardian/hook prose inside it is bounded, quoted and attributed. An
    // ordinary tool error's message may carry remote/untrusted text and stays
    // inside the existing `projectToolServerResult` redaction below rather
    // than leaking through a new field. `policyDenied` is carried
    // independently: it drives archive#3091's badge and says nothing about
    // authorship, so a policy-denied-but-uncomposed reason is badged AND
    // redacted.
    //
    // The REDACTION RULE is byte-identical to voltagent-adapter.ts's — same
    // marker, same generic message, same independence of the badge. The FRAME
    // is not, and the earlier "byte-identical" phrasing overstated it: this
    // mapper constructs a fresh chunk below, carrying only the fields it
    // names, while `normalizeVoltAgentToolErrors` yields `{ ...chunk, error }`
    // and so keeps the framework's raw `output` on the `/chat` SSE path.
    // `strands-agent-hooks.test.ts` asserts the canary is absent from this
    // chunk stringified whole; the VoltAgent side has no such test because it
    // would fail today. That divergence is archive#3263, not this seam's to
    // close.
    const resultError = result?.error as
      | (Error & { policyDenied?: true; stationComposedReason?: true })
      | undefined;
    const policyDenied = resultError?.policyDenied === true;
    const stationComposed =
      resultError?.stationComposedReason === true &&
      typeof resultError.message === 'string';
    // archive#3113: `result.status === 'error'` is Strands' OWN outcome
    // signal (set by `FunctionTool.stream()`'s error wrapping for any
    // thrown error, policy-denied or not — see createStrandsFunctionTools).
    // Before this fix, only the policy-denied branch above ever set a
    // top-level `error`; an ordinary failure fell all the way through to
    // `{}`, so the chunk carried NO error signal at all — not a false
    // checkmark like VoltAgent's, but a SILENT one (the issue's own
    // distinction). `output` is already redacted to the generic
    // `projectToolServerResult` shape for ANY error status (below), so the
    // top-level `error` text here is equally safe to be the same fixed
    // message — never `resultError.message`, which is untrusted outside the
    // station-composed branch.
    const isFailure =
      policyDenied || stationComposed || result?.status === 'error';
    return {
      type: 'tool-result',
      // NO toolName here: this event carries only the call id, and writing
      // that id under the name key put raw ids into every tool-name rollup
      // (archive#3082). The empty-string fallback used to hide them inside
      // the 'unknown' bucket. MetadataHandler resolves the real name from
      // the matching tool-call it already remembers by call id.
      // Pass the id through as-is; the emitter decides. `|| ''` wrote an
      // empty string into the durable record where the id was simply
      // unknown, and a join on that binds every id-less event together
      // (archive#3086).
      toolCallId: result?.toolUseId,
      output:
        projectToolServerResult(result) === result
          ? normalizeStrandsToolOutput(result?.content)
          : projectToolServerResult(result),
      ...(isFailure
        ? {
            error: stationComposed
              ? resultError!.message
              : GENERIC_TOOL_FAILURE_MESSAGE,
            ...(policyDenied ? { policyDenied: true } : {}),
          }
        : {}),
    };
  }

  return null;
}
