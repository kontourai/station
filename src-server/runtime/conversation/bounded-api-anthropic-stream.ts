import { parseReportInputArguments } from './bounded-api-provider-contract.js';
import {
  type RawProviderFrame,
  RawSseUnavailable,
} from './bounded-api-sse-response.js';
import { REPORT_INPUT_TOOL_NAME } from './report-input-profile.js';

type Obj = Record<string, unknown>;
const fail = (): never => {
  throw new RawSseUnavailable('Complete Anthropic stream unavailable');
};
function object(value: unknown): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return fail();
  return value as Obj;
}
function closed(value: unknown, allowed: readonly string[]): Obj {
  const result = object(value);
  if (Object.keys(result).some((k) => !allowed.includes(k))) fail();
  return result;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    return fail();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string') return fail();
  return value;
}
const USAGE = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation',
  'service_tier',
  'inference_geo',
  'speed',
  'output_tokens_details',
  'server_tool_use',
];
function mergeUsage(previous: Obj, next: unknown): Obj {
  const result = { ...previous };
  for (const [key, value] of Object.entries(closed(next, USAGE))) {
    if (key.endsWith('_tokens')) {
      const count = integer(value);
      if (result[key] !== undefined && count < integer(result[key])) fail();
    } else if (
      result[key] !== undefined &&
      JSON.stringify(result[key]) !== JSON.stringify(value)
    )
      fail();
    // Preserve all allowed metadata. The pricing owner must still qualify it.
    result[key] = structuredClone(value);
  }
  return result;
}

// Completed transport framing is a prerequisite. Semantic EOF is message_stop,
// not merely reader.done; the existing pricing owner still validates this result.
export function assembleAnthropicStream(
  frames: ReadonlyArray<RawProviderFrame>,
  reportInput = false,
): Obj {
  let message: Obj | undefined,
    usage: Obj = {},
    ended = false,
    finalDelta = false;
  const blocks: Obj[] = [];
  const argumentsByBlock = new Map<number, string>();
  let toolCalls = 0;
  let open: number | undefined;
  let stopReason: unknown = null,
    stopSequence: unknown = null;
  for (const frame of frames) {
    const data = object(frame.data);
    const type = text(data.type);
    if ((frame.event !== undefined && frame.event !== type) || ended) fail();
    if (type === 'ping') {
      closed(data, ['type']);
      continue;
    }
    if (type === 'message_start') {
      closed(data, ['type', 'message']);
      if (message) fail();
      message = structuredClone(
        closed(data.message, [
          'id',
          'type',
          'role',
          'model',
          'content',
          'stop_reason',
          'stop_sequence',
          'usage',
          'container',
        ]),
      );
      if (
        !Array.isArray(message.content) ||
        message.content.length ||
        message.stop_reason !== null ||
        message.stop_sequence !== null
      )
        fail();
      integer(object(message.usage).input_tokens);
      usage = mergeUsage({}, message.usage);
    } else {
      if (!message) fail();
      if (type === 'content_block_start') {
        closed(data, ['type', 'index', 'content_block']);
        const index = integer(data.index);
        if (finalDelta || open !== undefined || index !== blocks.length) fail();
        const block = object(data.content_block);
        if (block.type === 'text') {
          closed(block, ['type', 'text', 'citations']);
          text(block.text);
        } else if (block.type === 'tool_use' && reportInput) {
          closed(block, ['type', 'id', 'name', 'input']);
          if (
            ++toolCalls > 1 ||
            block.name !== REPORT_INPUT_TOOL_NAME ||
            text(block.id).length > 128 ||
            Object.keys(object(block.input)).length
          )
            fail();
          argumentsByBlock.set(index, '');
        } else if (block.type === 'thinking') {
          closed(block, ['type', 'thinking', 'signature']);
          text(block.thinking);
          if (block.signature !== undefined) text(block.signature);
        } else if (block.type === 'redacted_thinking') {
          closed(block, ['type', 'data']);
          text(block.data);
        } else fail();
        blocks.push(structuredClone(block));
        open = index;
      } else if (type === 'content_block_delta') {
        closed(data, ['type', 'index', 'delta']);
        if (finalDelta || open === undefined || integer(data.index) !== open)
          fail();
        const block = blocks[integer(data.index)],
          delta = object(data.delta);
        if (
          delta.type === 'input_json_delta' &&
          reportInput &&
          block.type === 'tool_use'
        ) {
          closed(delta, ['type', 'partial_json']);
          const index = integer(data.index);
          const prior = argumentsByBlock.get(index);
          if (prior === undefined) return fail();
          const next = prior + text(delta.partial_json);
          if (Buffer.byteLength(next) > 8192) fail();
          argumentsByBlock.set(index, next);
          continue;
        }
        const field =
          delta.type === 'text_delta'
            ? 'text'
            : delta.type === 'thinking_delta'
              ? 'thinking'
              : delta.type === 'signature_delta'
                ? 'signature'
                : fail();
        closed(delta, ['type', field]);
        if (
          (field === 'text' && block.type !== 'text') ||
          (field !== 'text' && block.type !== 'thinking')
        )
          fail();
        block[field] =
          (block[field] === undefined ? '' : text(block[field])) +
          text(delta[field]);
      } else if (type === 'content_block_stop') {
        closed(data, ['type', 'index']);
        if (open === undefined || integer(data.index) !== open) fail();
        const index = integer(data.index);
        if (blocks[index].type === 'tool_use') {
          const serialized = argumentsByBlock.get(index);
          if (!serialized) return fail();
          const input = parseReportInputArguments(serialized);
          blocks[index].input = input;
          argumentsByBlock.delete(index);
        }
        open = undefined;
      } else if (type === 'message_delta') {
        closed(data, ['type', 'delta', 'usage']);
        if (open !== undefined || finalDelta) fail();
        const delta = closed(data.delta, ['stop_reason', 'stop_sequence']);
        stopReason = text(delta.stop_reason);
        stopSequence = delta.stop_sequence;
        integer(object(data.usage).output_tokens);
        usage = mergeUsage(usage, data.usage);
        finalDelta = true;
      } else if (type === 'message_stop') {
        closed(data, ['type']);
        if (open !== undefined || !finalDelta) fail();
        ended = true;
      } else fail();
    }
  }
  if (!message || !ended) return fail();
  return {
    ...message,
    content: blocks,
    usage,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
  };
}
