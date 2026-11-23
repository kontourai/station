/** Synthetic framing only; neither these bytes nor their counters qualify a provider. */
type Message = {
  id: string;
  type: 'message';
  role: 'assistant';
  status: 'completed';
  content: { type: 'output_text'; text: string; annotations: never[] }[];
};
type Call = {
  id: string;
  type: 'function_call';
  call_id: string;
  name: string;
  namespace?: string;
  arguments: string;
  status: 'completed';
};

function nativeSse(
  frames: readonly Record<string, unknown>[],
  sequenceNumbers = false,
) {
  return new Response(
    frames
      .map(
        (frame, sequence_number) =>
          `event: ${frame.type}\ndata: ${JSON.stringify(sequenceNumbers ? { ...frame, sequence_number } : frame)}\n\n`,
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

export function nativeResponsesStream(
  model: string,
  item: Message | Call,
  responseId = 'resp-native-funding',
) {
  const response = {
    id: responseId,
    object: 'response',
    status: 'completed',
    model,
    service_tier: 'default',
    output: [item],
    usage: {
      input_tokens: 4,
      output_tokens: 2,
      total_tokens: 6,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  const frames: Record<string, unknown>[] = [
    {
      type: 'response.created',
      response: {
        ...response,
        status: 'in_progress',
        output: [],
        usage: null,
        incomplete_details: null,
      },
    },
  ];
  if (item.type === 'function_call') {
    frames.push(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: item.id,
        delta: item.arguments,
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: item.id,
        arguments: item.arguments,
      },
    );
  } else {
    const part = item.content[0];
    if (!part) throw new Error('controlled_native_text_missing');
    frames.push(
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part: { ...part, text: '' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        delta: part.text,
      },
      {
        type: 'response.output_text.done',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        text: part.text,
      },
      {
        type: 'response.content_part.done',
        output_index: 0,
        item_id: item.id,
        content_index: 0,
        part,
      },
    );
  }
  frames.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  );
  return nativeSse(frames, true);
}

export function nativeToolCallStream(
  engine: 'claude' | 'codex',
  model: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
) {
  if (engine === 'codex')
    return nativeResponsesStream(
      model,
      {
        id: 'fc-native-effect',
        type: 'function_call',
        status: 'completed',
        call_id: callId,
        name,
        arguments: JSON.stringify(args),
      },
      'resp-native-effect-call',
    );
  return nativeSse([
    {
      type: 'message_start',
      message: {
        id: 'msg-native-effect',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: callId, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify(args),
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]);
}

export function nativeMessagesTextStream(
  model: string,
  text: string,
  usage: { input_tokens: number; output_tokens: number },
): Response {
  const chunks = text.match(/.{1,1024}/gsu) ?? [''];
  const frames = [
    {
      type: 'message_start',
      message: {
        id: 'msg-controlled',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    ...chunks.map((chunk) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: chunk },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
