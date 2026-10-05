/**
 * #3160: a pooled station-control stdio child carries no verified caller, so
 * every Session tool refuses it before it makes a request. Run as a real child
 * process (the stdio entry marker is process-global), pointed at a port with
 * nothing listening: a request would fail loudly, so a typed
 * `station_control_caller_required` refusal can only come from the tool-side
 * check.
 */
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '../../..');
const probe = `
import { createStationControlMcpServer } from './src-server/tools/station-control-mcp-server.ts';
import { installStationControlStdioEntry } from './src-server/tools/station-control-shared.ts';
installStationControlStdioEntry();
const server = createStationControlMcpServer();
const sent = [];
const transport = { start: async () => {}, close: async () => {}, send: async (m) => { sent.push(m); } };
await server.connect(transport);
const request = async (id, method, params = {}) => {
  setImmediate(() => transport.onmessage({ jsonrpc: '2.0', id, method, params }));
  for (let i = 0; i < 500; i += 1) {
    const found = sent.find((m) => m.id === id);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no response ' + id);
};
await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'engine', version: '1' } });
const calls = {
  send_to_session: { sessionId: 's', text: 'hi', requestKey: 'key-0000001' },
  interrupt_session: { sessionId: 's', requestKey: 'key-0000002' },
  wait_session: { sessionId: 's', until: 'idle' },
};
const out = {};
let id = 10;
for (const [name, args] of Object.entries(calls)) {
  const response = await request(++id, 'tools/call', { name, arguments: args });
  out[name] = { isError: response.result?.isError === true, body: JSON.parse(response.result.content[0].text) };
}
console.log(JSON.stringify(out));
process.exit(0);
`;

test('a caller-less stdio child is refused by every Session tool, before any request', async () => {
  const result = await run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', probe],
    {
      cwd: root,
      env: {
        ...process.env,
        STATION_API_BASE: 'http://127.0.0.1:1',
        STATION_INTERNAL_API_TOKEN: 'fixture-internal-token',
      },
      timeout: 60_000,
      maxBuffer: 65_536,
      windowsHide: true,
    },
  );
  const out = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Record<
    string,
    { isError: boolean; body: { success?: boolean; code?: string } }
  >;
  expect(Object.keys(out).sort()).toEqual([
    'interrupt_session',
    'send_to_session',
    'wait_session',
  ]);
  for (const [name, answer] of Object.entries(out))
    expect([
      name,
      answer.isError,
      answer.body.success,
      answer.body.code,
    ]).toEqual([name, true, false, 'station_control_caller_required']);
}, 90_000);
