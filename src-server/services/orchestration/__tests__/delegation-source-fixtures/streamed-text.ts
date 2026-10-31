/** Controlled provider framing; no network, provider qualification or billing claim. */
export function controlledTextStream(
  provider: 'anthropic' | 'google',
  model: string,
  text: string,
  usage: Record<string, unknown>,
): Response {
  const chunks = text.match(/.{1,1024}/gsu) ?? [''];
  const frames =
    provider === 'anthropic'
      ? [
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
        ]
      : [
          ...chunks.map((chunk) => ({
            modelVersion: model,
            candidates: [
              {
                index: 0,
                content: { role: 'model', parts: [{ text: chunk }] },
              },
            ],
          })),
          {
            modelVersion: model,
            candidates: [{ index: 0, finishReason: 'STOP' }],
            usageMetadata: usage,
          },
        ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

export function controlledInputStream(
  model: string,
  question: string,
): Response {
  const frames = [
    {
      type: 'message_start',
      message: {
        id: 'msg-input',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 4,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call-input',
        name: 'station_request_input',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({ question }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: 'message_stop' },
  ];
  return new Response(
    frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
