import { appendFile, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v3';
import { TerminalOutputSanitizer } from './terminal-output-sanitizer.js';

const recordSchema = z
  .object({ seq: z.number().int().positive().safe(), data: z.string() })
  .strict();
type JournalRecord = z.infer<typeof recordSchema>;
type Segment = {
  name: string;
  bytes: number;
  lines: number;
  first: number;
  last: number;
};

export interface TerminalJournalOptions {
  persist: boolean;
  maxBytes: number;
  maxLines: number;
  tailBytes: number;
  tailLines: number;
  segmentBytes: number;
  maxPendingBytes: number;
}

const defaults: TerminalJournalOptions = {
  persist: true,
  maxBytes: 16 * 1024 * 1024,
  maxLines: 5000,
  tailBytes: 2 * 1024 * 1024,
  tailLines: 5000,
  segmentBytes: 64 * 1024,
  maxPendingBytes: 1024 * 1024,
};

function lineBreaks(data: string): number {
  return data.match(/\n/g)?.length ?? 0;
}

/** Output is sanitized before sequencing; disk segments are never rewritten. */
export class TerminalJournal {
  private readonly options: TerminalJournalOptions;
  private readonly sanitizer = new TerminalOutputSanitizer();
  private tail: JournalRecord[] = [];
  private tailBytes = 0;
  private tailLines = 0;
  private segments: Segment[] = [];
  private nextSeq = 1;
  private queue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private pendingAppends: {
    data: string;
    bytes: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private appendScheduled = false;
  private failure: unknown;
  private sealed = false;

  constructor(
    private readonly directory: string,
    options: Partial<TerminalJournalOptions> = {},
  ) {
    this.options = { ...defaults, ...options };
    for (const key of [
      'maxBytes',
      'tailBytes',
      'segmentBytes',
      'maxPendingBytes',
    ] as const) {
      if (
        !Number.isSafeInteger(this.options[key]) ||
        this.options[key] < 1024 ||
        this.options[key] > 1024 ** 3
      )
        throw new Error(`Invalid terminal journal ${key}`);
    }
    for (const key of ['maxLines', 'tailLines'] as const) {
      if (
        !Number.isSafeInteger(this.options[key]) ||
        this.options[key] < 2 ||
        this.options[key] > 1_000_000
      )
        throw new Error(`Invalid terminal journal ${key}`);
    }
  }

  async load(): Promise<void> {
    if (!this.options.persist) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory))
      .filter((name) => /^\d{16}\.jsonl$/.test(name))
      .sort();
    let previous = 0;
    for (const name of names) {
      const text = await readFile(join(this.directory, name), 'utf8');
      // An interrupted append is unavailable, never silently presented as a
      // complete durable stream. The operator can retain it for diagnosis.
      if (!text.endsWith('\n'))
        throw new Error('Incomplete terminal journal segment');
      const records = this.decode(text);
      if (!records.length) throw new Error('Empty terminal journal segment');
      let count = 0;
      for (const record of records) {
        if (previous && record.seq !== previous + 1)
          throw new Error('Terminal journal sequence gap');
        previous = record.seq;
        count += lineBreaks(record.data);
        this.remember(record);
      }
      this.segments.push({
        name,
        bytes: Buffer.byteLength(text),
        lines: count,
        first: records[0]!.seq,
        last: previous,
      });
    }
    this.nextSeq = previous + 1;
    await this.compact();
  }

  append(data: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    const bytes = Buffer.byteLength(data);
    if (this.queuedBytes + bytes > this.options.maxPendingBytes) {
      this.failure = new Error('Terminal journal writer overloaded');
      return Promise.reject(this.failure);
    }
    this.queuedBytes += bytes;
    const task = new Promise<void>((resolve, reject) => {
      this.pendingAppends.push({ data, bytes, resolve, reject });
    });
    if (!this.appendScheduled) this.scheduleAppends();
    return task;
  }

  private scheduleAppends(): void {
    const batch = this.pendingAppends;
    this.appendScheduled = true;
    this.queue = this.queue.then(async () => {
      if (this.pendingAppends === batch) {
        this.pendingAppends = [];
        this.appendScheduled = false;
      }
      let failed = false;
      try {
        if (this.failure) throw this.failure;
        const sanitized = this.sanitizer.append(
          batch.map((item) => item.data).join(''),
        );
        await this.appendRecords(this.chunks(sanitized));
        if (this.failure) throw this.failure;
      } catch (error) {
        failed = true;
        this.failure = error;
      }
      this.queuedBytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
      for (const item of batch) {
        if (failed) item.reject(this.failure);
        else item.resolve();
      }
    });
  }

  get backpressured(): boolean {
    return this.queuedBytes >= this.options.maxPendingBytes / 2;
  }
  get drained(): boolean {
    return this.queuedBytes <= this.options.maxPendingBytes / 4;
  }

  read(fromSeq = 0) {
    // Seal the queued batch so later appends cannot jump this read barrier.
    if (this.appendScheduled) {
      this.pendingAppends = [];
      this.appendScheduled = false;
    }
    const task = this.queue.then(() => this.readSnapshot(fromSeq));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async readSnapshot(fromSeq: number) {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0)
      throw new Error('Invalid terminal journal sequence');
    if (this.failure) throw this.failure;
    const firstSeq = this.options.persist
      ? (this.segments[0]?.first ?? this.nextSeq)
      : (this.tail[0]?.seq ?? this.nextSeq);
    const lastSeq = this.nextSeq - 1;
    if (fromSeq > lastSeq)
      throw new Error('Terminal journal sequence is in the future');
    const reset = fromSeq < firstSeq - 1;
    const start = reset ? 0 : fromSeq;
    let records: JournalRecord[];
    if (
      !this.options.persist ||
      start >= (this.tail[0]?.seq ?? this.nextSeq) - 1
    ) {
      records = this.tail.filter((record) => record.seq > start);
    } else {
      records = [];
      for (const segment of this.segments) {
        if (segment.last <= start) continue;
        records.push(
          ...this.decode(
            await readFile(join(this.directory, segment.name), 'utf8'),
          ).filter((record) => record.seq > start),
        );
      }
    }
    return { firstSeq, lastSeq, reset, records };
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }

  seal(): void {
    this.sealed = true;
  }

  private *chunks(data: string): Generator<string> {
    const limit = Math.min(
      2048,
      Math.floor(this.options.tailBytes / 8),
      Math.floor(this.options.maxBytes / 8),
      Math.floor(this.options.segmentBytes / 8),
    );
    const lineLimit = Math.min(this.options.maxLines, this.options.tailLines);
    let text = '';
    let bytes = 0;
    let newlines = 0;
    for (const char of data) {
      const size = Buffer.byteLength(char);
      if (
        bytes + size > limit ||
        newlines + (char === '\n' ? 1 : 0) >= lineLimit
      ) {
        if (text) yield text;
        text = '';
        bytes = 0;
        newlines = 0;
      }
      text += char;
      bytes += size;
      if (char === '\n') newlines++;
    }
    if (text) yield text;
  }

  private async appendRecords(chunks: Iterable<string>): Promise<void> {
    if (this.failure) throw this.failure;
    let segment = this.segments.at(-1);
    let records: JournalRecord[] = [];
    let encoded = '';
    let bytes = 0;
    let lines = 0;
    const flush = async () => {
      if (!records.length) return;
      if (this.options.persist) {
        await appendFile(join(this.directory, segment!.name), encoded, {
          mode: 0o600,
        });
        segment!.bytes += bytes;
        segment!.lines += lines;
        segment!.last = records.at(-1)!.seq;
      }
      for (const record of records) {
        this.nextSeq++;
        this.remember(record);
      }
      records = [];
      encoded = '';
      bytes = 0;
      lines = 0;
      await this.compact();
    };
    for (const data of chunks) {
      const record = { seq: this.nextSeq + records.length, data };
      const text = `${JSON.stringify(record)}\n`;
      const size = Buffer.byteLength(text);
      const newlines = lineBreaks(data);
      if (
        this.options.persist &&
        (this.sealed ||
          !segment ||
          segment.bytes + bytes + size >
            Math.min(this.options.segmentBytes, this.options.maxBytes) ||
          segment.lines + lines + newlines + 1 > this.options.maxLines)
      ) {
        await flush();
        segment = {
          name: `${String(record.seq).padStart(16, '0')}.jsonl`,
          bytes: 0,
          lines: 0,
          first: record.seq,
          last: record.seq,
        };
        this.segments.push(segment);
        this.sealed = false;
      }
      records.push(record);
      encoded += text;
      bytes += size;
      lines += newlines;
    }
    await flush();
  }

  private remember(record: JournalRecord): void {
    this.tail.push(record);
    this.tailBytes += Buffer.byteLength(record.data);
    this.tailLines += lineBreaks(record.data);
    while (
      this.tailBytes > this.options.tailBytes ||
      this.tailLines + (this.tail.at(-1)?.data.endsWith('\n') ? 0 : 1) >
        this.options.tailLines
    ) {
      const first = this.tail.shift()!;
      this.tailBytes -= Buffer.byteLength(first.data);
      this.tailLines -= lineBreaks(first.data);
    }
  }

  private async compact(): Promise<void> {
    let bytes = this.segments.reduce((sum, segment) => sum + segment.bytes, 0);
    let count = this.segments.reduce((sum, segment) => sum + segment.lines, 0);
    while (
      this.segments.length > 1 &&
      (bytes > this.options.maxBytes || count + 1 > this.options.maxLines)
    ) {
      const first = this.segments[0]!;
      await unlink(join(this.directory, first.name));
      this.segments.shift();
      bytes -= first.bytes;
      count -= first.lines;
    }
    const firstSeq = this.segments[0]?.first;
    while (
      firstSeq !== undefined &&
      this.tail[0] &&
      this.tail[0].seq < firstSeq
    ) {
      const first = this.tail.shift()!;
      this.tailBytes -= Buffer.byteLength(first.data);
      this.tailLines -= lineBreaks(first.data);
    }
  }

  private decode(text: string): JournalRecord[] {
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => recordSchema.parse(JSON.parse(line)));
  }
}
