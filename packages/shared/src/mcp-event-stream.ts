import type { ToolServerEventStreamFrame } from '@kontourai/station-contracts/tool';
import {
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCResponse,
  SUBSCRIPTION_ID_META_KEY,
} from '@modelcontextprotocol/client';
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
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  id: z.never().optional(),
  params: z.object({
    _meta: z.object({
      [SUBSCRIPTION_ID_META_KEY]: z.union([z.number(), z.string()]),
    }),
  }),
});

const maxStreamBytes = 2 * 1024 * 1024;
const maxFrameBytes = 256 * 1024;

export async function observeMcpEventStream(
  body: ReadableStream<Uint8Array>,
  request: { id: number | string; name: string },
  signal: AbortSignal,
  receive: (frame: ToolServerEventStreamFrame) => Promise<void>,
): Promise<JSONRPCResponse> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pendingLine = '';
  let pendingCR = false;
  let totalBytes = 0;
  let frameBytes = 0;
  let data: string[] = [];
  let eventType = 'message';
  let reply: JSONRPCResponse | undefined;
  let active = false;

  const complete = async () => {
    const payload = data.join('\n');
    const type = eventType;
    frameBytes = 0;
    data = [];
    eventType = 'message';
    if (!payload || type !== 'message') return;
    signal.throwIfAborted();
    const message: unknown = JSON.parse(payload);
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      if (message.id === request.id) reply = message;
      return;
    }
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
        if (reply) return;
        continue;
      }
      frameBytes += Buffer.byteLength(line) + 1;
      if (frameBytes > maxFrameBytes)
        throw new Error('MCP event stream frame exceeds the read limit');
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
      else if (line.startsWith('event:'))
        eventType = line.slice(6).replace(/^ /u, '') || 'message';
    }
  };

  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!reply) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        await scanLines((pendingCR ? '\r' : '') + decoder.decode());
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxStreamBytes)
        throw new Error('MCP event stream exceeds the read limit');
      let text =
        (pendingCR ? '\r' : '') + decoder.decode(value, { stream: true });
      pendingCR = text.endsWith('\r');
      if (pendingCR) text = text.slice(0, -1);
      await scanLines(text);
    }
    signal.throwIfAborted();
    if (!reply) throw new Error('MCP event stream closed without its reply');
    return reply;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
