import {
  type RawProviderFrame,
  RawSseUnavailable,
} from './bounded-api-sse-response.js';

type Obj = Record<string, unknown>;
const fail = (): never => {
  throw new RawSseUnavailable('Complete Google stream unavailable');
};
function object(v: unknown): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  return v as Obj;
}
function closed(v: unknown, keys: readonly string[]): Obj {
  const o = object(v);
  if (Object.keys(o).some((k) => !keys.includes(k))) fail();
  return o;
}
function array(v: unknown): unknown[] {
  if (!Array.isArray(v)) return fail();
  return v;
}
function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return fail();
  return v;
}
function stable(target: Obj, key: string, value: unknown): void {
  if (
    target[key] !== undefined &&
    JSON.stringify(target[key]) !== JSON.stringify(value)
  )
    fail();
  target[key] = structuredClone(value);
}
// This restricted single-candidate assembler never follows continuation requests.
// The pure response qualifier remains responsible for all final scope and pricing.
export function assembleGoogleStream(
  frames: ReadonlyArray<RawProviderFrame>,
): Obj {
  const response: Obj = {},
    candidate: Obj = {},
    parts: unknown[] = [];
  let usage: Obj | undefined,
    finished = false,
    finalUsage = false;
  for (const frame of frames) {
    if (frame.event !== undefined) fail();
    const chunk = closed(frame.data, [
      'modelVersion',
      'responseId',
      'candidates',
      'usageMetadata',
      'promptFeedback',
      'modelStatus',
    ]);
    for (const key of [
      'modelVersion',
      'responseId',
      'promptFeedback',
      'modelStatus',
    ])
      if (chunk[key] !== undefined) stable(response, key, chunk[key]);
    if (chunk.candidates !== undefined) {
      const candidates = array(chunk.candidates);
      if (candidates.length !== 1) fail();
      const item = closed(candidates[0], [
        'content',
        'finishReason',
        'index',
        'safetyRatings',
        'finishMessage',
        'citationMetadata',
        'tokenCount',
        'avgLogprobs',
      ]);
      if (item.index !== undefined && item.index !== 0) fail();
      if (item.content !== undefined && item.content !== null) {
        const content = closed(item.content, ['role', 'parts']);
        if (content.role !== undefined && content.role !== 'model') fail();
        if (content.parts !== undefined && content.parts !== null) {
          if (finished) fail();
          parts.push(...structuredClone(array(content.parts)));
        }
      }
      for (const [key, value] of Object.entries(item))
        if (key !== 'content' && value !== undefined && value !== null) {
          if (key === 'finishReason') {
            if (finished) fail();
            finished = true;
          }
          stable(candidate, key, value);
        }
    }
    if (chunk.usageMetadata !== undefined && chunk.usageMetadata !== null) {
      const next = object(chunk.usageMetadata);
      if (finished) {
        count(next.promptTokenCount);
        count(next.totalTokenCount);
        for (const key of Object.keys(usage ?? {}))
          if (key.endsWith('TokenCount') && next[key] === undefined) fail();
        finalUsage = true;
      }
      for (const [key, value] of Object.entries(next)) {
        if (key.endsWith('TokenCount')) {
          const n = count(value);
          if (usage?.[key] !== undefined && n < count(usage[key])) fail();
        } else if (
          usage?.[key] !== undefined &&
          JSON.stringify(usage[key]) !== JSON.stringify(value)
        )
          fail();
      }
      // Keep prior fields too: dropping contradictory/unknown metadata cannot erase it.
      usage = { ...usage, ...structuredClone(next) };
    }
  }
  if (
    !finished ||
    !finalUsage ||
    !usage ||
    typeof response.modelVersion !== 'string'
  )
    return fail();
  count(usage.promptTokenCount);
  count(usage.totalTokenCount);
  return {
    ...response,
    candidates: [{ ...candidate, content: { role: 'model', parts } }],
    usageMetadata: usage,
  };
}
