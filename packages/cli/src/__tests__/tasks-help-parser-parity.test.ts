import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { commandHelpText } from '../help.js';

/**
 * `station tasks --help` and the tasks parser must agree. Help once showed
 * `--format summary|json` (the parser only reads `--flag=value`), marked the
 * required output id of `get-output` optional, and omitted the `--media` flag
 * `keep-output` reads. Each advertised usage line is run here as written,
 * through the real parser and handler.
 */

/** Every flag key a tasks handler reads, recorded through the parsed args. */
const flagReads = new Set<string>();

vi.mock('../commands/core-api.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../commands/core-api.js')>();
  return {
    ...actual,
    parseCoreArgs: (args: string[]) => {
      const parsed = actual.parseCoreArgs(args);
      const flags = new Proxy(parsed.flags, {
        get(target, key, receiver) {
          if (typeof key === 'string') flagReads.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
      return { ...parsed, flags };
    },
  };
});

/** Flags every command reads for transport and credentials, not per action. */
const GLOBAL_FLAGS = ['api-base', 'station', 'credential', 'verbose'];

const SAMPLE_VALUES: Record<string, string> = {
  taskId: 'task-1',
  outputId: 'output-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  eventId: 'event-1',
  referenceId: 'reference-1',
  bundleId: 'bundle-1',
  claimId: 'claim-1',
  revision: '1',
  relativePath: 'dist/report.json',
  title: 'Report',
  operationId: 'operation-1',
  mediaType: 'application/json',
};

interface Invocation {
  action: string;
  args: string[];
  advertisedFlags: Set<string>;
}

/** Turn one advertised usage line into the argv a reader would type. */
function invocationFor(line: string, outDir: string): Invocation {
  const [, action, rest] = /^station tasks ([a-z-]+)(.*)$/.exec(line.trim())!;
  const args = [action];
  const advertisedFlags = new Set<string>();
  const sample = (placeholder: string) =>
    placeholder === 'absolute destination'
      ? join(outDir, 'downloaded')
      : (SAMPLE_VALUES[placeholder] ?? `${placeholder}-value`);
  for (const match of rest.matchAll(
    /\[([^\]]+)\]|<([^>]+)>|(--[a-z-]+=<[^>]+>|\S+)/g,
  )) {
    const [, optional, required, bare] = match;
    if (required) {
      args.push(sample(required));
      continue;
    }
    // An optional positional is omitted: the advertised form must work
    // without it.
    const token = optional ?? bare;
    if (!token.startsWith('--')) {
      if (bare) args.push(bare);
      continue;
    }
    const flag = /^--([a-z-]+)(?:=(?:<([^>]+)>|([^\s]+)))?$/.exec(token);
    if (!flag) {
      // A flag followed by a separate value word, e.g. `--format json`:
      // pass exactly what a reader would type.
      args.push(...token.split(/\s+/).map((part) => part.split('|')[0]));
      advertisedFlags.add(token.slice(2).split(/\s/)[0]);
      continue;
    }
    const [, name, placeholder, choices] = flag;
    advertisedFlags.add(name);
    if (placeholder !== undefined)
      args.push(`--${name}=${sample(placeholder)}`);
    else if (choices !== undefined)
      args.push(`--${name}=${choices.split('|')[0]}`);
    else args.push(`--${name}`);
  }
  return { action, args, advertisedFlags };
}

/** One line per action; a shared line such as `a|b <taskId>` covers each. */
function tasksUsageLines(): string[] {
  const text = commandHelpText('tasks') ?? '';
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      // The generic CRUD line advertises shared `[options]`, not a fixed form.
      .filter((line) => !line.startsWith('station tasks list|get|create'))
      .flatMap((line) => {
        const match = /^station tasks ([a-z|-]+)( .*)$/.exec(line);
        if (!match) return [];
        return match[1]
          .split('|')
          .map((action) => `station tasks ${action}${match[2]}`);
      })
  );
}

describe('tasks help agrees with the tasks parser', () => {
  const makeTempDir = trackTempDirs();
  const fetchMock = vi.fn<typeof fetch>();
  let outDir: string;

  beforeEach(() => {
    outDir = makeTempDir('station-tasks-help-');
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ success: true, data: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fetchMock.mockReset();
  });

  test('finds the usage lines it checks', () => {
    const actions = tasksUsageLines().map((line) => line.split(' ')[2]);
    // A broken extraction must not pass by checking nothing.
    expect(actions).toEqual(
      expect.arrayContaining(['basis', 'get-output', 'keep-output']),
    );
    expect(actions.length).toBeGreaterThanOrEqual(18);
  });

  test.each(tasksUsageLines())(
    'the advertised form parses and reads only advertised flags: %s',
    async (line) => {
      const { runCoreCommand } = await import('../commands/core.js');
      const { action, args, advertisedFlags } = invocationFor(line, outDir);
      flagReads.clear();
      let failure: unknown;
      try {
        await runCoreCommand('tasks', args);
      } catch (error) {
        failure = error;
      }
      // Reaching the network means the parser accepted every advertised
      // positional and flag; a usage refusal throws before any request.
      expect(
        fetchMock.mock.calls.length,
        `${args.join(' ')} was refused before any request: ${String(failure)}`,
      ).toBeGreaterThan(0);
      const unadvertised = [...flagReads].filter(
        (flag) => !advertisedFlags.has(flag) && !GLOBAL_FLAGS.includes(flag),
      );
      expect(unadvertised, `${action} reads flags its help omits`).toEqual([]);
    },
  );
});
