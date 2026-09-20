import type { Readable, Writable } from 'node:stream';
import type { ApplicationChannel } from '@kontourai/station-connect/application-channel';
import { ApplicationIpc } from './application-ipc.js';

/** Dedicated fixture descriptors keep application content out of captured logs. */
export function applicationIpcPipes(
  input: Writable,
  output: Readable,
  accept: (channel: ApplicationChannel) => void,
) {
  let receive: ((value: unknown) => void) | undefined;
  let failure: Error | undefined;
  let closing = false;
  let buffered = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let ipc: ApplicationIpc | undefined;
  const fail = () => {
    buffered = '';
    failure ??= new Error(
      'Pion application IPC failed its framing or lifecycle contract',
    );
    ipc?.close();
  };
  const data = (chunk: Buffer) => {
    if (failure) return;
    try {
      buffered += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(buffered) > 256 * 1024)
        throw new Error('IPC input exceeded buffer bound');
      while (true) {
        const end = buffered.indexOf('\n');
        if (end === -1) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (Buffer.byteLength(line) > 128 * 1024)
          throw new Error('IPC packet exceeded bound');
        receive?.(JSON.parse(line));
      }
    } catch {
      fail();
    }
  };
  const ended = () => {
    if (failure) return;
    try {
      buffered += decoder.decode();
      if (buffered.length || !closing) fail();
    } catch {
      fail();
    }
  };
  const inputFailed = () => {
    if (!closing) fail();
  };
  input.on('error', inputFailed);
  output.on('data', data);
  output.on('error', fail);
  output.on('end', ended);
  ipc = new ApplicationIpc(
    {
      send: (packet, done) =>
        input.write(`${JSON.stringify(packet)}\n`, (error) =>
          done(error ?? null),
        ),
      subscribe(listener) {
        receive = listener;
        return () => {
          receive = undefined;
        };
      },
    },
    accept,
  );
  return {
    prepareClose() {
      closing = true;
      ipc!.close();
    },
    finish() {
      input.off('error', inputFailed);
      output.off('data', data);
      output.off('error', fail);
      output.off('end', ended);
      if (failure) throw failure;
      if (buffered.length)
        throw new Error('Pion application IPC ended with a partial packet');
    },
  };
}
