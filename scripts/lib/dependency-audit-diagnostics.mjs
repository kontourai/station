import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_LINE = 2048;
const MAX_LINES = 16384;
const MAX_PROGRESS = 32;
const MAX_RECORD_BYTES = 16 * 1024;
const TIMERS = new Set([
  'npm:load',
  'arborist:ctor',
  'auditReport:getReport',
  'auditReport:init',
  'audit',
  'command:audit',
  'npm',
]);

/** Diagnostics only: no raw npm output, paths, URLs, or package names persist. */
export function createAuditAttemptDiagnostics({
  scope,
  reachability,
  attempt,
  outputRoot,
  timeoutMs,
}) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  let childStarted;
  const facts = {
    schemaVersion: 1,
    id,
    scope,
    reachability,
    attempt,
    startedAt,
    timeoutMs,
    parentNodeVersion: process.version,
    npmVersion: null,
    childNodeVersion: null,
    completedTimersMs: {},
    metavulnerability: {},
    bulkResponse: null,
    captureTruncated: false,
  };
  let privateLogs;
  let available = true;
  let progressWrites = 0;
  let line = '';
  let dropping = false;
  let lines = 0;
  const prefix = path.join(outputRoot, id);

  function warn() {
    if (available)
      console.warn(
        'Dependency audit diagnostics unavailable; audit verdict is unchanged',
      );
    available = false;
  }

  function persist(suffix, value) {
    if (!available) return;
    try {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > MAX_RECORD_BYTES)
        throw new Error('diagnostic bound');
      const target = `${prefix}.${suffix}.json`;
      const temporary = `${target}.tmp`;
      writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      warn();
    }
  }

  try {
    if (
      !['root', 'sdk', 'shared'].includes(scope) ||
      !['full', 'production'].includes(reachability) ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1
    )
      throw new Error('diagnostic identity');
    mkdirSync(outputRoot, { recursive: true });
    privateLogs = mkdtempSync(path.join(tmpdir(), 'station-dependency-audit-'));
    persist('started', { ...facts, state: 'started', complete: false });
  } catch {
    warn();
  }

  function acceptLine(value) {
    if (++lines > MAX_LINES) {
      facts.captureTruncated = true;
      return;
    }
    let changed = false;
    const version =
      /^npm info using (npm|node)@(v?\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(value);
    if (version) {
      const field = version[1] === 'npm' ? 'npmVersion' : 'childNodeVersion';
      if (facts[field] === null) {
        facts[field] = version[2];
        changed = true;
      }
    }
    const timer = /^npm timing ([^ ]+) Completed in (\d{1,9})ms$/.exec(value);
    if (timer) {
      const ms = Number(timer[2]);
      if (TIMERS.has(timer[1])) {
        if (!Object.hasOwn(facts.completedTimersMs, timer[1])) {
          facts.completedTimersMs[timer[1]] = ms;
          changed = true;
        }
      } else {
        const family =
          /^metavuln:(packument|calculate|cache:get|cache:put):/.exec(timer[1]);
        if (family) {
          const current = facts.metavulnerability[family[1]] ?? {
            count: 0,
            totalMs: 0,
            maxMs: 0,
          };
          current.count += 1;
          // The line/count/numeric bounds already keep this below 2^53;
          // retain that invariant even if a future parser widens them.
          const total = current.totalMs === null ? null : current.totalMs + ms;
          if (total === null || !Number.isSafeInteger(total)) {
            current.totalMs = null;
            facts.captureTruncated = true;
          } else current.totalMs = total;
          current.maxMs = Math.max(current.maxMs, ms);
          facts.metavulnerability[family[1]] = current;
          changed = true;
        }
      }
    }
    const http =
      /^npm http fetch POST ([1-5]\d{2}) ([^ ]+) (\d{1,9})ms(?: .*)?$/.exec(
        value,
      );
    if (http && facts.bulkResponse === null) {
      try {
        if (
          new URL(http[2]).pathname === '/-/npm/v1/security/advisories/bulk'
        ) {
          facts.bulkResponse = {
            endpoint: 'bulk-advisories',
            status: Number(http[1]),
            elapsedMs: Number(http[3]),
          };
          changed = true;
        }
      } catch {
        /* Not a recognized npm event; never retain it. */
      }
    }
    if (changed && progressWrites++ < MAX_PROGRESS) {
      persist('progress', { ...facts, state: 'incomplete', complete: false });
    }
  }

  return {
    startChild() {
      childStarted = performance.now();
    },
    // logs-max=0 disables debug logs. npm's exit-time timing file remains
    // private, is never read/uploaded, and is removed after actual settlement.
    args: privateLogs
      ? [
          '--timing',
          '--loglevel=info',
          '--logs-max=0',
          `--logs-dir=${privateLogs}`,
        ]
      : [],
    consume(chunk) {
      // Do not split or retain an unbounded line before checking its size.
      for (let offset = 0; offset < chunk.length; ) {
        const newline = chunk.indexOf('\n', offset);
        const end = newline < 0 ? chunk.length : newline;
        if (!dropping && line.length + end - offset <= MAX_LINE) {
          line += chunk.slice(offset, end);
        } else {
          dropping = true;
          facts.captureTruncated = true;
          line = '';
        }
        if (newline < 0) break;
        if (!dropping) acceptLine(line.replace(/\r$/, ''));
        line = '';
        dropping = false;
        offset = newline + 1;
      }
    },
    settle({ status, signal, operationalCode }) {
      if (line && !dropping) acceptLine(line);
      const allowedSignals = new Set([
        'SIGTERM',
        'SIGKILL',
        'SIGINT',
        'SIGABRT',
      ]);
      const allowedCodes = new Set([
        'ENOENT',
        'EACCES',
        'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      ]);
      persist('terminal', {
        ...facts,
        state: 'settled',
        complete: true,
        finishedAt: new Date().toISOString(),
        elapsedMs:
          childStarted === undefined ? null : performance.now() - childStarted,
        status: Number.isInteger(status) ? status : null,
        signal:
          signal === null
            ? null
            : allowedSignals.has(signal)
              ? signal
              : 'other',
        operationalCode: allowedCodes.has(operationalCode)
          ? operationalCode
          : typeof operationalCode === 'string'
            ? 'other'
            : null,
        phaseEvidence: 'completed-events-only; absent phases are unknown',
      });
      if (privateLogs) {
        try {
          rmSync(privateLogs, { recursive: true });
        } catch {
          console.warn('Dependency audit private timing cleanup unavailable');
        }
      }
    },
  };
}
