import type { ToolServerEventStreamFrame } from '@kontourai/station-contracts/tool';
import { SUBSCRIPTION_ID_META_KEY } from '@modelcontextprotocol/client';
import { z } from 'zod';

const cursor = z.string().min(1).max(4096);
const streamNotice = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('notifications/events/active'),
    params: z.object({
      cursor,
      truncated: z.boolean(),
      heartbeatMs: z.number().int().positive(),
    }),
  }),
  z.object({
    method: z.literal('notifications/events/event'),
    params: z.object({
      cursor,
      name: z.string(),
      eventId: z.string().min(1).max(256),
      timestamp: z.iso.datetime({ offset: true }),
      data: z.json(),
    }),
  }),
  z.object({
    method: z.literal('notifications/events/heartbeat'),
    params: z.object({ cursor }),
  }),
]);

const identity = z.object({
  method: z.string(),
  params: z.object({
    _meta: z.object({
      [SUBSCRIPTION_ID_META_KEY]: z.union([z.number(), z.string()]),
    }),
  }),
});

const maxStreamBytes = 2 * 1024 * 1024;
const maxFrameBytes = 256 * 1024;

export function observeMcpEventStream(
  body: ReadableStream<Uint8Array>,
  request: { id: number | string; name: string },
  receive: (frame: ToolServerEventStreamFrame) => Promise<void>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pendingLine = '';
  let pendingCR = false;
  let totalBytes = 0;
  let frameBytes = 0;
  let data: string[] = [];
  let active = false;

  const complete = async () => {
    const lines = data;
    frameBytes = 0;
    data = [];
    if (!lines.length) return;

    const message: unknown = JSON.parse(lines.join('\n'));
    const parsed = identity.safeParse(message);
    if (
      !parsed.success ||
      !parsed.data.method.startsWith('notifications/events/')
    )
      return;
    if (parsed.data.params._meta[SUBSCRIPTION_ID_META_KEY] !== request.id)
      return;

    if (parsed.data.method === 'notifications/events/terminated') {
      if (active) await receive({ type: 'ended', reason: 'unavailable' });
      active = false;
      return;
    }
    const notice = streamNotice.parse(message);
    switch (notice.method) {
      case 'notifications/events/active':
        if (active) throw new Error('MCP event stream activated twice');
        active = true;
        await receive({ type: 'active', ...notice.params });
        break;
      case 'notifications/events/event': {
        if (!active || notice.params.name !== request.name)
          throw new Error('MCP event stream occurrence is out of scope');
        const { cursor, eventId, timestamp, data } = notice.params;
        await receive({ type: 'event', cursor, eventId, timestamp, data });
        break;
      }
      case 'notifications/events/heartbeat':
        if (!active) throw new Error('MCP event stream is inactive');
        await receive({ type: 'heartbeat', cursor: notice.params.cursor });
        break;
    }
  };

  const scanLines = async (text: string) => {
    const lines = (pendingLine + text.replace(/\r\n?/gu, '\n')).split('\n');
    pendingLine = lines.pop() ?? '';
    if (Buffer.byteLength(pendingLine) > maxFrameBytes)
      throw new Error('MCP event stream line exceeds the read limit');

    for (const line of lines) {
      if (line.length === 0) {
        await complete();
        continue;
      }
      frameBytes += Buffer.byteLength(line) + 1;
      if (frameBytes > maxFrameBytes)
        throw new Error('MCP event stream frame exceeds the read limit');
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
    }
  };

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxStreamBytes)
          throw new Error('MCP event stream exceeds the read limit');
        let text =
          (pendingCR ? '\r' : '') + decoder.decode(chunk, { stream: true });
        pendingCR = text.endsWith('\r');
        if (pendingCR) text = text.slice(0, -1);
        await scanLines(text);
        controller.enqueue(chunk);
      },
      async flush() {
        await scanLines((pendingCR ? '\r' : '') + decoder.decode());
      },
    }),
  );
}
