import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { onNdjsonLines, readNdjsonLines } from '../ndjson-lines.js';

const LS = '\u2028';
const PS = '\u2029';

function collect(chunks: Array<Buffer | string>, end = true): string[] {
  const stream = new PassThrough();
  const lines: string[] = [];
  onNdjsonLines(stream, (line) => lines.push(line));
  // PassThrough delivers synchronously once a 'data' listener is attached.
  for (const chunk of chunks) stream.write(chunk);
  if (end) stream.end();
  return lines;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('onNdjsonLines', () => {
  test('keeps U+2028 and U+2029 inside a line', async () => {
    const lines = collect([`{"a":"x${LS}y${PS}z"}\n`]);
    await settle();
    expect(lines).toEqual([`{"a":"x${LS}y${PS}z"}`]);
    expect(JSON.parse(lines[0]!).a).toBe(`x${LS}y${PS}z`);
  });

  test('strips the \\r of \\r\\n but keeps a lone \\r', async () => {
    const lines = collect(['one\r\ntwo\rthree\n']);
    await settle();
    expect(lines).toEqual(['one', 'two\rthree']);
  });

  test('reassembles a UTF-8 sequence split across Buffer chunks', async () => {
    const bytes = Buffer.from(`{"a":"${LS}é"}\n`, 'utf8');
    const ls = bytes.indexOf(Buffer.from(LS, 'utf8'));
    const chunks = [
      bytes.subarray(0, ls + 1),
      bytes.subarray(ls + 1, ls + 2),
      bytes.subarray(ls + 2, ls + 4),
      bytes.subarray(ls + 4),
    ];
    const lines = collect(chunks);
    await settle();
    expect(lines).toEqual([`{"a":"${LS}é"}`]);
  });

  test('joins a line split across chunks and splits several lines in one chunk', async () => {
    const lines = collect(['{"a"', ':1}\n{"b":2}\n{"c"', ':3}\n\n']);
    await settle();
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '']);
  });

  test('emits a trailing unterminated line at end of stream, and only then', async () => {
    const open = collect(['{"a":1}\n{"b"'], false);
    await settle();
    expect(open).toEqual(['{"a":1}']);
    const ended = collect(['{"a":1}\n{"b":2}']);
    await settle();
    expect(ended).toEqual(['{"a":1}', '{"b":2}']);
  });

  test('emits nothing for an empty stream or one ending in a newline', async () => {
    // Both read after `end` has fired, so an end-of-stream '' would show.
    const empty = collect([]);
    const lines = collect(['x\n']);
    await settle();
    expect(empty).toEqual([]);
    expect(lines).toEqual(['x']);
  });

  test('a throwing callback does not leak a buffered prefix into the next line', () => {
    // A synchronous stand-in so the throw surfaces at the write call.
    const stream = new EventEmitter() as unknown as NodeJS.ReadableStream;
    const lines: string[] = [];
    let thrown = false;
    onNdjsonLines(stream, (line) => {
      if (!thrown) {
        thrown = true;
        throw new Error('boom');
      }
      lines.push(line);
    });
    stream.emit('data', 'pre');
    expect(() => stream.emit('data', 'fix\ntail')).toThrow('boom');
    stream.emit('data', '\nnext\n');
    stream.emit('end');
    expect(lines).toEqual(['tail', 'next']);
  });

  test('detach stops delivery, including the end-of-stream flush', async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const detach = onNdjsonLines(stream, (line) => lines.push(line));
    stream.write('a\nb');
    detach();
    stream.resume();
    stream.write('\nc\n');
    stream.end();
    await settle();
    expect(lines).toEqual(['a']);
  });
});

describe('readNdjsonLines', () => {
  test('yields every line of an async source with separators intact', async () => {
    const bytes = Buffer.from(`{"a":"1${LS}"}\r\n{"b":"2${PS}"}\n{"c":3}`);
    const ps = bytes.indexOf(Buffer.from(PS, 'utf8'));
    const source = Readable.from([
      bytes.subarray(0, ps + 2),
      bytes.subarray(ps + 2),
    ]);
    const lines: string[] = [];
    for await (const line of readNdjsonLines(source)) lines.push(line);
    expect(lines).toEqual([`{"a":"1${LS}"}`, `{"b":"2${PS}"}`, '{"c":3}']);
  });

  test('stops reading the source when the consumer breaks early', async () => {
    const source = Readable.from(['a\nb\n', 'c\n']);
    for await (const line of readNdjsonLines(source)) {
      expect(line).toBe('a');
      break;
    }
    expect(source.destroyed).toBe(true);
  });
});
