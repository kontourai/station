/**
 * #4003 `task_note` at the room seam: the real `ProjectTaskRoomRuntime`, the
 * real SQLite working-state worker and the real room execution binding table.
 * Every assertion reads the document back through the person's own
 * `runtime.document` path, i.e. the converged, persisted text.
 */
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { TextDocumentOperation } from '../../../domain/shared-working-state.js';
import {
  TASK_NOTE_MAX_TEXT_LENGTH,
  taskDocumentSeedText,
} from '../../../domain/task-memory.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { EventStore } from '../event-store.js';
import { ProjectTaskRoomRevisionEvidenceBridge } from '../project-task-room-revision-evidence-bridge.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();
const AT = new Date('2026-10-21T12:34:56.789Z');
const STAMP = '2026-10-21T12:34:56Z';
const LEAD = 'session-lead';
const HELPER = 'session-helper';

function baseTask(): TaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Room task',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'owner-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    agentId: 'agent-lead',
    sessionId: LEAD,
  } as TaskRecord;
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function setup(
  options: {
    /** Runs once, inside the first agent settle, before it reaches SQLite. */
    beforeFirstAgentSettle?: (runtime: ProjectTaskRoomRuntime) => Promise<void>;
  } = {},
) {
  const directory = makeTempDir('station-task-note-');
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  const security = new EnvironmentSecurityService({ homeDir: directory });
  await security.initialize();
  // The production revision-evidence bridge: without it every edit after the
  // first waits on an undrained revision publication.
  const revisionEvidence = new ProjectTaskRoomRevisionEvidenceBridge({
    eventStore: store,
    security,
  });
  const task = baseTask();
  const backing = store.createProjectTaskRoomWorkingState();
  const agentOperations: TextDocumentOperation[] = [];
  const personOperations: TextDocumentOperation[] = [];
  let intercepted = false;
  let runtime!: ProjectTaskRoomRuntime;
  runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    revisionEvidence,
    working: {
      ...backing,
      settle: async (input) => {
        if (input.actorKind !== 'agent')
          personOperations.push(...input.operations);
        if (input.actorKind === 'agent') {
          agentOperations.push(...input.operations);
          if (!intercepted && options.beforeFirstAgentSettle) {
            intercepted = true;
            await options.beforeFirstAgentSettle(runtime);
          }
        }
        return backing.settle(input);
      },
    },
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted' as const,
        operatorId: 'owner-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
    readExecutionBinding: (sessionId) =>
      store.readProjectTaskRoomExecutionBinding(sessionId),
    readAgentLifecycle: async ({ sessionId }) =>
      sessionId === LEAD || sessionId === HELPER
        ? { provider: 'claude' }
        : undefined,
    // HELPER is an independently requested agent of this Task incarnation.
    readAgentRequests: async () => [
      {
        sessionId: HELPER,
        agentId: 'agent-helper',
        ownerOperatorId: 'owner-1',
        taskCreatedAt: task.createdAt,
        createdAt: task.createdAt,
      },
    ],
  });
  closers.push(() => {
    store.close();
  });
  closers.push(async () => {
    await runtime.close();
  });
  const request = new Request('http://station');
  const bind = async (sessionId: string) =>
    expect(
      await store.bindProjectTaskRoomExecution({
        projectId: task.projectId,
        taskId: task.id,
        sessionId,
      }),
    ).toEqual({ kind: 'bound' });
  const text = async () => {
    const document = await runtime.document({ taskId: task.id, request });
    if (document.kind !== 'snapshot')
      throw new Error(`document was ${document.kind}`);
    return document.text as string;
  };
  /** A person's edit through the browser path: plan, then submit. */
  const personPlan = async (desiredText: string) => {
    const plan = await runtime.editPlan({
      taskId: task.id,
      request,
      intentId: crypto.randomUUID(),
      desiredText,
      selection: { anchor: 0, focus: 0 },
    });
    if (plan.kind !== 'planned') throw new Error(`plan was ${plan.kind}`);
    return () =>
      runtime.submitBatch({
        taskId: task.id,
        request,
        intentId: plan.intentId,
        intentDigest: plan.digest,
      });
  };
  const personEdit = async (desiredText: string) =>
    expect(await (await personPlan(desiredText))()).toMatchObject({
      kind: 'committed',
    });
  const note = (
    sessionId: string,
    section: 'decision' | 'done' | 'in_progress' | 'question',
    noteText: string,
  ) => runtime.appendTaskNote({ sessionId, section, text: noteText, at: AT });
  return {
    store,
    task,
    runtime,
    request,
    bind,
    text,
    note,
    personPlan,
    personEdit,
    agentOperations,
    personOperations,
  };
}

const line = (sessionId: string, text: string) =>
  `- [session ${sessionId}, ${STAMP}] ${text}`;

describe('task_note through the Task room', () => {
  test('a new Task is seeded with the brief and the four sections, and a note lands under its heading', async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    expect(
      await room.runtime.seedTaskDocument({
        taskId: room.task.id,
        request: room.request,
        brief: 'Ship the thing.',
      }),
    ).toBe(true);
    expect(await room.text()).toBe(
      'Ship the thing.\n\n## Decisions\n\n## Done\n\n## In progress\n\n## Open questions\n',
    );
    // A retried seed succeeds without replacing the existing document.
    expect(
      await room.runtime.seedTaskDocument({
        taskId: room.task.id,
        request: room.request,
        brief: 'Something else.',
      }),
    ).toBe(true);
    expect(await room.text()).toBe(
      'Ship the thing.\n\n## Decisions\n\n## Done\n\n## In progress\n\n## Open questions\n',
    );
    await room.bind(LEAD);
    const before = await room.runtime.document({
      taskId: room.task.id,
      request: room.request,
    });
    const recorded = await room.note(LEAD, 'decision', 'Use SQLite.');
    expect(recorded).toMatchObject({
      kind: 'recorded',
      taskId: room.task.id,
      section: 'decision',
      replaced: false,
      entry: line(LEAD, 'Use SQLite.'),
    });
    expect(recorded.kind === 'recorded' && recorded.revision).not.toBe(
      (before as { revision?: string }).revision,
    );
    expect(await room.text()).toBe(
      `Ship the thing.\n\n## Decisions\n\n${line(LEAD, 'Use SQLite.')}\n\n## Done\n\n## In progress\n\n## Open questions\n`,
    );
    // Agent-authored, attributed to the exact Session, and insert-only.
    expect(room.agentOperations.length).toBeGreaterThan(0);
    for (const operation of room.agentOperations) {
      expect(operation.kind).toBe('insert');
      expect(operation.actor.kind).toBe('agent');
      expect(operation.attribution?.agentSessionId).toBe(LEAD);
    }
    // Status is untouched: the note path has no Task-status effect at all.
    expect(room.task.status).toBe('in_progress');
  });

  test('notes in the middle of the document never delete or rewrite the text after them', async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    // Enough notes that a random operation identity would sort after the
    // existing branch at least once (each time, about one in two).
    const decisions: string[] = [];
    const done: string[] = [];
    for (let index = 0; index < 16; index += 1) {
      const section = index % 2 === 0 ? 'decision' : 'done';
      const outcome = await room.note(LEAD, section, `entry ${index}`);
      expect(outcome, JSON.stringify(outcome)).toMatchObject({
        kind: 'recorded',
      });
      (section === 'decision' ? decisions : done).push(
        line(LEAD, `entry ${index}`),
      );
    }
    const expected = `Brief.\n\n## Decisions\n\n${decisions.join('\n')}\n\n## Done\n\n${done.join('\n')}\n\n## In progress\n\n## Open questions\n`;
    expect(await room.text()).toBe(expected);
    expect(
      room.agentOperations.filter((operation) => operation.kind === 'delete'),
    ).toEqual([]);
  });

  test('a Task document without the headings gets them on the first note; existing text is kept', async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit('An older brief.\n## Done\n- by hand');
    await room.bind(LEAD);
    expect(await room.note(LEAD, 'question', 'Which region?')).toMatchObject({
      kind: 'recorded',
    });
    expect(await room.text()).toBe(
      `An older brief.\n## Done\n- by hand\n\n## Decisions\n\n## In progress\n\n## Open questions\n\n${line(LEAD, 'Which region?')}\n`,
    );
    // The existing Done section is used where the person put it.
    expect(await room.note(LEAD, 'done', 'Wrote the parser.')).toMatchObject({
      kind: 'recorded',
    });
    expect(await room.text()).toBe(
      `An older brief.\n## Done\n- by hand\n${line(LEAD, 'Wrote the parser.')}\n\n## Decisions\n\n## In progress\n\n## Open questions\n\n${line(LEAD, 'Which region?')}\n`,
    );
    expect(
      room.agentOperations.filter((operation) => operation.kind === 'delete'),
    ).toEqual([]);
  });

  test('an empty document gets the sections alone', async () => {
    const room = await setup();
    await room.bind(LEAD);
    expect(await room.note(LEAD, 'done', 'First.')).toMatchObject({
      kind: 'recorded',
    });
    expect(await room.text()).toBe(
      `## Decisions\n\n## Done\n\n${line(LEAD, 'First.')}\n\n## In progress\n\n## Open questions\n`,
    );
  });

  test("a Session without a Task binding, or no longer the Task's Session, is refused and writes nothing", async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    const before = await room.text();
    // The lead association alone is not authority: no binding, no note.
    expect(await room.note(LEAD, 'decision', 'x')).toEqual({ kind: 'no-task' });
    // A bound Session that is neither the lead nor a recorded request.
    await room.store.bindProjectTaskRoomExecution({
      projectId: room.task.projectId,
      taskId: room.task.id,
      sessionId: 'session-stranger',
    });
    expect(await room.note('session-stranger', 'decision', 'x')).toEqual({
      kind: 'no-task',
    });
    // The lead, once re-dispatched away from this Session.
    await room.bind(LEAD);
    room.task.sessionId = 'session-next';
    expect(await room.note(LEAD, 'decision', 'x')).toEqual({ kind: 'no-task' });
    expect(await room.text()).toBe(before);
    expect(room.agentOperations).toEqual([]);
  });

  test('text over the limit, empty or multi-line is refused, never cut', async () => {
    const room = await setup();
    await room.bind(LEAD);
    expect(TASK_NOTE_MAX_TEXT_LENGTH).toBe(2000);
    expect(await room.note(LEAD, 'done', 'x'.repeat(2001))).toEqual({
      kind: 'refused',
      refusal: { kind: 'too-long', limit: 2000, length: 2001 },
    });
    expect(await room.note(LEAD, 'done', '   ')).toEqual({
      kind: 'refused',
      refusal: { kind: 'empty' },
    });
    expect(await room.note(LEAD, 'done', 'one\ntwo')).toEqual({
      kind: 'refused',
      refusal: { kind: 'multiline' },
    });
    expect(room.agentOperations).toEqual([]);
    expect(await room.note(LEAD, 'done', 'y'.repeat(2000))).toMatchObject({
      kind: 'recorded',
    });
    expect(await room.text()).toContain(line(LEAD, 'y'.repeat(2000)));
  });

  test("an in-progress note replaces the Session's own line and never touches another Session's line", async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    await room.bind(HELPER);
    expect(await room.note(LEAD, 'in_progress', 'Reading code.')).toMatchObject(
      { kind: 'recorded', replaced: false },
    );
    expect(
      await room.note(HELPER, 'in_progress', 'Running tests.'),
    ).toMatchObject({ kind: 'recorded', replaced: false });
    const helperLine = line(HELPER, 'Running tests.');
    const deletesBefore = room.agentOperations.filter(
      (operation) => operation.kind === 'delete',
    ).length;
    expect(
      await room.note(LEAD, 'in_progress', 'Writing the fix.'),
    ).toMatchObject({ kind: 'recorded', replaced: true });
    const after = await room.text();
    const section = after.slice(after.indexOf('## In progress'));
    expect(section).toBe(
      `## In progress\n\n${line(LEAD, 'Writing the fix.')}\n${helperLine}\n\n## Open questions\n`,
    );
    // The replacement deleted at most the lead's own old line.
    const deleted = room.agentOperations
      .slice()
      .filter((operation) => operation.kind === 'delete')
      .slice(deletesBefore)
      .reduce(
        (count, operation) =>
          count + (operation.kind === 'delete' ? operation.target.length : 0),
        0,
      );
    expect(deleted).toBeLessThanOrEqual(
      [...line(LEAD, 'Reading code.')].length,
    );
    // The helper replacing its line leaves the lead's line exactly.
    expect(
      await room.note(HELPER, 'in_progress', 'Tests green.'),
    ).toMatchObject({ kind: 'recorded', replaced: true });
    const final = await room.text();
    expect(final.slice(final.indexOf('## In progress'))).toBe(
      `## In progress\n\n${line(LEAD, 'Writing the fix.')}\n${line(HELPER, 'Tests green.')}\n\n## Open questions\n`,
    );
  });

  test("a person's edit committed while the note is in flight is preserved", async () => {
    let personCommitted = false;
    const room = await setup({
      beforeFirstAgentSettle: async (runtime) => {
        // The note was planned on the old text. Before it reaches SQLite a
        // person makes two local edits, as an editor sends them: one in the
        // brief, one in the very section the note is going into.
        const personRequest = new Request('http://station');
        const edit = async (change: (text: string) => string) => {
          const current = await runtime.document({
            taskId: 'task-1',
            request: personRequest,
          });
          const plan = await runtime.editPlan({
            taskId: 'task-1',
            request: personRequest,
            intentId: crypto.randomUUID(),
            desiredText: change((current as { text: string }).text),
            selection: { anchor: 0, focus: 0 },
          });
          if (plan.kind !== 'planned') throw new Error('person plan failed');
          return runtime.submitBatch({
            taskId: 'task-1',
            request: personRequest,
            intentId: plan.intentId,
            intentDigest: plan.digest,
          });
        };
        const brief = await edit((text) =>
          text.replace('Brief.', 'Brief, edited by a person.'),
        );
        const result = await edit((text) =>
          text.replace(
            '## Decisions\n',
            '## Decisions\n\n- A person decided this.\n',
          ),
        );
        personCommitted =
          brief.kind === 'committed' && result.kind === 'committed';
      },
    });
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    expect(await room.note(LEAD, 'decision', 'Agent decision.')).toMatchObject({
      kind: 'recorded',
    });
    expect(personCommitted).toBe(true);
    const text = await room.text();
    // The note never overwrites the person, and each edit stays where it
    // was made: the person's sentence is intact and the note is in Decisions.
    expect(
      text.startsWith('Brief, edited by a person.\n\n## Decisions\n'),
    ).toBe(true);
    const decisions = text.slice(
      text.indexOf('## Decisions'),
      text.indexOf('## Done'),
    );
    expect(decisions).toContain('\n- A person decided this.\n');
    expect(decisions).toContain(`\n${line(LEAD, 'Agent decision.')}\n`);
    expect(text.split(line(LEAD, 'Agent decision.')).length).toBe(2);
  });

  test("a person's edit planned before the note and submitted after it is preserved", async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    const base = await room.text();
    const submit = await room.personPlan(
      base.replace('## Done\n', '## Done\n\n- Person finished this.\n'),
    );
    expect(await room.note(LEAD, 'done', 'Agent finished that.')).toMatchObject(
      { kind: 'recorded' },
    );
    expect(await submit()).toMatchObject({ kind: 'committed' });
    const text = await room.text();
    expect(text).toContain('- Person finished this.');
    expect(text).toContain(line(LEAD, 'Agent finished that.'));
    expect(text.startsWith('Brief.\n\n## Decisions\n\n## Done\n')).toBe(true);
  });

  test("a person's mid-document edit deletes only what it replaces, so it cannot displace a note", async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    expect(await room.note(LEAD, 'decision', 'Anchored here.')).toMatchObject({
      kind: 'recorded',
    });
    const seeded = room.personOperations.length;
    // Eight edits in the brief, each replacing its final character. A random
    // intent identity reinserts the suffix about one time in two.
    let expected = await room.text();
    for (let index = 0; index < 8; index += 1) {
      const at = expected.indexOf('\n\n## Decisions');
      expected = `${expected.slice(0, at - 1)}${index}${expected.slice(at)}`;
      await room.personEdit(expected);
    }
    expect(await room.text()).toBe(expected);
    const deleted = room.personOperations
      .slice(seeded)
      .reduce(
        (count, operation) =>
          count + (operation.kind === 'delete' ? operation.target.length : 0),
        0,
      );
    expect(deleted).toBe(8);
  });

  test("at the room's stored-state bound a note is refused as document-full and nothing is written", async () => {
    // The worker stores the whole converged state (each atom with its id and
    // its predecessor's, tombstones included) under a 512 KiB bound: about
    // 111 bytes per character with this runtime's identities. A 3500-
    // character brief sits under it (and under the revision-evidence bound,
    // see the next test); a maximum-length note would cross it in one step.
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('b'.repeat(3500)));
    await room.bind(LEAD);
    const before = await room.text();
    expect(await room.note(LEAD, 'done', 'n'.repeat(2000))).toEqual({
      kind: 'document-full',
    });
    expect(await room.text()).toBe(before);
    // Deterministic: the same note is refused again and writes nothing.
    expect(await room.note(LEAD, 'done', 'n'.repeat(2000))).toEqual({
      kind: 'document-full',
    });
    expect(await room.text()).toBe(before);
    // The room is not wedged: a note that fits is still recorded.
    expect(await room.note(LEAD, 'done', 'Fits.')).toMatchObject({
      kind: 'recorded',
    });
  });

  // KNOWN DEFECT (reported on #4003, not fixed in this lane): the working
  // state admits a commit whose revision evidence the evidence module then
  // refuses as `snapshot_invalid` (observed at about 478 KB of snapshot JSON,
  // below both 512 KiB bounds). That publication can never drain, so every
  // later write to the room, a person's included, is rejected as
  // `revision-publication-pending`. `test.fails` keeps the intended behavior
  // executable; it starts failing (and should become `test`) once fixed.
  test.fails("a room that notes have filled still accepts a person's edit", async () => {
    const room = await setup();
    await room.runtime.discover({
      taskId: room.task.id,
      request: room.request,
    });
    await room.personEdit(taskDocumentSeedText('Brief.'));
    await room.bind(LEAD);
    let outcome: Awaited<ReturnType<typeof room.note>> | undefined;
    for (let index = 0; index < 400; index += 1) {
      outcome = await room.note(LEAD, 'done', `${index} ${'n'.repeat(200)}`);
      if (outcome.kind !== 'recorded') break;
    }
    expect(outcome?.kind).not.toBe('recorded');
    const text = await room.text();
    // A person shortens the brief: a pure deletion, so it shrinks nothing
    // stored but must still be admitted.
    await room.personEdit(text.replace('Brief.', 'Brief'));
  });
});
