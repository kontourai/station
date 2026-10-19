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
    'List accessible local simulators/emulators and sessions opened in this conversation. Needs a bound verified session; remote hosts are not included.',
    {},
    async () => callDevice('list', {}),
  );
  registry.tool(
    'device_open',
    'Start a local device if needed, or open its shared live session. Claims control only for the operation. Returns starting while booting. The user opens Device to watch; this tool does not reveal the pane.',
    {
      platform: z.enum(['ios', 'android']),
      deviceId: z.string().min(1).max(256),
    },
    async (args) => callDevice('open', args),
  );
  registry.tool(
    'device_screenshot',
    'Capture a bounded PNG from the shared local device. Refused while a human controls it or if control changes during capture.',
    { deviceSessionId },
    async (args) => callDevice('screenshot', args),
  );
  registry.tool(
    'device_snapshot',
    'Read the local device accessibility tree. Coordinates describe current screen content; re-inspect after changes. Refused while a human controls it.',
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
