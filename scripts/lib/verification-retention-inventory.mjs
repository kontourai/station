import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUEST_KEY_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_HANDOFF_STATES = new Set([
  'failed_to_start',
  'stale_before_execution',
  'settled',
]);
const COMPLETION_FENCE_DIRECTORIES = [
  'full-regression.lock',
  'full-regression.queue.lock',
];
export const TERMINAL_HANDOFF_GC_STATUS_FILE = 'terminal-handoff-gc.json';

/**
 * Intended limits for a future, separately-authorized verifier-artifact GC.
 * This module is inventory-only: it never removes, renames, or otherwise
 * mutates a record.
 */
export const DEFAULT_VERIFICATION_RETENTION_POLICY = Object.freeze({
  terminalTtlMs: 7 * 24 * 60 * 60_000,
  newestTerminal: 256,
  scanLimit: 512,
  removeLimit: 64,
});

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function inventoryScan(path, policy, scan) {
  try {
    const directories = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const truncated = directories.length > policy.scanLimit;
    if (truncated) scan.truncated = true;
    const names = directories.slice(0, policy.scanLimit);
    scan.scanned += names.length;
    return { names, truncated };
  } catch {
    return { names: [], truncated: false };
  }
}

function inventoryFiles(path, policy, scan) {
  try {
    const files = readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
    const truncated = files.length > policy.scanLimit;
    if (truncated) scan.truncated = true;
    const names = files.slice(0, policy.scanLimit);
    scan.scanned += names.length;
    return { names, truncated };
  } catch {
    return { names: [], truncated: false };
  }
}

function validStateRecord(record) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.state === 'string'
  );
}

function validTerminalHandoff(key, handoff) {
  return (
    validStateRecord(handoff) &&
    TERMINAL_HANDOFF_STATES.has(handoff.state) &&
    handoff.request !== null &&
    typeof handoff.request === 'object' &&
    handoff.request.key === key &&
    Number.isInteger(handoff.generation) &&
    handoff.generation >= 1 &&
    terminalTimestamp(handoff) !== null
  );
}

function terminalTimestamp(record) {
  const timestamp = record.updatedAt ?? record.finishedAt ?? record.createdAt;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function orderedTerminalRecords(records) {
  return [...records].sort(
    (left, right) =>
      (right.timestamp ?? Number.NEGATIVE_INFINITY) -
      (left.timestamp ?? Number.NEGATIVE_INFINITY),
  );
}

function addFenceRecord(summary, record) {
  summary.retained += 1;
  if (record.state === 'fenced') summary.fenced += 1;
  if (record.recoveryPending === true) summary.recoveryPending += 1;
}

function inspectLeaseDirectories({ root, name, policy, scan }) {
  const summary = { retained: 0, fenced: 0, recoveryPending: 0 };
  for (const entry of inventoryScan(join(root, name), policy, scan).names) {
    const lease = readJson(join(root, name, entry, 'lease.json'));
    if (!validStateRecord(lease)) {
      scan.invalidSkipped += 1;
      continue;
    }
    addFenceRecord(summary, lease);
  }
  return summary;
}

function inspectCompletionFences({ root, scan }) {
  const summary = { retained: 0, fenced: 0, recoveryPending: 0 };
  for (const name of COMPLETION_FENCE_DIRECTORIES) {
    const directory = join(root, name);
    if (!existsSync(directory)) continue;
    scan.scanned += 1;
    const lease = readJson(join(directory, 'lease.json'));
    if (!validStateRecord(lease)) {
      scan.invalidSkipped += 1;
      continue;
    }
    addFenceRecord(summary, lease);
  }
  return summary;
}

function inspectHandoffs({ root, policy, scan, terminalRecords }) {
  const summary = { launching: 0, coordinating: 0, retryClaims: 0 };
  const submissions = join(root, 'submissions');
  const entries = inventoryScan(submissions, policy, scan);
  for (const entry of entries.names) {
    if (entry.endsWith('.retry-claim')) {
      const claim = readJson(join(submissions, entry, 'lease.json'));
      if (claim?.owner && typeof claim.owner === 'object')
        summary.retryClaims += 1;
      else scan.invalidSkipped += 1;
      continue;
    }
    if (!REQUEST_KEY_PATTERN.test(entry)) {
      scan.invalidSkipped += 1;
      continue;
    }
    const handoff = readJson(join(submissions, entry, 'handoff.json'));
    if (!validStateRecord(handoff) || !handoff.request) {
      scan.invalidSkipped += 1;
      continue;
    }
    if (
      TERMINAL_HANDOFF_STATES.has(handoff.state) &&
      !validTerminalHandoff(entry, handoff)
    ) {
      scan.invalidSkipped += 1;
      continue;
    }
    if (handoff.state === 'launching') summary.launching += 1;
    if (handoff.state === 'coordinating') summary.coordinating += 1;
    if (validTerminalHandoff(entry, handoff))
      terminalRecords.push({
        key: entry,
        handoff,
        timestamp: terminalTimestamp(handoff),
      });
  }
  return { summary, complete: !entries.truncated };
}

function inspectOwnershipLoss({ root, policy, scan }) {
  let records = 0;
  for (const entry of inventoryFiles(join(root, 'ownership-loss'), policy, scan)
    .names) {
    if (
      !entry.endsWith('.json') ||
      !validStateRecord(readJson(join(root, 'ownership-loss', entry)))
    ) {
      scan.invalidSkipped += 1;
      continue;
    }
    records += 1;
  }
  return { records };
}

function normalizePolicy(policy) {
  return { ...DEFAULT_VERIFICATION_RETENTION_POLICY, ...policy };
}

function summarizeTerminalRecords(records, policy, now, complete) {
  const ordered = orderedTerminalRecords(records);
  const eligible = complete
    ? ordered.filter(
        ({ timestamp }, index) =>
          index >= policy.newestTerminal &&
          timestamp !== null &&
          now - timestamp >= policy.terminalTtlMs,
      ).length
    : null;
  return { retained: ordered.length, eligible, complete };
}

function terminalHandoffSnapshot({ root, now, policy: policyOverride }) {
  const policy = normalizePolicy(policyOverride);
  const scan = { scanned: 0, truncated: false, invalidSkipped: 0 };
  const terminalRecords = [];
  const handoffInventory = inspectHandoffs({
    root,
    policy,
    scan,
    terminalRecords,
  });
  return {
    policy,
    now,
    scan,
    terminalRecords,
    complete: handoffInventory.complete,
    handoffs: handoffInventory.summary,
  };
}

/**
 * Internal GC selection. Keys and handoff values never enter status output.
 */
export function terminalHandoffRetentionCandidates({
  root,
  now = Date.now(),
  policy: policyOverride,
} = {}) {
  const snapshot = terminalHandoffSnapshot({
    root,
    now,
    policy: policyOverride,
  });
  if (!snapshot.complete) return { ...snapshot, candidates: [] };
  const candidates = orderedTerminalRecords(snapshot.terminalRecords)
    .filter(
      ({ timestamp }, index) =>
        index >= snapshot.policy.newestTerminal &&
        timestamp !== null &&
        now - timestamp >= snapshot.policy.terminalTtlMs,
    )
    // The newest reservation is evaluated first; reclaim oldest eligible
    // records first so each bounded sweep converges retained disk usage.
    .reverse();
  return { ...snapshot, candidates };
}

export function terminalHandoffGCSummaryPath(root) {
  return join(root, TERMINAL_HANDOFF_GC_STATUS_FILE);
}

export function readTerminalHandoffGCSummary(root) {
  const value = readJson(terminalHandoffGCSummaryPath(root));
  if (
    !value ||
    !Number.isFinite(value.at) ||
    !Number.isInteger(value.removed) ||
    !Number.isInteger(value.skipped) ||
    typeof value.truncated !== 'boolean' ||
    typeof value.nonactionable !== 'boolean'
  )
    return null;
  return {
    at: value.at,
    removed: value.removed,
    skipped: value.skipped,
    truncated: value.truncated,
    nonactionable: value.nonactionable,
  };
}

/**
 * Returns only bounded aggregate counts. This is intentionally a side-effect
 * free planning signal; a future GC must have an explicit mutation contract.
 */
export function verificationRetentionInventory({
  root,
  now = Date.now(),
  policy: policyOverride,
} = {}) {
  const snapshot = terminalHandoffSnapshot({
    root,
    now,
    policy: policyOverride,
  });
  const requests = inspectLeaseDirectories({
    root,
    name: 'requests',
    policy: snapshot.policy,
    scan: snapshot.scan,
  });
  const outputs = inspectLeaseDirectories({
    root,
    name: 'outputs',
    policy: snapshot.policy,
    scan: snapshot.scan,
  });
  const completion = inspectCompletionFences({ root, scan: snapshot.scan });
  return {
    policy: snapshot.policy,
    terminal: summarizeTerminalRecords(
      snapshot.terminalRecords,
      snapshot.policy,
      now,
      snapshot.complete,
    ),
    handoffs: snapshot.handoffs,
    fences: { requests, outputs, completion },
    ownershipLoss: inspectOwnershipLoss({
      root,
      policy: snapshot.policy,
      scan: snapshot.scan,
    }),
    scan: snapshot.scan,
    lastSweep: readTerminalHandoffGCSummary(root),
  };
}
