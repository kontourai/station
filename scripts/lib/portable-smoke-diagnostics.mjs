// Failure diagnostics for scripts/smoke-portable-server-archive.mjs (#2805).
// A readiness timeout from `station start` says only that the server never
// answered; the reason is in the server's own log, which the smoke's work
// directory cleanup would otherwise delete unseen. Everything printed here is
// bounded: a command's output and each log are cut to their last characters.
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

export const DIAGNOSTIC_TAIL_CHARS = 16_000;
export const DIAGNOSTIC_MAX_LOG_FILES = 6;
// Deep enough for <home>/.station/instances/<channel>/logs and a temporary
// home's <home>/Temp/station/dev-home-*/logs; node_modules is never entered.
const LOG_SEARCH_DEPTH = 8;

/** A launch receipt names a single-use sign-in link; never echo the token. */
export function redact(text) {
  return String(text ?? '').replace(
    /(#station-ui-bootstrap=)[^\s]+/g,
    '$1<redacted>',
  );
}

/** The last `maxChars` characters of `text`, saying how much was cut. */
export function boundedTail(text, maxChars = DIAGNOSTIC_TAIL_CHARS) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `[... ${omitted} earlier characters omitted]\n${value.slice(omitted)}`;
}

/**
 * Why a launcher command failed, with its complete (bounded) stdout and
 * stderr. `result` is a spawnSync result; `timeoutMs` is the budget it ran
 * under, named when spawnSync killed it.
 */
export function describeCommandFailure(shown, result, timeoutMs) {
  let reason;
  if (result.error?.code === 'ETIMEDOUT') {
    reason = `timed out after ${timeoutMs}ms`;
  } else if (result.error) {
    reason = `could not run: ${result.error.message ?? result.error}`;
  } else if (result.signal) {
    reason = `was killed by ${result.signal}`;
  } else {
    reason = `exited ${result.status}`;
  }
  const section = (label, text) => {
    const body = redact(boundedTail(String(text ?? '').trimEnd()));
    return `--- ${label} ---\n${body || '<empty>'}`;
  };
  return [
    `station ${shown} ${reason}`,
    section('stdout', result.stdout),
    section('stderr', result.stderr),
  ].join('\n');
}

function isLogFile(name) {
  return /\.log(?:\.previous)?$/.test(name);
}

/**
 * Station log files (`<home>/logs/*.log`, including a rotated `.previous`)
 * beneath `roots`, newest first, at most `maxFiles`. A root that does not
 * exist, or an entry that cannot be read, is skipped: diagnostics must never
 * replace the failure they explain.
 */
export function findStationLogs(roots, maxFiles = DIAGNOSTIC_MAX_LOG_FILES) {
  const found = new Map();
  const visit = (directory, depth) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && depth < LOG_SEARCH_DEPTH) {
          visit(path, depth + 1);
        }
      } else if (
        entry.isFile() &&
        basename(directory) === 'logs' &&
        isLogFile(entry.name)
      ) {
        try {
          found.set(realpathSync(path), lstatSync(path).mtimeMs);
        } catch {
          // Gone between listing and stat: nothing to show.
        }
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return [...found]
    .sort(([, left], [, right]) => right - left)
    .slice(0, maxFiles)
    .map(([path]) => path);
}

/** The bounded tail of every Station log beneath `roots`, for a failed smoke. */
export function stationLogReport(roots, maxFiles = DIAGNOSTIC_MAX_LOG_FILES) {
  const logs = findStationLogs(roots, maxFiles);
  if (logs.length === 0) {
    return `no Station log files under ${[...roots].join(', ')}`;
  }
  return logs
    .map((path) => {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        text = `<unreadable: ${error?.message ?? error}>`;
      }
      return `--- ${path} ---\n${redact(boundedTail(text.trimEnd())) || '<empty>'}`;
    })
    .join('\n');
}
