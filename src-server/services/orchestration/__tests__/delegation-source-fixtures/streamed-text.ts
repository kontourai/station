/** Controlled provider framing; no network, provider qualification or billing claim. */
export function controlledTextStream(
  provider: 'anthropic' | 'google',
  model: string,
  text: string,
  usage: Record<string, unknown>,
): Response {
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
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: usage.output_tokens },
          },
          { type: 'message_stop' },
        ]
      : [
          {
            modelVersion: model,
            candidates: [
              { index: 0, content: { role: 'model', parts: [{ text }] } },
            ],
          },
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
