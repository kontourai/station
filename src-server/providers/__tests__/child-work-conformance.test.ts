/**
 * #2456 conformance tripwire: every engine's `subagentObservability` cell in
 * the capability matrix is checked against what that engine's adapter
 * ACTUALLY emits as child work, by replaying captured engine output through
 * the adapter's own mapper and folding the resulting `child-work.updated`
 * events.
 *
 * - `declared` → the observed signals must be exactly the declared ones,
 *   less any registered gap; each gap is a `test.fails` linked to its issue.
 * - `none` → the adapter must emit no child work at all for the engine's
 *   real output.
 *
 * A signal is only counted when the delta carries it:
 *   lifecycle = a settle for a child a same-reporter snapshot listed running
 *   progress  = an upsert with a progress line
 *   usage     = child usage on a settle or upsert
 *   result    = a summary or a result handle on a settle
 *   nesting   = a depth on any child
 */
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  type ChildWorkDelta,
  type ChildWorkItem,
  childWorkDeltaFromLegacyClaudeTaskNotification,
  childWorkKey,
  LEGACY_CLAUDE_TASK_NAMESPACE,
} from '@kontourai/station-contracts/child-work';
import {
  ENGINE_CAPABILITY_MATRICES,
  type SubagentSignal,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { STATION_UNMAPPED_SUBAGENT_ENGINES } from '../../services/orchestration/child-work-projection.js';
import { mapAcpExtensionNotification } from '../adapters/acp-adapter-events.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import type { MuseProcessLike } from '../adapters/muse-adapter-types.js';
import {
  CLAUDE_TASK_CAPTURES,
  replayClaudeTaskCapture,
} from './claude-task-captures.js';
import {
  CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED,
  CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED,
  replayCodexCapture,
} from './codex-collab-fixtures.js';
import {
  MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  MUSE_13_BASH_TOOL_TURN_LINES,
} from './muse-adapter-fixtures.js';

type Driver = {
  /** Replays the engine's captured output; returns everything published. */
  run: () => Promise<CanonicalRuntimeEvent[]>;
  /**
   * When the engine reports subagents in more than one wire format, each
   * format's replay on its own. `run` is their union, so a signal lost in
   * ONE format would still pass the union check; each format is checked
   * separately below.
   */
  formats?: Record<string, () => Promise<CanonicalRuntimeEvent[]>>;
};

/**
 * Claude: the REAL captures (`claude-task-captures.ts`), each replayed
 * through the adapter's own mapper and its child-work module
 * (`claude-adapter-child-work.ts`). One format per capture that carries a
 * subagent's whole life: `close-kills` is left out of the per-format check
 * because the engine sends no terminal there (the child ends `unresolved` at
 * the session end), so it has no lifecycle settle to deliver — it is still in
 * the union.
 */
const CLAUDE_FORMATS = Object.fromEntries(
  CLAUDE_TASK_CAPTURES.filter((name) => name !== 'close-kills').map((name) => [
    name,
    async () => replayClaudeTaskCapture(name).events,
  ]),
);

async function replayClaudeCaptures(): Promise<CanonicalRuntimeEvent[]> {
  return CLAUDE_TASK_CAPTURES.flatMap(
    (name) =>
      replayClaudeTaskCapture(name, { threadId: `thread-claude-${name}` })
        .events,
  );
}

class FakeMuseProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }
  kill(): boolean {
    this.killed = true;
    this.exit(null);
    return true;
  }
  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }
}

/**
 * The REAL muse 1.3 captures already committed for the muse adapter (a bash
 * tool turn and a background-workflow turn), fed through the actual adapter
 * with its process replaced by a stream double.
 */
async function replayMuseCaptures(): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  for (const [index, lines] of [
    MUSE_13_BASH_TOOL_TURN_LINES,
    MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  ].entries()) {
    const processes: FakeMuseProcess[] = [];
    const adapter = new MuseAdapter({
      newSessionId: () => `muse-session-${index}`,
      processFactory: () => {
        const processHandle = new FakeMuseProcess();
        processes.push(processHandle);
        return { process: processHandle, release: () => {} };
      },
      terminateProcess: async (processHandle: MuseProcessLike) => {
        processHandle.kill('SIGTERM');
      },
      logger: { warn: () => {}, info: () => {} },
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const threadId = `thread-muse-${index}`;
    await adapter.startSession({ provider: 'muse', threadId });
    await adapter.sendTurn({ threadId, input: 'go' });
    for (const line of lines) processes[0].stdout.write(`${line}\n`);
    await new Promise((settle) => setTimeout(settle, 20));
    // Collect whatever the adapter published; stop once the queue is quiet.
    for (;;) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<'quiet'>((settle) => setTimeout(() => settle('quiet'), 30)),
      ]);
      if (next === 'quiet' || next.done) break;
      events.push(next.value as CanonicalRuntimeEvent);
    }
    await adapter.stopAll();
  }
  return events;
}

/**
 * ACP: `_kiro.dev/subagent/list_update` is the one subagent-shaped tuple a
 * Kiro ACP agent was observed sending (station#1935, bound as host chrome).
 * Only the TUPLE was observed; no payload was captured, so the params here
 * are an empty object and the claim under test is the routing: the mapper
 * forwards it as an opaque extension notification, never as child work.
 */
async function replayAcpKiroSubagentTuple(): Promise<CanonicalRuntimeEvent[]> {
  const events: CanonicalRuntimeEvent[] = [];
  mapAcpExtensionNotification('_kiro.dev/subagent/list_update', {}, {
    provider: 'acp',
    session: { threadId: 'thread-acp' },
    publish: (event: CanonicalRuntimeEvent) => events.push(event),
  } as unknown as Parameters<typeof mapAcpExtensionNotification>[2]);
  return events;
}

/**
 * Codex: the REAL codex-cli 0.155.1 captures (`codex-collab-fixtures.ts`),
 * one per subagent item format — v1 `collabAgentToolCall` and v2
 * `subAgentActivity` — each a spawn the parent waits on and the child
 * completes. Replayed through `CodexAdapterTransport`'s own stdout routing,
 * because that is where a child thread's notifications used to be dropped:
 * a notifications-only replay could not see the child's stream at all.
 */
const CODEX_FORMATS = {
  'v1 collabAgentToolCall': async () =>
    replayCodexCapture(CODEX_COLLAB_V1_SPAWN_WAIT_COMPLETED).events,
  'v2 subAgentActivity': async () =>
    replayCodexCapture(CODEX_COLLAB_V2_SPAWN_WAIT_COMPLETED).events,
};

async function replayCodexCollabCaptures(): Promise<CanonicalRuntimeEvent[]> {
  return [
    ...(await CODEX_FORMATS['v1 collabAgentToolCall']()),
    ...(await CODEX_FORMATS['v2 subAgentActivity']()),
  ];
}

/**
 * Station's own engine: its matrix cell is `none` (Station delegation is a
 * task, not an engine subagent). STRUCTURAL guard only: there is no captured
 * engine output to replay, so this asserts the adapter module never names the
 * child-work event at all.
 */
async function stationAdapterStructural(): Promise<CanonicalRuntimeEvent[]> {
  const source = readFileSync(
    new URL('../adapters/station-agent-adapter.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toContain('child-work.updated');
  return [];
}

const DRIVERS: Record<string, Driver> = {
  station: { run: stationAdapterStructural },
  claude: {
    run: replayClaudeCaptures,
    formats: CLAUDE_FORMATS,
  },
  codex: {
    run: replayCodexCollabCaptures,
    formats: CODEX_FORMATS,
  },
  muse: { run: replayMuseCaptures },
  acp: { run: replayAcpKiroSubagentTuple },
};

/**
 * The child work a replay produced, read exactly as the server projection
 * reads it: `child-work.updated` deltas, plus any legacy `claude-code` task
 * tuple through the contract's one translator (the projection still reads
 * them, for pre-#2457 history). No driver emits one — asserted below — so the
 * translator cannot manufacture a signal here.
 */
function childWorkDeltas(events: CanonicalRuntimeEvent[]): ChildWorkDelta[] {
  return events.flatMap((event) => {
    if (event.method === 'child-work.updated') return [event.delta];
    if (event.method !== 'extension.notification') return [];
    const legacy = childWorkDeltaFromLegacyClaudeTaskNotification(
      event,
      event.threadId,
    );
    return legacy ? [legacy] : [];
  });
}

function itemsOf(delta: ChildWorkDelta): ChildWorkItem[] {
  if (delta.kind === 'snapshot') return delta.running;
  if (delta.kind === 'upsert') return [delta.item];
  return [];
}

function observedSignals(deltas: ChildWorkDelta[]): Set<SubagentSignal> {
  const signals = new Set<SubagentSignal>();
  // Lifecycle is ONE child's start and end: a settle for a key that a
  // snapshot from the same reporter listed as running. Any running snapshot
  // plus any unrelated settle proves nothing about either.
  const listedRunning = new Set(
    deltas.flatMap((delta) =>
      delta.kind === 'snapshot'
        ? delta.running
            .filter(
              (item) =>
                item.reporterThreadId === delta.reporterThreadId &&
                item.producer === delta.producer,
            )
            .map((item) => childWorkKey(item))
        : [],
    ),
  );
  if (
    deltas.some(
      (delta) =>
        delta.kind === 'settle' && listedRunning.has(childWorkKey(delta)),
    )
  ) {
    signals.add('lifecycle');
  }
  for (const delta of deltas) {
    if (delta.kind === 'upsert' && delta.item.progress) {
      signals.add('progress');
    }
    if (
      (delta.kind === 'settle' && delta.usage) ||
      (delta.kind === 'upsert' && delta.item.usage)
    ) {
      signals.add('usage');
    }
    if (
      delta.kind === 'settle' &&
      (delta.result?.summary || delta.result?.handle)
    ) {
      signals.add('result');
    }
    if (
      itemsOf(delta).some((item) => item.depth !== undefined) ||
      (delta.kind === 'settle' && delta.identity?.depth !== undefined)
    ) {
      signals.add('nesting');
    }
  }
  return signals;
}

/**
 * Declared signals the adapter does not yet deliver: registered, tracked gaps
 * rather than passes. Each one is a `test.fails`, so it turns red the moment
 * the signal IS delivered — the cue to delete the entry.
 */
const KNOWN_SIGNAL_GAPS: Record<
  string,
  Partial<Record<SubagentSignal, string>>
> = {};

const ADAPTERS_DIR = new URL('../adapters/', import.meta.url);

/**
 * Whether `source` BUILDS a child-work event: an object literal property
 * `method: 'child-work.updated'` in code, found by parsing the file with the
 * TypeScript compiler. A comment, or the string anywhere else, does not
 * count; either quote style does.
 *
 * An emitter that builds `method` from a named constant is not recognised:
 * this is a structural check of LITERAL method assignments.
 *
 * STRUCTURAL ONLY (#2457 review D3): this proves the module constructs such
 * an event, not that a given replay reached that line at runtime — the
 * drivers publish through adapter-owned queues (Codex replays through its
 * transport), where no per-module spy can see the emit. The runtime half is
 * each driver producing this engine's `child-work.updated` events at all.
 */
function buildsChildWorkEvent(source: string, fileName: string): boolean {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'method' &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text === 'child-work.updated'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The adapter modules that can emit child work (see `buildsChildWorkEvent`).
 * A driver's child work can only have come from one of these, which is what
 * ties a cell's `adapterModule` to the code a replay ran (#2457 review V4).
 */
function childWorkEmittingModules(): string[] {
  return readdirSync(ADAPTERS_DIR)
    .filter((name) => name.endsWith('.ts'))
    .filter((name) =>
      buildsChildWorkEvent(
        readFileSync(new URL(name, ADAPTERS_DIR), 'utf8'),
        name,
      ),
    )
    .sort();
}

/**
 * Engines whose emitted child work offers a control its matrix
 * `subagentControl` cell does not declare wired (or the reverse), keyed to
 * the tracking issue. Each is a `test.fails`.
 */
const KNOWN_CONTROL_GAPS: Record<string, string> = {};

/** Every control any delta offers, on an item or a settle's identity. */
function offeredControls(deltas: ChildWorkDelta[]): string[] {
  return deltas.flatMap((delta) => {
    const controls = [
      ...itemsOf(delta).map((item) => item.controls),
      delta.kind === 'settle' ? delta.identity?.controls : undefined,
    ];
    return controls.flatMap((control) =>
      control ? [control.stop ?? 'controls-without-stop'] : [],
    );
  });
}

describe('#2456 child-work conformance tripwire', () => {
  test("the projection's unmapped-engine set is exactly the engines whose declared lifecycle is a known gap", () => {
    const lifecycleGaps = Object.fromEntries(
      Object.entries(KNOWN_SIGNAL_GAPS).flatMap(([key, gaps]) =>
        gaps?.lifecycle ? [[key, gaps.lifecycle]] : [],
      ),
    );
    expect(STATION_UNMAPPED_SUBAGENT_ENGINES).toEqual(lifecycleGaps);
  });

  test('the emitter check reads code, not text: a comment or a stray string is not an emitter; either quote style is', () => {
    const at = 'probe.ts';
    expect(
      buildsChildWorkEvent("// publishes method: 'child-work.updated'\n", at),
    ).toBe(false);
    expect(
      buildsChildWorkEvent("const label = 'child-work.updated';\n", at),
    ).toBe(false);
    expect(
      buildsChildWorkEvent("publish({ kind: 'child-work.updated' });\n", at),
    ).toBe(false);
    expect(
      buildsChildWorkEvent('publish({ method: "child-work.updated" });\n', at),
    ).toBe(true);
    expect(
      buildsChildWorkEvent("publish({ method: 'child-work.updated' });\n", at),
    ).toBe(true);
  });

  test('the modules that emit child work are exactly the declared cells’ adapter modules (structural)', () => {
    const declared = Object.values(ENGINE_CAPABILITY_MATRICES).flatMap(
      (matrix) =>
        matrix.subagentObservability.state === 'declared'
          ? [matrix.subagentObservability.adapterModule]
          : [],
    );
    expect(childWorkEmittingModules()).toEqual([...new Set(declared)].sort());
  });

  test('there is exactly one driver per matrix engine key', () => {
    expect(Object.keys(DRIVERS).sort()).toEqual(
      Object.keys(ENGINE_CAPABILITY_MATRICES).sort(),
    );
  });

  for (const [key, matrix] of Object.entries(ENGINE_CAPABILITY_MATRICES)) {
    const cell = matrix.subagentObservability;
    const driver = DRIVERS[key];
    // A control is what a client renders a stop button from, so the emitted
    // child work and the matrix must agree: a `none` cell offers no control
    // on any delta, and a `wired` cell's stop is actually offered.
    const control = matrix.subagentControl;
    const controlTest = KNOWN_CONTROL_GAPS[key] ? test.fails : test;
    controlTest(
      `${key}: emitted controls match subagentControl \`${control.state}\`${
        KNOWN_CONTROL_GAPS[key] ? ` (known gap ${KNOWN_CONTROL_GAPS[key]})` : ''
      }`,
      async () => {
        const runs = [driver.run, ...Object.values(driver.formats ?? {})];
        const stopOffered =
          control.state === 'wired' && control.stop.state === 'available';
        for (const run of runs) {
          const offered = offeredControls(childWorkDeltas(await run()));
          if (stopOffered) {
            expect(offered.length).toBeGreaterThan(0);
          } else {
            expect(offered).toEqual([]);
          }
        }
      },
    );
    if (cell.state === 'none') {
      test(`${key}: declared none — real output emits no child work`, async () => {
        const events = await driver.run();
        // The replay must actually have reached the mapper; an empty stream
        // would pass the assertion below vacuously. Station's driver is the
        // labelled structural exception (no engine output to replay).
        if (key !== 'station') expect(events.length).toBeGreaterThan(0);
        expect(childWorkDeltas(events)).toEqual([]);
      });
      continue;
    }
    test(`${key}: the cell's adapter module exists and is where this engine's child work is emitted`, async () => {
      expect(existsSync(new URL(cell.adapterModule, ADAPTERS_DIR))).toBe(true);
      expect(childWorkEmittingModules()).toContain(cell.adapterModule);
      // The replay really produced child work, for this engine, and (by the
      // emitter-set test below) only a declared cell's module can emit it.
      const emitted = (await driver.run()).filter(
        (event) => event.method === 'child-work.updated',
      );
      expect(emitted.length).toBeGreaterThan(0);
      expect(new Set(emitted.map((event) => event.provider))).toEqual(
        new Set([key]),
      );
    });
    const gaps = KNOWN_SIGNAL_GAPS[key] ?? {};
    const expected = cell.signals.filter((signal) => !gaps[signal]);
    test(`${key}: observed signals are the declared ones, less registered gaps`, async () => {
      const observed = observedSignals(childWorkDeltas(await driver.run()));
      expect([...observed].sort()).toEqual([...expected].sort());
    });
    for (const [format, run] of Object.entries(driver.formats ?? {})) {
      test(`${key} (${format}): this format alone delivers every declared signal`, async () => {
        const observed = observedSignals(childWorkDeltas(await run()));
        expect([...observed].sort()).toEqual([...expected].sort());
      });
    }
    for (const [signal, issue] of Object.entries(gaps)) {
      test.fails(`${key}: delivers declared ${signal} (known gap ${issue})`, async () => {
        const observed = observedSignals(childWorkDeltas(await driver.run()));
        expect(observed.has(signal as SubagentSignal)).toBe(true);
      });
    }
  }

  test('#2457: no driver emits a pre-contract Claude task tuple', async () => {
    for (const [key, driver] of Object.entries(DRIVERS)) {
      const runs = [driver.run, ...Object.values(driver.formats ?? {})];
      for (const run of runs) {
        const tuples = (await run()).filter(
          (event) =>
            event.method === 'extension.notification' &&
            event.namespace === LEGACY_CLAUDE_TASK_NAMESPACE &&
            (event.type === 'task/registry' || event.type === 'task/settled'),
        );
        expect(tuples, key).toEqual([]);
      }
    }
  });

  test('the Claude task-subagents capture is the two-task shape the claims rest on', async () => {
    const deltas = childWorkDeltas(
      replayClaudeTaskCapture('task-subagents').events,
    );
    const settled = deltas.filter((delta) => delta.kind === 'settle');
    // Each subagent settles twice (task_updated then task_notification).
    expect(settled).toHaveLength(4);
    expect(new Set(settled.map((delta) => delta.childId)).size).toBe(2);
    expect(
      deltas.some(
        (delta) =>
          delta.kind === 'snapshot' &&
          delta.running.some((item) => item.depth === 1),
      ),
    ).toBe(true);
  });
});
