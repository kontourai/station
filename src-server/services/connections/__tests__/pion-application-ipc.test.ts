import { PassThrough } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { describe, expect, test, vi } from 'vitest';
import {
  PION_APPLICATION_IPC_VERSION,
  PionApplicationIpc,
} from '../pion-application-ipc.js';

const id = '12345678-1234-1234-1234-123456789012';
describe('Pion application IPC', () => {
  test('admits one typed channel and keeps application frames on private pipes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let channel!: ApplicationChannel;
    const ipc = new PionApplicationIpc(input, output, (value) => {
      channel = value;
    });
    let written = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      written += chunk;
    });
    output.write(
      `${JSON.stringify({ version: PION_APPLICATION_IPC_VERSION, id, kind: 'open' })}\n`,
    );
    await vi.waitFor(() => expect(channel).toBeDefined());
    const received = vi.fn();
    channel.subscribe(received, vi.fn());
    output.write(
      `${JSON.stringify({ version: PION_APPLICATION_IPC_VERSION, id, kind: 'message', body: 'request-secret' })}\n`,
    );
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith('request-secret'),
    );
    channel.send('response-secret');
    await vi.waitFor(() => expect(written).toContain('response-secret'));
    expect(JSON.parse(written.trim())).toEqual({
      version: PION_APPLICATION_IPC_VERSION,
      id,
      kind: 'message',
      body: 'response-secret',
    });
    ipc.close();
    ipc.finish();
  });
  test('retires malformed protocol versions before accepting a channel', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const accept = vi.fn();
    const ipc = new PionApplicationIpc(input, output, accept);
    output.write(
      `${JSON.stringify({ version: 'foreign', id, kind: 'open' })}\n`,
    );
    await vi.waitFor(() => expect(input.writableEnded).toBe(true));
    expect(accept).not.toHaveBeenCalled();
    expect(() => ipc.finish()).toThrow('pion_application_ipc_failed');
  });
  test('bounds channel count and escaped frame bytes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const channels: ApplicationChannel[] = [];
    const ipc = new PionApplicationIpc(input, output, (channel) =>
      channels.push(channel),
    );
    for (let index = 0; index < 32; index++) {
      const next = `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
      output.write(
        `${JSON.stringify({ version: PION_APPLICATION_IPC_VERSION, id: next, kind: 'open' })}\n`,
      );
    }
    await vi.waitFor(() => expect(channels).toHaveLength(32));
    output.write(
      `${JSON.stringify({ version: PION_APPLICATION_IPC_VERSION, id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', kind: 'open' })}\n`,
    );
    await vi.waitFor(() => expect(input.writableEnded).toBe(true));
    expect(() => ipc.finish()).toThrow();
  });
});
