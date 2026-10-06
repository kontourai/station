/**
 * #2873: the folder a station-control dispatch was admitted into is checked
 * again where its engine is spawned.
 *
 * The dispatch route decides a new session's scope from the folder it names
 * (`routes/orchestration/dispatch-scope.ts`) and dispatches the canonical
 * path it decided on. That path is still a string, resolved again when the
 * engine starts, and several awaits later. Two things close that gap:
 *
 * - the route's {@link DispatchCwdAdmission} rides the start's dispatch
 *   context, and the service runs it again beside the adapter start, for the
 *   directory the start is actually bound to;
 * - the canonical path is recorded on the session's start metadata
 *   ({@link DISPATCH_CANONICAL_CWD_METADATA_KEY}; #3386: an adopted
 *   attached-session child records its folder the same way), and every later engine
 *   start for that session, or for a child session that continues it in the
 *   same folder, re-canonicalizes the folder and refuses a different result
 *   ({@link assertDispatchCwdUnmoved}).
 *
 * Both checks run before the adapter is called; the adapter still resolves
 * the string once more when it spawns the process.
 */
import { canonicalPath } from '../../utils/path-containment.js';

/**
 * Start metadata: the canonical folder a scoped station-control dispatch was
 * admitted into. Server-written only: `prepareStart` removes any value a
 * caller supplied before it writes its own.
 */
export const DISPATCH_CANONICAL_CWD_METADATA_KEY = 'dispatchCanonicalCwd';

/**
 * Where the directory a start is bound to came from: the session's own
 * `cwd`, or the default its engine connection configures (an ACP
 * connection's `config.cwd`), which only applies when the session has none.
 */
export type DispatchCwdOrigin = 'session' | 'connection';

/**
 * The route's scope decision for one new session, runnable again. Never
 * accepted from public JSON: only a dispatch route builds one.
 */
export interface DispatchCwdAdmission {
  /**
   * Decide again, for the directory the start is bound to (`undefined` when
   * Station chose it itself). Throws {@link DispatchCwdRefusedError} when
   * the caller may no longer start there. Returns the canonical path to
   * record for that directory, when it was the one decided on.
   */
  recheck(
    directory: string | undefined,
    origin: DispatchCwdOrigin,
  ): string | undefined;
}

/** A start refused where it would spawn; `code` is a station-control code. */
export class DispatchCwdRefusedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DispatchCwdRefusedError';
  }
}

/**
 * The code the scope rule gives a folder it cannot read
 * (`station_control_role_required`, `tools/station-control-policy.ts`): a
 * folder that no longer resolves to the recorded path is not the folder
 * that was admitted.
 */
const MOVED_CODE = 'station_control_role_required';

/** The recorded canonical folder of a start input, if it carries one. */
export function recordedDispatchCanonicalCwd(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const recorded = metadata?.[DISPATCH_CANONICAL_CWD_METADATA_KEY];
  return typeof recorded === 'string' && recorded ? recorded : undefined;
}

/** `metadata` without a caller-supplied record. */
export function withoutDispatchCanonicalCwd<
  T extends { metadata?: Record<string, unknown> },
>(input: T): T {
  if (
    !input.metadata ||
    !(DISPATCH_CANONICAL_CWD_METADATA_KEY in input.metadata)
  )
    return input;
  const { [DISPATCH_CANONICAL_CWD_METADATA_KEY]: _untrusted, ...metadata } =
    input.metadata;
  return { ...input, metadata };
}

/**
 * Refuse an engine start whose folder no longer resolves to the canonical
 * path its dispatch recorded. A start with no record is not decided here.
 * `directory` is where the engine would start; a recorded session with none
 * refuses.
 */
export function assertDispatchCwdUnmoved(
  input: { metadata?: Record<string, unknown> },
  directory: string | undefined,
): void {
  const recorded = recordedDispatchCanonicalCwd(input.metadata);
  if (recorded === undefined) return;
  let current: string | undefined;
  try {
    current = directory ? canonicalPath(directory) : undefined;
  } catch {
    current = undefined;
  }
  if (current !== recorded) throw dispatchCwdMovedError(recorded, current);
}

/** The refusal for a folder that no longer resolves to its recorded path. */
export function dispatchCwdMovedError(
  recorded: string | undefined,
  current: string | undefined,
): DispatchCwdRefusedError {
  return new DispatchCwdRefusedError(
    `Station will not start this session: it was admitted into ${
      recorded ?? 'a folder Station did not record'
    }, and its working directory ${
      current === undefined
        ? 'can no longer be resolved'
        : `now resolves to ${current}`
    }. Start a new session in the folder you mean.`,
    MOVED_CODE,
  );
}
