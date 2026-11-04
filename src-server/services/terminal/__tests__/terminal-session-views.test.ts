/**
 * #3994 what each authority level reads about a terminal. Observe authority
 * reads status and output; the launch directory and process id are host
 * details for operate authority; the journal's storage location never
 * leaves the service. A scripted PTY, so this runs on every platform.
 */
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalScopeAllows } from '@kontourai/station-contracts/terminal-transport';
import { afterEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { IPtyProcess } from '../../../domain/pty-adapter.js';
import type { ShellHost } from '../shell-host.js';
import { TerminalSessions } from '../terminal-sessions.js';

const temp = trackTempDirs();
const scope = { projectId: 'alpha', bindingKey: 'project' };

class QuietPty implements IPtyProcess {
  pid = 4242;
  private exits = new Set<
    (event: { exitCode: number; signal: number | null }) => void
  >();
  constructor(readonly cwd: string) {}
  getCwd = async () => this.cwd;
  write() {}
  resize() {}
  kill() {
    for (const exit of this.exits) exit({ exitCode: 0, signal: null });
  }
  onData() {
    return () => {};
  }
  onExit(cb: (event: { exitCode: number; signal: number | null }) => void) {
    this.exits.add(cb);
    return () => this.exits.delete(cb);
  }
}

describe('terminal session views by authority', () => {
  let sessions: TerminalSessions<string> | undefined;
  afterEach(async () => {
    await sessions?.dispose();
    sessions = undefined;
  });

  async function start() {
    const home = temp('terminal-session-views-');
    const project = join(home, 'project');
    // A custom history location, so records carry a journal root.
    const journals = join(home, 'custom-journals');
    await mkdir(project);
    // The confined launch directory is a real path (/var is /private/var on macOS).
    const root = await realpath(project);
    const host: ShellHost = {
      spawn: async (input) => new QuietPty(input.cwd),
    };
    const grants = new Map([
      ['operator', 'terminal:operate'],
      ['watcher', 'terminal:observe'],
    ]);
    sessions = new TerminalSessions<string>(
      home,
      host,
      {
        authorize: (principal, _target, operation) =>
          terminalScopeAllows(grants.get(principal) ?? '', operation),
        resolveRoot: async () => root,
      },
      {},
      {},
      async () => ({
        persist: true,
        directory: journals,
        maxAgeMs: Number.POSITIVE_INFINITY,
        maxTerminalBytes: 16 * 1024 * 1024,
        maxTotalBytes: 1024 * 1024 * 1024,
      }),
    );
    const opened = await sessions.open('operator', scope, {
      cols: 80,
      rows: 24,
    });
    return { sessions, opened, root, journals };
  }

  /** Every string anywhere in a value, for a leak check that ignores shape. */
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object')
      return Object.values(value).flatMap(strings);
    return [];
  }

  it('gives an observer no launch directory, process id or journal location', async () => {
    const { sessions, opened, root, journals } = await start();
    const leaks = (value: unknown) =>
      strings(value).filter(
        (text) => text.includes(root) || text.includes(journals),
      );

    const listed = await sessions.list('watcher', scope);
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('cwd');
    expect(listed[0]).not.toHaveProperty('journalRoot');
    expect(leaks(listed)).toEqual([]);

    const read = await sessions.read('watcher', scope, opened.terminalId);
    expect(read).not.toHaveProperty('cwd');
    expect(read).not.toHaveProperty('journalRoot');
    expect(read.pid).toBeNull();
    expect(leaks(read)).toEqual([]);

    const observable = await sessions.listObservable('watcher');
    expect(observable).toHaveLength(1);
    expect(observable[0]).not.toHaveProperty('cwd');
    expect(observable[0]?.pid).toBeNull();
    expect(leaks(observable)).toEqual([]);

    // The observer still sees what it is allowed to: the terminal itself.
    expect(read.terminalId).toBe(opened.terminalId);
    expect(read.status).toBe('running');
  });

  it('gives an operator the launch directory and process id, never the journal location', async () => {
    const { sessions, opened, root, journals } = await start();
    expect(opened.cwd).toBe(root);
    const listed = await sessions.list('operator', scope);
    expect(listed[0]?.cwd).toBe(root);
    const read = await sessions.read('operator', scope, opened.terminalId);
    expect(read.cwd).toBe(root);
    expect(read.pid).toBe(4242);
    const observable = await sessions.listObservable('operator');
    expect(observable[0]?.pid).toBe(4242);
    for (const value of [opened, listed, read, observable]) {
      expect(strings(value).filter((text) => text.includes(journals))).toEqual(
        [],
      );
    }
  });
});
