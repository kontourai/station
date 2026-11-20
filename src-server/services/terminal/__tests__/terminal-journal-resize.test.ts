import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import { TerminalJournal } from '../terminal-journal.js';
import { TerminalSessions } from '../terminal-sessions.js';

const temp = trackTempDirs();
const scope = { projectId: 'resize-project', bindingKey: 'project' };

class ScriptedShell implements IPtyProcess {
  pid = 4242;
  private readonly data = new Set<(data: string) => void>();
  private readonly exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  write(data: string) {
    for (const listener of this.data) listener(data);
  }
  resize() {}
  kill() {
    for (const listener of this.exits) listener({ exitCode: 0, signal: null });
  }
  onData(listener: (data: string) => void) {
    this.data.add(listener);
    return () => this.data.delete(listener);
  }
  onExit(
    listener: (event: { exitCode: number; signal: number | null }) => void,
  ) {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }
}

describe('bounded journal resize history', () => {
  let sessions: TerminalSessions<string> | undefined;
  afterEach(async () => {
    await sessions?.dispose();
    sessions = undefined;
  });

  it('bounds memory-only history through normal session resizes and keeps the final repaint size', async () => {
    const home = temp('terminal-resize-memory-');
    const project = join(home, 'project');
    await mkdir(project);
    const root = await realpath(project);
    sessions = new TerminalSessions<string>(
      home,
      { spawn: async () => new ScriptedShell() },
      { authorize: () => true, resolveRoot: async () => root },
      { persist: false, tailBytes: 1024 },
    );
    const opened = await sessions.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    for (let index = 0; index < 128; index++)
      await sessions.resize(
        'operator',
        scope,
        opened.terminalId,
        index % 2 ? 120 : 90,
        index % 2 ? 32 : 24,
      );
    const resized = await sessions.read('operator', scope, opened.terminalId);
    expect(resized.journal.reset).toBe(true);
    expect(resized.journal.firstSeq).toBeGreaterThan(1);
    expect(resized.journal.records.length).toBeLessThan(64);
    expect(resized.journal.lastSeq).toBe(opened.journal.lastSeq + 128);

    await sessions.write('operator', scope, opened.terminalId, 'final repaint');
    const replay = (await sessions.read('operator', scope, opened.terminalId))
      .journal.records;
    let grid: { cols: number; rows: number } | undefined;
    let output = '';
    for (const record of replay) {
      if (record.resize) grid = record.resize;
      else {
        expect(grid).toEqual({ cols: 120, rows: 32 });
        output += record.data;
      }
    }
    expect(output).toBe('final repaint');
  });

  it('pages resize-only reads within the requested budget without losing sequences', async () => {
    const journal = new TerminalJournal(
      join(temp('terminal-resize-read-'), 'journal'),
      { persist: false, tailBytes: 64 * 1024 },
    );
    for (let index = 0; index < 300; index++)
      await journal.resize(index % 2 ? 120 : 90, 30);
    let cursor = 0;
    const sequences: number[] = [];
    do {
      const page = await journal.read(cursor, 2048);
      expect(page.reset).toBe(false);
      expect(
        Buffer.byteLength(JSON.stringify(page.records)),
      ).toBeLessThanOrEqual(2050);
      expect(page.records.length).toBeGreaterThan(0);
      sequences.push(...page.records.map((record) => record.seq));
      cursor = page.records.at(-1)!.seq;
    } while (cursor < 300);
    expect(sequences).toEqual(
      Array.from({ length: 300 }, (_, index) => index + 1),
    );
    expect((await journal.read(cursor, 2048)).records).toEqual([]);
  });

  it('restates the effective size before retained text after its original resize is evicted', async () => {
    const journal = new TerminalJournal(
      join(temp('terminal-resize-base-'), 'journal'),
      { persist: false, tailBytes: 1024 },
    );
    await journal.resize(100, 30);
    for (let index = 0; index < 40; index++)
      await journal.append('x'.repeat(64));
    await journal.append('retained repaint');
    const snapshot = await journal.read();
    expect(snapshot.reset).toBe(true);
    expect(snapshot.firstSeq).toBeGreaterThan(1);
    let grid: { cols: number; rows: number } | undefined;
    let output = '';
    for (const record of snapshot.records) {
      if (record.resize) {
        expect(record.data).toBe('');
        grid = record.resize;
      } else {
        expect(grid).toEqual({ cols: 100, rows: 30 });
        output += record.data;
      }
    }
    expect(output.endsWith('retained repaint')).toBe(true);
    expect(snapshot.records.map((record) => record.seq)).toEqual(
      Array.from(
        { length: snapshot.lastSeq - snapshot.firstSeq + 1 },
        (_, index) => snapshot.firstSeq + index,
      ),
    );
  });

  it('refuses a resize burst that exceeds the pending writer budget', async () => {
    const journal = new TerminalJournal(
      join(temp('terminal-resize-queue-'), 'journal'),
      { persist: false, maxPendingBytes: 1024 },
    );
    await expect(
      Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          journal.resize(index % 2 ? 120 : 90, 30),
        ),
      ),
    ).rejects.toThrow('Terminal journal writer overloaded');
  });
});
