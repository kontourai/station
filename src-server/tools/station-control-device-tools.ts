import { z } from 'zod';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

async function callDevice(operation: string, body: Record<string, unknown>) {
  try {
    const result = await api(`/api/device-agent/${operation}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (typeof result?.ok !== 'boolean')
      return jsonToolResult(
        { ok: false, code: 'unavailable' },
        { failed: true },
      );
    if (result.ok && result.capture) {
      const { pngBase64, ...capture } = result.capture;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ...result, capture }),
          },
          {
            type: 'image' as const,
            data: pngBase64 as string,
            mimeType: 'image/png',
          },
        ],
      };
    }
    return jsonToolResult(result, { failed: result.ok === false });
  } catch {
    return jsonToolResult({ ok: false, code: 'unavailable' }, { failed: true });
  }
}

export function registerDeviceTools(registry: StationControlToolRegistry) {
  const deviceSessionId = z
    .string()
    .min(1)
    .max(80)
    .describe('session.sessionId from device_open or device_list.');
  registry.tool(
    'device_list',
    'List accessible local and SSH-hosted simulators/emulators and sessions opened in this conversation. Needs a bound verified session.',
    {},
    async () => callDevice('list', {}),
  );
  registry.tool(
    'device_open',
    'Start a local or SSH-hosted device if needed, or open its shared live session without acquiring control. Returns starting while booting; retry with the running device ID from device_list. Requests Device pane reveal in the active conversation by default; reveal:false opens in the background. revealRequested is not confirmation that a user viewed it.',
    {
      platform: z.enum(['ios', 'android']),
      reveal: z.boolean().optional(),
      deviceId: z.string().min(1).max(256),
      hostId: z
        .string()
        .regex(/^(?:local|ssh-[0-9a-f]{12})$/)
        .optional()
        .describe('hostId from device_list; defaults to local.'),
    },
    async (args) => callDevice('open', args),
  );
  registry.tool(
    'device_screenshot',
    'Capture a bounded PNG from the shared device on its own host. Refused while a human controls it or if control changes during capture.',
    { deviceSessionId },
    async (args) => callDevice('screenshot', args),
  );
  registry.tool(
    'device_snapshot',
    'Read the device accessibility tree on its own host. Coordinates describe current screen content; re-inspect after changes. Refused while a human controls it.',
    { deviceSessionId },
    async (args) => callDevice('snapshot', args),
  );
  registry.tool(
    'device_input',
    'Send up to 64 live-surface events. Complete pointer/key gestures within one batch; unmatched down/up is refused before delivery. Tap/drag uses screen pixels. Human takeover interrupts input.',
    {
      deviceSessionId,
      events: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .max(64)
        .describe(
          'Live-surface events: {kind:"pointer",type:"down"|"move"|"up",x,y,pointerType:"touch"}; {kind:"text",text}; {kind:"key",type:"down"|"up",key,code}.',
        ),
    },
    async (args) => callDevice('input', args),
  );
  registry.tool(
    'device_close',
    'End a local device session this conversation opened, for every viewer. Requires operator standing. Leaves the device running; refuses human-opened sessions and other controllers.',
    { deviceSessionId },
    async (args) => callDevice('close', args),
  );
}
