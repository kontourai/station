import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const warnings = vi.hoisted(
  () => [] as Array<{ message: string; context?: unknown }>,
);

vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../utils/logger.js')>();
  return {
    ...actual,
    createLogger: (
      options: Parameters<typeof actual.createLogger>[0],
    ): ReturnType<typeof actual.createLogger> => {
      const real = actual.createLogger(options);
      if (options.name !== 'claude-transcript-session-source') return real;
      return {
        ...real,
        warn: (message: string, context?: unknown) => {
          warnings.push({ message, context });
        },
      };
    },
  };
});

import { ClaudeTranscriptSessionSource } from '../claude-transcript-session-source.js';

/*
 * Fixture records follow the key order and value types Claude Code 2.1.325
 * writes to `~/.claude/projects/<project>/<session>.jsonl`, read structurally
 * from real transcripts. Every value here is synthetic.
 */
const SESSION = '0f9d4c1e-5b7a-4d2e-9c3f-1a2b3c4d5e6f';
const CWD = '/workspace/example-project';
const ENQUEUED_AT = '2026-11-01T10:00:00.000Z';
const DEQUEUED_AT = '2026-11-01T10:00:00.050Z';
const USER_AT = '2026-11-01T10:00:00.120Z';

const aiTitle = (sessionId = SESSION) => ({
  type: 'ai-title',
  aiTitle: 'Synthetic title',
  sessionId,
});
const customTitle = (sessionId = SESSION) => ({
  type: 'custom-title',
  customTitle: 'Synthetic custom title',
  sessionId,
});
const sessionOwner = (sessionId = SESSION) => ({
  type: 'session-owner',
  accountUuid: '11111111-1111-4111-8111-111111111111',
  organizationUuid: '22222222-2222-4222-8222-222222222222',
  sessionId,
});
const enqueue = (sessionId = SESSION, timestamp = ENQUEUED_AT) => ({
  type: 'queue-operation',
  operation: 'enqueue',
  timestamp,
  sessionId,
  content: 'Synthetic prompt',
});
const dequeue = (sessionId = SESSION, timestamp = DEQUEUED_AT) => ({
  type: 'queue-operation',
  operation: 'dequeue',
  timestamp,
  sessionId,
});
const user = (
  options: {
    sessionId?: string;
    content?: unknown;
    timestamp?: string;
    uuid?: string;
  } = {},
) => ({
  parentUuid: null,
  isSidechain: false,
  promptId: '33333333-3333-4333-8333-333333333333',
  type: 'user',
  message: { role: 'user', content: options.content ?? 'Synthetic prompt' },
  uuid: options.uuid ?? '44444444-4444-4444-8444-444444444444',
  timestamp: options.timestamp ?? USER_AT,
  permissionMode: 'default',
  promptSource: 'sdk',
  turnOrigin: 'human',
  turnPosition: { promptIndex: 0, turnIndex: 0 },
  turnAttributionKey: 'synthetic-attribution-key',
  userType: 'external',
  entrypoint: 'sdk-ts',
  cwd: CWD,
  sessionId: options.sessionId ?? SESSION,
  version: '2.1.325',
  gitBranch: 'main',
});
const attachment = (sessionId = SESSION) => ({
  parentUuid: '44444444-4444-4444-8444-444444444444',
  isSidechain: false,
  attachment: {
    type: 'environment',
    snapshot: {
      workingDirectory: CWD,
      isWorktree: false,
      isGitRepo: true,
      additionalWorkingDirectories: [],
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Synthetic OS',
    },
  },
  type: 'attachment',
  uuid: '55555555-5555-4555-8555-555555555555',
  timestamp: '2026-11-01T10:00:00.130Z',
  rendered: [{ content: 'Synthetic environment' }],
  renderedRole: 'system',
  userType: 'external',
  entrypoint: 'sdk-ts',
  cwd: CWD,
  sessionId,
  version: '2.1.325',
  gitBranch: 'main',
});
/** `<session>/subagents/agent-<id>.jsonl`: repeats the parent's sessionId. */
const subagentUser = (sessionId = SESSION) => ({
  parentUuid: null,
  isSidechain: true,
  promptId: '66666666-6666-4666-8666-666666666666',
  agentId: 'a0123456789abcdef',
  type: 'user',
  message: { role: 'user', content: 'Synthetic subagent prompt' },
  uuid: '77777777-7777-4777-8777-777777777777',
  timestamp: '2026-11-01T10:05:00.000Z',
  userType: 'external',
  entrypoint: 'sdk-ts',
  cwd: CWD,
  sessionId,
  version: '2.1.325',
  gitBranch: 'main',
});

const dirs: string[] = [];

function configHome(): { root: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), 'station-claude-discovery-'));
  dirs.push(root);
  const project = join(root, 'projects', '-workspace-example-project');
  mkdirSync(project, { recursive: true });
  return { root, project };
}

function jsonl(records: unknown[]): string {
  return records.map((record) => `${JSON.stringify(record)}\n`).join('');
}

beforeEach(() => {
  warnings.length = 0;
});

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Claude transcript discovery of Claude Code 2.1 transcripts', () => {
  test.each([
    ['ai-title first', [aiTitle(), enqueue(), dequeue(), user()]],
    [
      'custom title and session owner first',
      [customTitle(), sessionOwner(), enqueue(), dequeue(), user()],
    ],
    ['queue records first', [enqueue(), dequeue(), user()]],
    [
      'a repeated ai-title before the queue',
      [aiTitle(), aiTitle(), enqueue(), dequeue(), user()],
    ],
    ['identity on the attachment record', [enqueue(), dequeue(), attachment()]],
  ])(
    'finds the session behind leading metadata records (%s)',
    async (_label, records) => {
      const { root, project } = configHome();
      writeFileSync(join(project, `${SESSION}.jsonl`), jsonl(records));
      const source = new ClaudeTranscriptSessionSource({ configDir: root });

      const discovered = await source.discover();

      expect(discovered.outcome).toBe('ok');
      expect(discovered.sessions).toHaveLength(1);
      // The session began when its first prompt was queued, not at the later
      // record that first names its cwd.
      expect(discovered.sessions[0]).toMatchObject({
        provider: 'claude',
        sessionId: SESSION,
        cwd: CWD,
        createdAt: ENQUEUED_AT,
      });
      // The descriptor's handle reads the transcript it came from.
      const read = await source.read(discovered.sessions[0]);
      expect(read.outcome).toBe('ok');
      expect(warnings).toEqual([]);
    },
  );

  test('uses the earliest timestamp even when leading records are out of order', async () => {
    const { root, project } = configHome();
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([
        aiTitle(),
        enqueue(SESSION, '2026-11-01T10:00:02.000Z'),
        dequeue(SESSION, '2026-11-01T09:59:59.000Z'),
        user(),
      ]),
    );

    const [session] = (
      await new ClaudeTranscriptSessionSource({ configDir: root }).discover()
    ).sessions;

    expect(session?.createdAt).toBe('2026-11-01T09:59:59.000Z');
  });

  test('reads past an oversized pasted-image prompt to the attachment that names the cwd', async () => {
    const { root, project } = configHome();
    const image = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'A'.repeat(8 * 1024),
      },
    };
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([
        customTitle(),
        enqueue(),
        dequeue(),
        user({ content: [image, { type: 'text', text: 'Synthetic prompt' }] }),
        attachment(),
      ]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxLineBytes: 1024,
    }).discover();

    expect(discovered.outcome).toBe('ok');
    expect(discovered.sessions[0]).toMatchObject({
      sessionId: SESSION,
      cwd: CWD,
      createdAt: ENQUEUED_AT,
    });
  });

  test('refuses a transcript whose identity lies past the leading-record bound', async () => {
    const { root, project } = configHome();
    const atBound = '00000000-0000-4000-8000-00000000000a';
    const pastBound = '00000000-0000-4000-8000-00000000000b';
    // Four leading records: identity is the fourth in one, fifth in the other.
    writeFileSync(
      join(project, `${atBound}.jsonl`),
      jsonl([
        aiTitle(atBound),
        enqueue(atBound),
        dequeue(atBound),
        user({ sessionId: atBound }),
      ]),
    );
    writeFileSync(
      join(project, `${pastBound}.jsonl`),
      jsonl([
        aiTitle(pastBound),
        customTitle(pastBound),
        enqueue(pastBound),
        dequeue(pastBound),
        user({ sessionId: pastBound }),
      ]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxLeadingRecords: 4,
    }).discover();

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([
      atBound,
    ]);
    expect(discovered.outcome).toBe('malformed_record');
  });

  test('the default bound covers the latest identity position seen in real transcripts', async () => {
    const { root, project } = configHome();
    // Observed live: mode, permission-mode, session-owner, bridge-session and
    // a file-history-snapshot (no sessionId) before the first user record.
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([
        { type: 'mode', mode: 'normal', sessionId: SESSION },
        { type: 'permission-mode', permissionMode: 'auto', sessionId: SESSION },
        sessionOwner(),
        {
          type: 'bridge-session',
          sessionId: SESSION,
          bridgeSessionId: 'synthetic-bridge',
          lastSequenceNum: 0,
          ownerAccountUuid: '11111111-1111-4111-8111-111111111111',
          ownerOrganizationUuid: '22222222-2222-4222-8222-222222222222',
        },
        {
          type: 'file-history-snapshot',
          messageId: '44444444-4444-4444-8444-444444444444',
          snapshot: {},
          isSnapshotUpdate: false,
        },
        user(),
      ]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
    }).discover();

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([
      SESSION,
    ]);
  });

  test('refuses with line_limit when oversized records exhaust the head byte budget', async () => {
    const { root, project } = configHome();
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([
        enqueue(),
        dequeue(),
        user({ content: 'x'.repeat(6 * 1024) }),
        attachment(),
      ]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxLineBytes: 1024,
      maxLeadingBytes: 4 * 1024,
    }).discover();

    expect(discovered).toEqual({ outcome: 'line_limit', sessions: [] });
  });

  test('refuses leading records that disagree about the session', async () => {
    const { root, project } = configHome();
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([
        aiTitle(),
        enqueue('99999999-9999-4999-8999-999999999999'),
        dequeue(),
        user(),
      ]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
    }).discover();

    expect(discovered).toEqual({ outcome: 'malformed_record', sessions: [] });
  });

  test('never treats a subagent sidechain transcript as its parent session', async () => {
    const { root, project } = configHome();
    writeFileSync(
      join(project, `${SESSION}.jsonl`),
      jsonl([aiTitle(), enqueue(), dequeue(), user()]),
    );
    const artifacts = join(project, SESSION);
    mkdirSync(join(artifacts, 'subagents'), { recursive: true });
    mkdirSync(join(artifacts, 'tool-results'), { recursive: true });
    const sidechain = join(artifacts, 'subagents', 'agent-a0123456789abcdef');
    writeFileSync(`${sidechain}.jsonl`, jsonl([subagentUser()]));
    writeFileSync(`${sidechain}.meta.json`, '{}');
    writeFileSync(join(artifacts, 'tool-results', 'synthetic.txt'), 'output');
    // The sidechain is the most recently written file.
    utimesSync(join(project, `${SESSION}.jsonl`), 1, 1);

    const source = new ClaudeTranscriptSessionSource({ configDir: root });
    const discovered = await source.discover();

    expect(discovered.outcome).toBe('ok');
    expect(discovered.sessions).toHaveLength(1);
    const read = await source.read(discovered.sessions[0]);
    const prompts = read.events.flatMap((event) =>
      event.method === 'turn.started' ? [event.prompt] : [],
    );
    expect(prompts).toEqual(['Synthetic prompt']);
  });

  test('refuses a sidechain record found where a session transcript belongs', async () => {
    const { root, project } = configHome();
    writeFileSync(
      join(project, 'agent-a0123456789abcdef.jsonl'),
      jsonl([subagentUser()]),
    );

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
    }).discover();

    expect(discovered).toEqual({ outcome: 'rejected_candidate', sessions: [] });
  });

  test('visits the newest project folders first when the traversal bound is reached', async () => {
    const { root } = configHome();
    const projects = join(root, 'projects');
    const stale = join(projects, '-workspace-stale');
    mkdirSync(stale);
    for (let index = 0; index < 20; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      writeFileSync(
        join(stale, `${id}.jsonl`),
        jsonl([enqueue(id), dequeue(id), user({ sessionId: id })]),
      );
      utimesSync(join(stale, `${id}.jsonl`), 10, 10);
    }
    utimesSync(stale, 10, 10);
    const fresh = join(projects, '-workspace-fresh');
    mkdirSync(fresh);
    writeFileSync(
      join(fresh, `${SESSION}.jsonl`),
      jsonl([aiTitle(), enqueue(), dequeue(), user()]),
    );
    utimesSync(join(projects, '-workspace-example-project'), 5, 5);

    const discovered = await new ClaudeTranscriptSessionSource({
      configDir: root,
      maxTraversalEntries: 8,
    }).discover();

    expect(discovered.outcome).toBe('candidate_limit');
    expect(discovered.sessions.map((session) => session.sessionId)).toContain(
      SESSION,
    );
  });

  test('re-reads a refused head once the transcript grows its identity record', async () => {
    const { root, project } = configHome();
    const transcript = join(project, `${SESSION}.jsonl`);
    writeFileSync(transcript, jsonl([aiTitle(), enqueue()]));
    const source = new ClaudeTranscriptSessionSource({ configDir: root });

    expect((await source.discover()).sessions).toEqual([]);
    appendFileSync(transcript, jsonl([dequeue(), user()]));

    const discovered = await source.discover();
    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([
      SESSION,
    ]);
  });

  test('warns once per state when transcripts exist but none is accepted', async () => {
    const { root, project } = configHome();
    const transcript = join(project, `${SESSION}.jsonl`);
    writeFileSync(transcript, jsonl([aiTitle(), enqueue()]));
    const source = new ClaudeTranscriptSessionSource({ configDir: root });

    await source.discover();
    await source.discover();
    expect(warnings).toEqual([
      {
        message:
          'Claude transcript discovery found transcripts but accepted none of them',
        context: {
          outcome: 'malformed_record',
          candidates: 1,
          refusals: { malformed_record: 1 },
        },
      },
    ]);

    // A different refusal is a new state and is reported.
    rmSync(transcript);
    writeFileSync(
      join(project, 'agent-a0123456789abcdef.jsonl'),
      jsonl([subagentUser()]),
    );
    await source.discover();
    expect(warnings.map((warning) => warning.context)).toEqual([
      expect.objectContaining({ outcome: 'malformed_record' }),
      expect.objectContaining({ outcome: 'rejected_candidate' }),
    ]);

    // Accepting a session ends the state; the next all-refused poll warns again.
    writeFileSync(transcript, jsonl([aiTitle(), enqueue(), dequeue(), user()]));
    await source.discover();
    rmSync(transcript);
    await source.discover();
    expect(warnings).toHaveLength(3);
  });

  test('does not warn when there are no transcripts', async () => {
    const { root } = configHome();
    await new ClaudeTranscriptSessionSource({ configDir: root }).discover();
    expect(warnings).toEqual([]);
  });
});
