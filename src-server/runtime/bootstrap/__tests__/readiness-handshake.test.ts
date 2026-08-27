import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatReadinessHandshake,
  installStdoutEpipeGuard,
  isBrokenPipeError,
  writeReadinessHandshake,
} from '../readiness-handshake.js';

function captureStream() {
  const chunks: string[] = [];
  return {
    chunks,
    stream: {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    },
  };
}

describe('readiness handshake', () => {
  it('serializes a single newline-terminated JSON line', () => {
    const line = formatReadinessHandshake(51234, '127.0.0.1');
    expect(line.endsWith('\n')).toBe(true);
    // Exactly one line: no embedded newlines in the payload itself.
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line)).toEqual({
      event: 'listening',
      port: 51234,
      host: '127.0.0.1',
    });
  });

  it('writes exactly one handshake line when enabled, echoing the bound port', () => {
    const { chunks, stream } = captureStream();
    writeReadinessHandshake(stream, 61000, '0.0.0.0', true);

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0]);
    expect(parsed).toEqual({
      event: 'listening',
      port: 61000,
      host: '0.0.0.0',
    });
    expect(chunks[0].endsWith('\n')).toBe(true);
  });

  it('writes nothing when the handshake is not enabled', () => {
    const { chunks, stream } = captureStream();
    writeReadinessHandshake(stream, 61000, '0.0.0.0', false);
    expect(chunks).toHaveLength(0);
  });

  it('absorbs a closed stdout EPIPE exactly once without recursive logging', () => {
    const stream = Object.assign(new EventEmitter(), {
      write: () => true,
    });
    let shutdowns = 0;
    installStdoutEpipeGuard(stream, () => {
      shutdowns += 1;
      // The real callback deliberately does not log: doing so writes the
      // broken stdout again. A second EPIPE must not re-enter shutdown.
    });

    const epipe = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    expect(() => stream.emit('error', epipe)).not.toThrow();
    expect(() => stream.emit('error', epipe)).not.toThrow();
    expect(shutdowns).toBe(1);
    expect(isBrokenPipeError(epipe)).toBe(true);
  });

  it('makes a synchronous handshake EPIPE inert too', () => {
    const stream = {
      write: () => {
        throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
      },
    };
    expect(writeReadinessHandshake(stream, 61000, '127.0.0.1', true)).toBe(
      false,
    );
  });

  it('arms the stdout EPIPE guard before runtime initialization can log', () => {
    const index = readFileSync(
      resolve(import.meta.dirname, '..', '..', '..', 'index.ts'),
      'utf8',
    );
    expect(
      index.indexOf('installStdoutEpipeGuard(process.stdout'),
    ).toBeLessThan(index.indexOf('await runtime.initialize()'));
  });
});
