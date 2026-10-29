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
