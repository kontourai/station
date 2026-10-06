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
  | 'conversation-rewound';

/** The Station session source that mints the tuple. */
export type ExtensionTranscriptMarkerEmitter =
  | 'codex-rollout-session-source'
  | 'grok-session-source';

export interface ExtensionTranscriptMarkerSource {
  readonly namespace: string;
  readonly type: string;
  readonly marker: ExtensionTranscriptMarkerKind;
  readonly emitter: ExtensionTranscriptMarkerEmitter;
}

export const EXTENSION_TRANSCRIPT_MARKER_TEXT: Readonly<
  Record<ExtensionTranscriptMarkerKind, string>
> = Object.freeze({
  'context-compacted': 'Context compacted',
  'conversation-rewound': 'Rewound to an earlier prompt',
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
