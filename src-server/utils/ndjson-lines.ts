import { StringDecoder } from 'node:string_decoder';

/**
 * Newline-delimited JSON framing that splits on `\n` only.
 *
 * `node:readline` also ends a line at U+2028, U+2029 and a lone `\r`. JSON
 * allows raw U+2028/U+2029 inside strings, and neither `JSON.stringify` nor
 * serde_json escapes them, so readline cuts any record whose text contains one
 * into two unparseable halves. These readers keep such records whole.
 *
 * A trailing `\r` is dropped so `\r\n` input frames the same way. Buffer
 * chunks decode through one `StringDecoder`, so a UTF-8 sequence split across
 * chunks is reassembled. A final line without a newline is emitted at end of
 * input when it is non-empty, as readline does. Like readline, there is no
 * per-line cap: callers that need a bound enforce it on the stream's total
 * bytes (see the Codex stdout ingress limit).
 */
function createNdjsonLineSplitter(onLine: (line: string) => void): {
  write(chunk: Buffer | string): void;
  end(): void;
} {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (line: string) =>
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  return {
    write(chunk) {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      // Scan only the new text so a long line arriving in many chunks stays
      // linear rather than rescanning the whole pending buffer each time.
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        const line = text.slice(start, newline);
        emit(start === 0 ? pending + line : line);
        if (start === 0) pending = '';
        start = newline + 1;
      }
      pending = start === 0 ? pending + text : text.slice(start);
    },
    end() {
      const rest = pending + decoder.end();
      pending = '';
      if (rest.length > 0) emit(rest);
    },
  };
}

/**
 * Calls `onLine` for every `\n`-terminated line of `stream`, plus a final
 * unterminated line at `end`. Returns a detach function that stops delivery.
 */
export function onNdjsonLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
): () => void {
  let detached = false;
  const splitter = createNdjsonLineSplitter((line) => {
    if (!detached) onLine(line);
  });
  const onData = (chunk: Buffer | string) => splitter.write(chunk);
  const onEnd = () => splitter.end();
  stream.on('data', onData);
  stream.on('end', onEnd);
  return () => {
    detached = true;
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
  };
}

/** Async-iterates the `\n`-delimited lines of `source` (e.g. a file stream). */
export async function* readNdjsonLines(
  source: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
  let lines: string[] = [];
  const splitter = createNdjsonLineSplitter((line) => lines.push(line));
  for await (const chunk of source) {
    splitter.write(chunk);
    if (lines.length === 0) continue;
    const ready = lines;
    lines = [];
    yield* ready;
  }
  splitter.end();
  yield* lines;
}
