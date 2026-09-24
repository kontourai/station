/**
 * Why an owned search read produced no result — for the server log only
 * (#2460).
 *
 * A refused read reaches its caller as `unavailable`, and a search response
 * must keep carrying only the closed `provider-timeout-or-error` vocabulary.
 * Before this record, the cause was discarded at three layers (the worker's
 * query catch, the session read gate's catch, and the runtime message
 * provider's generic rethrow), so a fast intermittent refusal could not name
 * itself. Every field here is either a literal this module's callers write or
 * an error CLASS fact (constructor name, `code`, SQLite `errcode`, exit
 * code) matched against a narrow pattern — never an error message, which can
 * carry queries, message bodies or paths.
 */
export type SearchReadRefusalKind =
  // Session read gate (`isolated-session-transcript-search.ts`).
  | 'closed'
  | 'busy'
  | 'aborted'
  | 'authority-invalid'
  | 'request-invalid'
  | 'not-current'
  | 'read-failed'
  | 'threw'
  // Owned worker lifecycle (`owned-search-read-worker.ts`).
  | 'request-too-large'
  | 'spawn-failed'
  | 'post-failed'
  | 'deadline'
  | 'late-reply'
  | 'reply-invalid'
  | 'reply-mismatch'
  | 'result-invalid'
  | 'worker-error'
  | 'worker-exit'
  | 'retired'
  // Transcript read adapter (`isolated-transcript-search.ts`).
  | 'worker-unavailable'
  | 'unrecorded'
  // Authored by the transcript worker itself.
  | 'query-error'
  | 'reply-too-large';

export interface SearchReadRefusal {
  kind: SearchReadRefusalKind;
  /** Where in the session read gate the refusal was decided. */
  stage?: 'admission' | 'before-read' | 'during-read' | 'after-read';
  /** Which currentness component was false, or the owned worker's phase. */
  component?: string;
  name?: string;
  code?: string;
  errcode?: number;
  exitCode?: number;
  /** The lower layer's refusal this one wraps. */
  read?: SearchReadRefusal;
}

const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const WORKER_AUTHORED = new Set<SearchReadRefusalKind>([
  'query-error',
  'reply-too-large',
]);

function boundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Math.abs(value as number) <= 2 ** 31;
}

/** Class-level facts about a thrown value. Never its message. */
export function errorClassFields(
  error: unknown,
): Pick<SearchReadRefusal, 'name' | 'code' | 'errcode'> {
  const fields: Pick<SearchReadRefusal, 'name' | 'code' | 'errcode'> = {};
  if (!error || typeof error !== 'object') return fields;
  try {
    const constructorName = (error as { constructor?: { name?: unknown } })
      .constructor?.name;
    const declaredName = (error as { name?: unknown }).name;
    // A subclass that does not set `name` still reports 'Error'; its
    // constructor is the more specific, equally non-sensitive fact.
    const name =
      typeof constructorName === 'string' &&
      constructorName !== 'Error' &&
      constructorName !== 'Object'
        ? constructorName
        : declaredName;
    if (typeof name === 'string' && NAME.test(name)) fields.name = name;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && CODE.test(code)) fields.code = code;
    const errcode = (error as { errcode?: unknown }).errcode;
    if (boundedInteger(errcode)) fields.errcode = errcode;
  } catch {
    /* A hostile getter yields no fields rather than a second failure. */
  }
  return fields;
}

/** The only refusal shape the worker may put on the wire. Null when invalid. */
export function parseWorkerRefusal(value: unknown): SearchReadRefusal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return null;
  const record = value as Record<string, unknown>;
  const refusal: SearchReadRefusal = { kind: 'query-error' };
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') return null;
    const field = Object.getOwnPropertyDescriptor(record, key)!;
    if (!('value' in field)) return null;
    const entry = field.value;
    if (key === 'kind') {
      if (!WORKER_AUTHORED.has(entry as SearchReadRefusalKind)) return null;
      refusal.kind = entry as SearchReadRefusalKind;
    } else if (key === 'name') {
      if (typeof entry !== 'string' || !NAME.test(entry)) return null;
      refusal.name = entry;
    } else if (key === 'code') {
      if (typeof entry !== 'string' || !CODE.test(entry)) return null;
      refusal.code = entry;
    } else if (key === 'errcode') {
      if (!boundedInteger(entry)) return null;
      refusal.errcode = entry;
    } else return null;
  }
  return Object.hasOwn(record, 'kind') ? refusal : null;
}

/** One log-safe line, outermost layer first: `read-failed(...) <- worker-exit(exitCode=1)`. */
export function describeSearchReadRefusal(
  refusal: SearchReadRefusal | undefined,
): string {
  if (!refusal) return 'cause not recorded';
  const parts: string[] = [];
  for (const key of [
    'stage',
    'component',
    'name',
    'code',
    'errcode',
    'exitCode',
  ] as const) {
    const value = refusal[key];
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  const head = parts.length
    ? `${refusal.kind}(${parts.join(' ')})`
    : refusal.kind;
  return refusal.read
    ? `${head} <- ${describeSearchReadRefusal(refusal.read)}`
    : head;
}

/** Carries a refusal up through layers whose contract is to throw. */
export class SearchReadRefusedError extends Error {
  constructor(
    readonly refusal: SearchReadRefusal,
    subject = 'Transcript read unavailable',
  ) {
    super(`${subject}: ${describeSearchReadRefusal(refusal)}`);
    this.name = 'SearchReadRefusedError';
  }
}
