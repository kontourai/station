/**
 * Shared per-invocation settings collection for `station chat`
 * (`session-client.ts`) and `station delegate` (`delegate.ts`) — station#978.
 *
 * `--approval-mode=<v>` (contracts `APPROVAL_MODES`), `--effort=<v>`,
 * `--thinking=<true|false>`, and repeated `--model-option key=value` all
 * merge into one `modelOptions` bag; `--cwd=<path>` is collected alongside
 * it since both flow into the same `startSession`/`sendTurn` call sites.
 *
 * Precedence (AC7): `--model-option` entries are merged first, then the
 * four named flags are applied on top — a named flag always wins a key
 * collision with `--model-option` (e.g. `--effort=high --model-option
 * effort=low` sends `effort: 'high'`).
 *
 * Value validation is deliberately narrow: only `--approval-mode`'s value is
 * checked, against the contracts `ApprovalMode` vocabulary (AC5) — every
 * other key's *support* (not its value shape) is the server's
 * `PROVIDER_MODEL_OPTION_SUPPORT` to enforce (`unsupportedModelOptionKeys`),
 * not the CLI's. Duplicating provider-specific value knowledge here would
 * defeat non-CLI callers hitting the same server routes (plan stop-short
 * risk).
 */
import {
  APPROVAL_MODES,
  isApprovalMode,
} from '@kontourai/station-contracts/provider';
import { optionalValueFlag, type ParsedCoreArgs } from './core-api.js';

/**
 * `--on-request=wait|fail` (station#979): governs what `station chat` and
 * `station delegate` do when the target opens a pending request (approval/
 * permission/confirmation/input) mid-turn instead of hanging silently.
 * `wait` (default) keeps today's behavior — the caller still waits for the
 * request to be resolved out-of-band — but a notice naming the pending
 * request is now printed instead of nothing. `fail` stops waiting and exits
 * with `EXIT_ON_REQUEST_FAIL` instead, leaving the session/task alive and
 * resumable (never torn down just because a request is open).
 */
export type OnRequestMode = 'wait' | 'fail';

/**
 * Exit code for `--on-request=fail`. Named and shared here (rather than two
 * independently hardcoded literals) so `station chat`'s session-client.ts
 * and `station delegate`'s own exit-code classifier (2=transport,
 * 3=rejection in `delegate.ts`'s `handleDelegateFailure`) agree on the same
 * documented number for this case.
 */
export const EXIT_ON_REQUEST_FAIL = 4;

/**
 * Reads `--on-request=<wait|fail>` off an already-parsed command line,
 * defaulting to `'wait'`. Throws a usage error (caller's ordinary exit-1
 * path, before any request) for an invalid value — same convention as
 * `collectModelOptions`' `--approval-mode` check.
 */
export function resolveOnRequestMode(parsed: ParsedCoreArgs): OnRequestMode {
  const raw = optionalValueFlag(parsed, 'on-request') ?? 'wait';
  if (raw !== 'wait' && raw !== 'fail') {
    throw new Error(`--on-request must be 'wait' or 'fail' (got "${raw}").`);
  }
  return raw;
}

export interface CollectedModelOptions {
  modelOptions?: Record<string, unknown>;
  cwd?: string;
}

function coerceBooleanFlagValue(
  flagName: string,
  value: string | boolean,
): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${flagName} must be true or false (got "${value}").`);
}

/**
 * `--model-option key=value` values are always raw argv strings; coerce the
 * two literal boolean spellings so a key like `fastMode`/`autoMode` (read by
 * `typeof options?.fastMode === 'boolean'` in claude-adapter.ts) actually
 * applies instead of being silently ignored as a non-boolean. Everything
 * else stays a string — no numeric auto-coercion, since no known option key
 * takes a number today and guessing would surprise a future string value
 * that happens to look numeric.
 */
function coerceModelOptionValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

/**
 * Reads `--approval-mode`/`--effort`/`--thinking`/`--cwd` plus repeated
 * `--model-option key=value` flags off an already-parsed command line.
 * Throws a usage error (caller's ordinary exit-1 path, before any request)
 * for an invalid `--approval-mode` value, a valueless `--effort`/`--cwd`, a
 * non-boolean `--thinking`, or a malformed `--model-option` (missing `=`).
 */
export function collectModelOptions(
  parsed: ParsedCoreArgs,
): CollectedModelOptions {
  const modelOptions: Record<string, unknown> = {};

  for (const raw of parsed.repeatedFlags['model-option'] ?? []) {
    const equalsIndex = raw.indexOf('=');
    if (equalsIndex <= 0) {
      throw new Error(
        `--model-option requires key=value (got "--model-option=${raw}").`,
      );
    }
    const key = raw.slice(0, equalsIndex);
    modelOptions[key] = coerceModelOptionValue(raw.slice(equalsIndex + 1));
  }

  const approvalMode = parsed.flags['approval-mode'];
  if (approvalMode !== undefined) {
    if (typeof approvalMode !== 'string' || !isApprovalMode(approvalMode)) {
      throw new Error(
        `--approval-mode must be one of: ${APPROVAL_MODES.join(', ')} (got "${String(approvalMode)}").`,
      );
    }
    modelOptions.approvalMode = approvalMode;
  }

  const effort = parsed.flags.effort;
  if (effort !== undefined) {
    if (typeof effort !== 'string' || effort.trim().length === 0) {
      throw new Error('--effort requires a non-empty value.');
    }
    modelOptions.effort = effort;
  }

  const thinking = parsed.flags.thinking;
  if (thinking !== undefined) {
    modelOptions.thinking = coerceBooleanFlagValue('--thinking', thinking);
  }

  const cwd = parsed.flags.cwd;
  if (
    cwd !== undefined &&
    (typeof cwd !== 'string' || cwd.trim().length === 0)
  ) {
    throw new Error('--cwd requires a non-empty value.');
  }

  return {
    ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
  };
}
