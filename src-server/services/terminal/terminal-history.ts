const HISTORY_LINE_LIMIT = 5000;
const HISTORY_BYTE_LIMIT = 2 * 1024 * 1024;
const CHUNK_LENGTH = 4096;

type EscapeState = 'text' | 'escape' | 'csi' | 'string' | 'string-escape';

/** Append and eviction inspect only new or discarded text, never the retained tail. */
export class TerminalHistory {
  private chunks: string[] = [];
  private head = 0;
  private offset = 0;
  private bytes = 0;
  private newlines = 0;
  private escapeState: EscapeState = 'text';

  constructor(history: string) {
    this.append(history);
  }

  append(data: string): void {
    if (!data) return;
    let tail = this.chunks.at(-1);
    // PTY callbacks can divide a surrogate pair. Count the joined pair as UTF-8.
    this.bytes += Buffer.byteLength(data);
    let start = 0;
    if (
      tail &&
      /[\uD800-\uDBFF]$/.test(tail) &&
      /^[\uDC00-\uDFFF]/.test(data)
    ) {
      this.bytes -= 2;
      tail += data[0];
      this.chunks[this.chunks.length - 1] = tail;
      start = 1;
    }
    for (let i = data.indexOf('\n'); i !== -1; i = data.indexOf('\n', i + 1)) {
      this.newlines++;
    }
    if (tail && tail.length < CHUNK_LENGTH + 1) {
      const length = Math.max(1, CHUNK_LENGTH - tail.length);
      let end = Math.min(data.length, start + length);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end++;
      this.chunks[this.chunks.length - 1] = tail + data.slice(start, end);
      start = end;
    }
    while (start < data.length) {
      let end = Math.min(data.length, start + CHUNK_LENGTH);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end++;
      this.chunks.push(data.slice(start, end));
      start = end;
    }

    let discarded = false;
    let last = '';
    while (
      this.bytes > HISTORY_BYTE_LIMIT ||
      this.newlines >= HISTORY_LINE_LIMIT
    ) {
      last = this.discardCharacter();
      discarded = true;
    }
    // Prefer a complete line, but newline-free output must still have a hard cap.
    if (discarded && last !== '\n' && this.newlines > 0) {
      while (this.discardCharacter() !== '\n') {
        /* advance to the next line */
      }
    }
    // A byte cutoff may land inside CSI/OSC/DCS, including across PTY callbacks.
    while (this.bytes > 0 && this.escapeState !== 'text')
      this.discardCharacter();
    if (this.head > 0 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  toString(): string {
    return [
      this.chunks[this.head]?.slice(this.offset) ?? '',
      ...this.chunks.slice(this.head + 1),
    ].join('');
  }

  private discardCharacter(): string {
    const chunk = this.chunks[this.head]!;
    const point = chunk.codePointAt(this.offset)!;
    const char = String.fromCodePoint(point);
    this.offset += char.length;
    this.bytes -=
      point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (char === '\n') this.newlines--;
    this.advanceEscape(char, point);
    if (this.offset === chunk.length) {
      this.chunks[this.head++] = '';
      this.offset = 0;
    }
    return char;
  }

  private advanceEscape(char: string, point: number): void {
    if (this.escapeState === 'string' || this.escapeState === 'string-escape') {
      if (
        char === '\x07' ||
        char === '\x9c' ||
        (this.escapeState === 'string-escape' && char === '\\')
      ) {
        this.escapeState = 'text';
      } else {
        this.escapeState = char === '\x1b' ? 'string-escape' : 'string';
      }
    } else if (char === '\x1b') {
      this.escapeState = 'escape';
    } else if (this.escapeState === 'escape') {
      if (char === '[') this.escapeState = 'csi';
      else if (']PX^_'.includes(char)) this.escapeState = 'string';
      else if (point >= 0x30 && point <= 0x7e) this.escapeState = 'text';
    } else if (char === '\x9b') {
      this.escapeState = 'csi';
    } else if ('\x90\x98\x9d\x9e\x9f'.includes(char)) {
      this.escapeState = 'string';
    } else if (this.escapeState === 'csi' && point >= 0x40 && point <= 0x7e) {
      this.escapeState = 'text';
    }
  }
}
