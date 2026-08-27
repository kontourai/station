import { flowRunDisplayIdentity } from '@kontourai/station-contracts';

/**
 * Console bridge derivation (roadmap S4 item 1).
 *
 * Derives Kontour Console event records (`kontour.console.event`) from
 * Station's event-sourced orchestration state, mirroring the Console repo's
 * Flow bridge (`deriveFlowRunEvents`): record ids are deterministic functions
 * of source state (thread id + event-store sequence), so re-emission is
 * idempotent — the hub's projections deduplicate by id.
 *
 * The record contract was verified empirically against the published
 * `@kontourai/console@0.3.0` tarball (`validateEvent` in the shipped
 * console-foundation): required fields are `schema`/`version`/`id`/`type`/
 * `occurredAt`/`producer`/`scope`/`subject`/`payload`; `subject` and link
 * refs need `{product, kind, id}` strings; links need `{from, relation, to}`.
 * The package publishes no typed library entry (upstream C1/C2 in
 * docs/strategy/upstream-proposals.md), so the shapes are mirrored here.
 *
 * Mapping into Console's projection vocabulary (current-operating-state):
 * - session lifecycle      -> `process.started` / `process.progressed`
 * - flow.run-attached      -> `process.progressed` + a session->run link
 * - flow.gate-verdict      -> `gate.passed|failed|routed_back|opened`
 * - workflow.state-changed -> `station.workflow.state-changed` (timeline)
 * - platform.mutation      -> `station.platform.mutation` (timeline)
 */

import type {
  FlowGateVerdict,
  SessionState,
} from '@kontourai/station-contracts/runtime-events';
import type { PersistedRuntimeEvent } from '../orchestration/event-store.js';

export interface ConsoleCrossProductRef {
  product: string;
  kind: string;
  id: string;
  label?: string;
  [key: string]: unknown;
}

export interface ConsoleLink {
  from: ConsoleCrossProductRef;
  relation: string;
  to: ConsoleCrossProductRef;
}

export interface ConsoleEventRecord {
  schema: 'kontour.console.event';
  version: '0.1';
  id: string;
  type: string;
  occurredAt: string;
  producer: { product: string; id: string; name: string };
  scope: { kind: string; id: string; label?: string };
  subject: ConsoleCrossProductRef;
  payload: Record<string, unknown>;
  links?: ConsoleLink[];
  correlationId?: string;
  sequence?: number;
  summary?: string;
}

export interface ConsoleBridgeScope {
  kind: string;
  id: string;
  label?: string;
}

export const CONSOLE_BRIDGE_PRODUCER = {
  product: 'station',
  id: 'station-bridge',
  name: 'Station console bridge',
} as const;

export const DEFAULT_CONSOLE_SCOPE: ConsoleBridgeScope = {
  kind: 'project',
  id: 'station-local',
  label: 'Station local sessions',
};

/** Canonical methods the bridge derives Console records from. */
export const CONSOLE_BRIDGED_METHODS: ReadonlySet<string> = new Set([
  'session.started',
  'session.state-changed',
  'session.exited',
  'flow.run-attached',
  'flow.gate-verdict',
  'workflow.state-changed',
  'platform.mutation',
]);

/** Session states that mark a process terminal in Console terms. */
const TERMINAL_SESSION_STATES: ReadonlySet<SessionState> = new Set([
  'completed',
  'aborted',
  'errored',
]);

const GATE_EVENT_TYPE: Record<FlowGateVerdict, string> = {
  pass: 'gate.passed',
  block: 'gate.failed',
  'route-back': 'gate.routed_back',
  wait: 'gate.opened',
};

const GATE_STATUS: Record<FlowGateVerdict, string> = {
  pass: 'passed',
  block: 'failed',
  'route-back': 'routed_back',
  wait: 'waiting',
};

/** Path/id-safe token, mirroring the Console emitter's sanitizer. */
export function sanitizeConsoleToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function sessionSubject(threadId: string): ConsoleCrossProductRef {
  return {
    product: 'station',
    kind: 'session',
    id: `station-session-${sanitizeConsoleToken(threadId)}`,
    label: `Station session ${threadId}`,
  };
}

function recordId(threadId: string, sequence: number): string {
  return `evt-stationbridge-${sanitizeConsoleToken(threadId)}-${sequence}`;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

/**
 * Resolve the workspace directory a thread's session ran in, from canonical
 * event history (the cwd-bearing orchestration events). Used by the local
 * file sink to place `.kontour/events/**` in the project workspace.
 */
export function resolveThreadWorkspace(
  events: PersistedRuntimeEvent[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index].payload;
    if (
      'cwd' in payload &&
      typeof payload.cwd === 'string' &&
      payload.cwd.length > 0
    ) {
      return payload.cwd;
    }
  }
  return undefined;
}

/**
 * Derives the deterministic Console record sequence for one thread's
 * event-sourced history. Same input state -> byte-identical records (modulo
 * nothing: `occurredAt` comes from the stored events, ids from thread id +
 * sequence), so re-derivation and re-emission are idempotent.
 */
export function deriveConsoleEventRecords(
  events: PersistedRuntimeEvent[],
  options: { scope?: ConsoleBridgeScope } = {},
): ConsoleEventRecord[] {
  const scope = options.scope ?? DEFAULT_CONSOLE_SCOPE;
  const records: ConsoleEventRecord[] = [];

  for (const persisted of events) {
    const event = persisted.payload;
    const threadId = persisted.threadId;
    const base = {
      schema: 'kontour.console.event' as const,
      version: '0.1' as const,
      id: recordId(threadId, persisted.sequence),
      occurredAt: persisted.createdAt,
      producer: { ...CONSOLE_BRIDGE_PRODUCER },
      scope: { ...scope },
      correlationId: `corr-station-${sanitizeConsoleToken(threadId)}`,
      sequence: persisted.sequence,
    };
    const subject = sessionSubject(threadId);

    switch (event.method) {
      case 'session.started':
        records.push({
          ...base,
          type: 'process.started',
          subject,
          payload: {
            after: { status: 'running', provider: event.provider },
            summary: `Station session ${threadId} started (${event.provider}).`,
          },
        });
        break;
      case 'session.state-changed': {
        if (!TERMINAL_SESSION_STATES.has(event.to)) break;
        const status = event.to === 'completed' ? 'completed' : 'blocked';
        records.push({
          ...base,
          type: 'process.progressed',
          subject,
          payload: compact({
            after: { status, sessionState: event.to },
            reason: event.reason,
            summary: `Station session ${threadId} ${event.to}.`,
          }),
        });
        break;
      }
      case 'session.exited': {
        const failed =
          typeof event.exitCode === 'number' && event.exitCode !== 0;
        records.push({
          ...base,
          type: 'process.progressed',
          subject,
          payload: compact({
            after: { status: failed ? 'blocked' : 'completed' },
            exitCode: event.exitCode,
            reason: event.reason,
            summary: `Station session ${threadId} exited${
              typeof event.exitCode === 'number'
                ? ` (code ${event.exitCode})`
                : ''
            }.`,
          }),
        });
        break;
      }
      case 'flow.run-attached': {
        const runRef: ConsoleCrossProductRef = {
          product: 'flow',
          kind: 'run',
          id: `run-${sanitizeConsoleToken(event.runId)}`,
          label: flowRunDisplayIdentity(event.definitionId, event.runId),
        };
        records.push({
          ...base,
          type: 'process.progressed',
          subject,
          payload: {
            after: {
              status: 'running',
              flowRunId: event.runId,
              flowDefinitionId: event.definitionId,
              resumed: event.resumed,
            },
            summary: `Session bound to ${flowRunDisplayIdentity(event.definitionId, event.runId)}${event.resumed ? ', resumed' : ''}.`,
          },
          links: [{ from: subject, relation: 'gated-by', to: runRef }],
        });
        break;
      }
      case 'flow.gate-verdict': {
        const gateId = event.gateId ?? 'completion';
        records.push({
          ...base,
          type: GATE_EVENT_TYPE[event.verdict],
          subject: {
            product: 'flow',
            kind: 'gate',
            id: `gate-${sanitizeConsoleToken(event.runId)}-${sanitizeConsoleToken(gateId)}`,
            label: `${gateId} (${event.runId})`,
          },
          payload: compact({
            after: { status: GATE_STATUS[event.verdict], processRef: subject },
            verdict: event.verdict,
            runId: event.runId,
            gateId: event.gateId,
            nextAction: event.nextAction,
            routeBackTo: event.routeBackTo,
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            missing: event.missing,
            reportPaths: event.reportPaths,
            exceptionRequired: event.exceptionRequired,
            autoReadiness: event.autoReadiness,
            summary:
              event.summary ??
              `Gate ${gateId} verdict: ${event.verdict} (run ${event.runId}).`,
          }),
        });
        break;
      }
      case 'workflow.state-changed':
        records.push({
          ...base,
          type: 'station.workflow.state-changed',
          subject: {
            product: 'station',
            kind: 'workflow-task',
            id: `workflow-${sanitizeConsoleToken(event.taskSlug)}`,
            label: event.taskSlug,
          },
          payload: {
            after: {
              status: event.status,
              phase: event.phase,
              nextActionStatus: event.nextActionStatus,
              nextActionSummary: event.nextActionSummary,
              ownership: event.ownership,
              resumed: event.resumed,
            },
            trigger: event.trigger,
            summary: `Workflow ${event.taskSlug}: ${event.status}/${event.phase} (${event.trigger}).`,
          },
          links: [
            {
              from: subject,
              relation: 'works-on',
              to: {
                product: 'station',
                kind: 'workflow-task',
                id: `workflow-${sanitizeConsoleToken(event.taskSlug)}`,
                label: event.taskSlug,
              },
            },
          ],
        });
        break;
      case 'platform.mutation':
        records.push({
          ...base,
          type: 'station.platform.mutation',
          subject: {
            product: 'station',
            kind: 'platform-mutation',
            id: `mutation-${sanitizeConsoleToken(threadId)}-${persisted.sequence}`,
            label: event.tool,
          },
          payload: compact({
            after: {
              tool: event.tool,
              outcome: event.outcome,
              decision: event.decision,
              profile: event.profile,
            },
            runId: event.runId,
            gateId: event.gateId,
            reason: event.reason,
            argsSummary: event.argsSummary,
            summary: `Platform mutation ${event.tool}: ${event.outcome}.`,
          }),
        });
        break;
      default:
        break;
    }
  }

  return records;
}
