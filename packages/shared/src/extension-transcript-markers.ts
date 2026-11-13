/**
 * Extension notifications the transcript shows as a quiet marker line
 * (station#3415).
 *
 * An attached-session source records some engine facts that have no
 * canonical event — a context compaction, a rewind to an earlier prompt — as
 * an `extension.notification`. The transcript projection
 * (`runtime-event-projection.ts`) renders exactly the `(namespace, type)`
 * tuples listed here, and the extension-notification binding registry
 * (`src-shared/extension-notification-bindings.ts`) derives its
 * `transcript.marker` bindings from this same table, so a tuple is bound and
 * rendered by one entry. Any other tuple stays opaque: matching is exact, and
 * a similar namespace or type is never a match.
 *
 * The marker text is fixed per kind and never read from the payload: the
 * payload is engine-defined and carries no display contract.
 */

import { ACP_SESSION_REWOUND_CODE } from '@kontourai/station-contracts/provider';

export type ExtensionTranscriptMarkerKind =
  | 'context-compacted'
  | 'conversation-rewound'
  | 'workload-command-oom-killed';

/** The Station session source that mints the tuple. */
export type ExtensionTranscriptMarkerEmitter =
  | 'codex-rollout-session-source'
  | 'grok-session-source'
  | 'codex-adapter-transport';

/** Station's own workload notices (`codex-adapter-transport.ts`). */
export const WORKLOAD_TRANSCRIPT_NAMESPACE = 'station-workload';
export const WORKLOAD_COMMAND_OOM_KILLED_TYPE = 'command-oom-killed';

export interface ExtensionTranscriptMarkerSource {
  readonly namespace: string;
  readonly type: string;
  readonly marker: ExtensionTranscriptMarkerKind;
  readonly emitter: ExtensionTranscriptMarkerEmitter;
}

/**
 * The fixed label per kind: `betweenTurns` for a marker that arrived between
 * turns, `duringTurn` for one that arrived while a turn ran and is shown
 * after that turn's rows.
 */
export const EXTENSION_TRANSCRIPT_MARKER_TEXT: Readonly<
  Record<
    ExtensionTranscriptMarkerKind,
    Readonly<{ betweenTurns: string; duringTurn: string }>
  >
> = Object.freeze({
  'context-compacted': Object.freeze({
    betweenTurns: 'Context compacted',
    duringTurn: 'Context compacted during this turn',
  }),
  'conversation-rewound': Object.freeze({
    betweenTurns: 'Rewound to an earlier prompt',
    duringTurn: 'Rewound to an earlier prompt during this turn',
  }),
  'workload-command-oom-killed': Object.freeze({
    betweenTurns:
      "A command was killed for exceeding the engine's workload memory budget",
    duringTurn:
      "A command was killed during this turn for exceeding the engine's workload memory budget",
  }),
});

/** The part type a projected marker row carries. */
export const EXTENSION_TRANSCRIPT_MARKER_PART_TYPE = 'transcript-marker';

const DECLARED_EXTENSION_TRANSCRIPT_MARKERS = [
  {
    // `codex-rollout-session-source.ts`: a rollout's `context_compacted`
    // event, or a `compacted` envelope.
    namespace: 'codex-rollout',
    type: 'context-compacted',
    marker: 'context-compacted',
    emitter: 'codex-rollout-session-source',
  },
  {
    // The Grok session source (#3386): a `compaction_checkpoint` update.
    namespace: 'grok-session',
    type: 'context-compacted',
    marker: 'context-compacted',
    emitter: 'grok-session-source',
  },
  {
    // The Grok session source (#3386): a `rewind_marker` update. Station keeps
    // the turns after the rewind target, so the marker is what tells a reader
    // the engine itself went back.
    namespace: 'grok-session',
    type: 'conversation-rewound',
    marker: 'conversation-rewound',
    emitter: 'grok-session-source',
  },
  {
    // A kernel OOM kill inside a running engine's workload scope, under
    // OOMPolicy=continue: the engine survived, a process (normally a command)
    // did not.
    namespace: 'station-workload',
    type: 'command-oom-killed',
    marker: 'workload-command-oom-killed',
    emitter: 'codex-adapter-transport',
  },
] as const satisfies readonly ExtensionTranscriptMarkerSource[];

export const EXTENSION_TRANSCRIPT_MARKERS: readonly ExtensionTranscriptMarkerSource[] =
  Object.freeze(
    DECLARED_EXTENSION_TRANSCRIPT_MARKERS.map((entry) =>
      Object.freeze({ ...entry }),
    ),
  );

/** The marker kind for an exact `(namespace, type)` tuple, or undefined. */
export function extensionTranscriptMarker(
  namespace: string,
  type: string,
): ExtensionTranscriptMarkerKind | undefined {
  return EXTENSION_TRANSCRIPT_MARKERS.find(
    (entry) => entry.namespace === namespace && entry.type === type,
  )?.marker;
}

/** The longest model id a reroute marker shows; longer ones are cut. */
const REROUTE_MARKER_MODEL_CHARS = 64;

function markerModel(id: string): string {
  return id.length > REROUTE_MARKER_MODEL_CHARS
    ? `${id.slice(0, REROUTE_MARKER_MODEL_CHARS - 1)}…`
    : id;
}

/**
 * The transcript marker text for a `model.rerouted` event: the engine moved
 * work onto another model than the one asked for. Built only from the
 * event's model ids, which the adapter bounded to one model-id token, and
 * fixed wording; nothing else from the engine reaches the line.
 */
export function modelReroutedMarkerText(event: {
  fromModel: string;
  toModel?: string;
  trigger: 'refusal' | 'availability' | 'other';
  scope: 'turn' | 'session';
  childWorkId?: string;
}): { betweenTurns: string; duringTurn: string } {
  const from = markerModel(event.fromModel);
  const why =
    event.trigger === 'refusal'
      ? ' after a refusal'
      : event.trigger === 'availability'
        ? ' (unavailable)'
        : '';
  const who = event.childWorkId ? 'A subagent’s model' : 'Model';
  if (!event.toModel) {
    const text = `${who} ${from} could not be used${why}; no fallback was available`;
    return { betweenTurns: text, duringTurn: `${text} during this turn` };
  }
  const to = markerModel(event.toModel);
  const base = `${who} switched from ${from} to ${to}${why}`;
  if (event.scope === 'session' && !event.childWorkId) {
    const text = `${base} for the rest of this session`;
    return { betweenTurns: text, duringTurn: text };
  }
  return { betweenTurns: base, duringTurn: `${base} during this turn` };
}

/** Bound on the hidden turns one rewind marker names; more are not read. */
const REWOUND_TURNS_MAX = 500;

/**
 * An in-place engine rewind (`ACP_SESSION_REWOUND_CODE` warning) as the
 * transcript reads it: the turns it hid and how many files the engine said
 * it restored. Undefined for any other warning, or a malformed one.
 */
export function sessionRewoundMarker(event: {
  code?: string;
  details?: Record<string, unknown>;
}):
  | {
      hiddenTurnIds: string[];
      affectedFileCount?: number;
      text: { betweenTurns: string; duringTurn: string };
    }
  | undefined {
  if (event.code !== ACP_SESSION_REWOUND_CODE) return undefined;
  const hidden = event.details?.hiddenTurnIds;
  if (!Array.isArray(hidden) || hidden.length > REWOUND_TURNS_MAX)
    return undefined;
  const hiddenTurnIds = hidden.filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const count = event.details?.affectedFileCount;
  const affectedFileCount =
    typeof count === 'number' && Number.isInteger(count) && count >= 0
      ? count
      : undefined;
  const turns =
    hiddenTurnIds.length === 1 ? 'one turn' : `${hiddenTurnIds.length} turns`;
  const files =
    affectedFileCount === undefined
      ? ''
      : affectedFileCount === 1
        ? '; the engine restored one file'
        : `; the engine restored ${affectedFileCount} files`;
  const text = `Rewound: the engine no longer sees ${turns}${files}`;
  return {
    hiddenTurnIds,
    ...(affectedFileCount === undefined ? {} : { affectedFileCount }),
    text: { betweenTurns: text, duringTurn: text },
  };
}
