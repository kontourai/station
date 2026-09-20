import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { describe, expect, test, vi } from 'vitest';
import { applicationIpcPipes } from '../lib/application-ipc-pipes.js';

const open = {
  version: 'station.lab-ipc/v1',
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'open',
};
function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent: Buffer[] = [];
  input.on('data', (chunk) => sent.push(chunk));
  const accept = vi.fn((channel: ApplicationChannel) =>
    channel.subscribe((message) => channel.send(String(message)), vi.fn()),
  );
  const owner = applicationIpcPipes(input, output, accept);
  return { input, output, owner, accept, sent };
}
describe('dedicated application IPC pipes', () => {
  test('decodes fragmented packets and writes replies only on its dedicated input pipe', async () => {
    const h = fixture();
    const packet = `${JSON.stringify(open)}\n`;
    h.output.write(packet.slice(0, 17));
    h.output.write(packet.slice(17));
    expect(h.accept).toHaveBeenCalledTimes(1);
    h.output.write(
      JSON.stringify({ ...open, kind: 'message', body: 'fixture response' }) +
        '\n',
    );
    expect(JSON.parse(Buffer.concat(h.sent).toString().trim())).toMatchObject({
      kind: 'message',
      body: 'fixture response',
    });
    h.owner.prepareClose();
    const ended = once(h.output, 'end');
    h.output.end();
    await ended;
    expect(() => h.owner.finish()).not.toThrow();
    h.input.destroy();
  });
  test.each(['not-json\n', 'x'.repeat(256 * 1024 + 1), Buffer.from([0xff])])(
    'rejects malformed input and remains bounded after refusal',
    async (value) => {
      const h = fixture();
      h.output.write(value);
      h.output.write('x'.repeat(512 * 1024));
      expect(h.accept).not.toHaveBeenCalled();
      h.owner.prepareClose();
      const ended = once(h.output, 'end');
      h.output.end();
      await ended;
      expect(() => h.owner.finish()).toThrow('framing or lifecycle');
      h.input.destroy();
    },
  );
  test('unexpected EOF and a partial final packet are not successful cleanup', async () => {
    const h = fixture();
    h.output.write('{');
    const ended = once(h.output, 'end');
    h.output.end();
    await ended;
    h.owner.prepareClose();
    expect(() => h.owner.finish()).toThrow('framing or lifecycle');
    h.input.destroy();
  });
});
