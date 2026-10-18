/**
 * Newline-delimited JSON framing with a hard line bound. A line longer than
 * the bound is refused by name, never truncated or buffered without limit.
 */
export class LineTooLongError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`line exceeds ${limit} bytes`);
    this.limit = limit;
  }
}

export class NdjsonDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  private readonly maxLineBytes: number;

  constructor(maxLineBytes: number) {
    this.maxLineBytes = maxLineBytes;
  }

  /** Returns the complete lines in `chunk`; throws LineTooLongError past the bound. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const piece = chunk.subarray(start, newline);
      if (this.pendingBytes + piece.length > this.maxLineBytes) {
        throw new LineTooLongError(this.maxLineBytes);
      }
      this.pending.push(piece);
      lines.push(Buffer.concat(this.pending).toString('utf8'));
      this.pending = [];
      this.pendingBytes = 0;
      start = newline + 1;
    }
    const rest = chunk.subarray(start);
    if (this.pendingBytes + rest.length > this.maxLineBytes) {
      throw new LineTooLongError(this.maxLineBytes);
    }
    if (rest.length > 0) {
      // Copy: the caller's chunk buffer may be reused.
      this.pending.push(Buffer.from(rest));
      this.pendingBytes += rest.length;
    }
    return lines;
  }
}

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
