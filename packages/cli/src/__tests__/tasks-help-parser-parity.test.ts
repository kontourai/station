import { join } from 'node:path';
import {
  encodeTaskToolResultReference,
  encodeTaskTurnReference,
  encodeTaskUserInputReference,
  type RelationGraphLink,
  type TaskOutputRecord,
} from '@kontourai/station-contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { commandHelpText } from '../help.js';

/**
 * `station tasks --help` and the tasks parser must agree. Help once showed
 * `--format summary|json` (the parser only reads `--flag=value`), marked the
 * required output id of `get-output` optional, and omitted the `--media` flag
 * `keep-output` reads. Each advertised usage line is run here as written,
 * through the real parser and handler, against a fetch stub that answers each
 * route with the shape the real route sends. The handler must finish: a stub
 * the SDK client rejects would end every action in a thrown validation error
 * and prove nothing about the form.
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

const ISO = '2026-01-01T00:00:00.000Z';

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function refusal(status: number, error: string): Response {
  return new Response(JSON.stringify({ success: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * The record the output routes send: values nest under `source` and
 * `materialization`. Typed against the contract so a field the contract
 * adds, renames or drops fails typecheck here instead of drifting.
 */
const OUTPUT: TaskOutputRecord = {
  schemaVersion: 1,
  id: 'output-1',
  taskId: 'task-1',
  projectId: 'project-1',
  title: 'Report',
  source: { kind: 'workspace-file', relativePath: 'dist/report.json' },
  materialization: {
    kind: 'snapshot',
    fileName: 'report.json',
    mediaType: 'application/json',
    byteLength: 2,
    digest: `sha256:${'0'.repeat(64)}`,
    contentAvailable: true,
  },
  createdAt: ISO,
};

/**
 * The link `POST /references` stores for each attach kind: the entity type
 * uses underscores (`user_input`, `tool_result`) while the request `kind`
 * uses hyphens, and the target id is the contract's canonical encoding.
 */
function referenceLink(kind: string | undefined): RelationGraphLink {
  const base = {
    id: 'link-1',
    sourceType: 'task',
    sourceId: 'task-1',
    confidence: 1,
    createdAt: ISO,
    source: 'user',
  } as const;
  if (kind === 'turn')
    return {
      ...base,
      targetType: 'turn',
      targetId: encodeTaskTurnReference('session-1', 'turn-1'),
      relationType: 'references_turn',
    };
  if (kind === 'tool-result')
    return {
      ...base,
      targetType: 'tool_result',
      targetId: encodeTaskToolResultReference('session-1', 'event-1'),
      relationType: 'references_tool_result',
    };
  if (kind === 'user-input')
    return {
      ...base,
      targetType: 'user_input',
      targetId: encodeTaskUserInputReference('session-1', 'event-1'),
      relationType: 'references_user_input',
    };
  throw new Error(`no reference fixture for kind ${kind}`);
}

/**
 * The valid answer for each route the tasks actions call. A route with no
 * fixture answers 404, so an action whose request is not covered here fails
 * instead of passing on a placeholder.
 */
function answerFor(method: string, path: string, body: unknown): Response {
  const route = path.replace(/^\/api\/tasks\/[^/]+/, '');
  if (method === 'GET' && route === '/basis')
    return envelope({
      version: 'station.task-basis-collection/v4',
      taskId: 'task-1',
      answers: [],
      unassociated: [],
      keptToolResults: [],
      keptGateEvaluations: [],
      gaps: [],
    });
  if (
    method === 'GET' &&
    [
      '/turn-references',
      '/user-input-references',
      '/tool-result-references',
    ].includes(route)
  )
    return envelope([]);
  if (method === 'GET' && /\/support\/bundles$/.test(route))
    return envelope([{ id: 'bundle-1' }]);
  if (method === 'GET' && /\/support\/bundles\/[^/]+\/claims$/.test(route))
    return envelope([{ id: 'claim-1' }]);
  if (/^\/turn-references\/[^/]+\/support$/.test(route)) {
    if (method === 'DELETE') return envelope(undefined);
    if (method === 'POST' || method === 'PUT')
      return envelope({
        schemaVersion: 1,
        kind: 'answer-support',
        id: 'association-1',
        taskId: 'task-1',
        answerReferenceId: 'reference-1',
        revision: 1,
        createdAt: ISO,
        updatedAt: ISO,
      });
  }
  if (method === 'POST' && route === '/references') {
    const kind = (body as { kind?: string } | undefined)?.kind;
    return envelope(referenceLink(kind));
  }
  if (route === '/outputs') {
    if (method === 'GET') return envelope([OUTPUT]);
    if (method === 'POST') return envelope(OUTPUT, 201);
  }
  if (/^\/outputs\/[^/]+\/content$/.test(route) && method === 'GET')
    return new Response(new Uint8Array([123, 125]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  if (/^\/outputs\/[^/]+$/.test(route)) {
    if (method === 'GET') return envelope(OUTPUT);
    if (method === 'DELETE') return envelope({ deleted: true });
  }
  return refusal(404, `no fixture for ${method} ${path}`);
}

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
  const fetchMock = vi.fn<typeof fetch>();
  const makeTempDir = trackTempDirs();
  let outDir: string;

  beforeEach(() => {
    outDir = makeTempDir('station-tasks-help-');
    fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body =
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      return answerFor(init?.method ?? 'GET', url.pathname, body);
    });
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
    'the advertised form completes and reads only advertised flags: %s',
    async (line) => {
      const { runCoreCommand } = await import('../commands/core.js');
      const { action, args, advertisedFlags } = invocationFor(line, outDir);
      flagReads.clear();
      // The handler must finish against valid answers: a usage refusal throws
      // before any request, and an invalid answer throws from the client.
      await expect(
        runCoreCommand('tasks', args),
        `${args.join(' ')} did not complete`,
      ).resolves.toBeUndefined();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      const unadvertised = [...flagReads].filter(
        (flag) => !advertisedFlags.has(flag) && !GLOBAL_FLAGS.includes(flag),
      );
      expect(unadvertised, `${action} reads flags its help omits`).toEqual([]);
    },
  );
});
