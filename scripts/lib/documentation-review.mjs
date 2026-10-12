import { createHash } from 'node:crypto';
import {
  DEPLOY_LEDGER_JSON_PATH,
  DEPLOY_LEDGER_MD_PATH,
  entryIdentityKey,
  renderLedgerMarkdown,
  validateEntry,
} from '../deploy-ledger.mjs';
import {
  bindingDigest,
  bindingFile,
  isBindingPath,
} from './review-binding.mjs';
import { reviewError } from './review-ledger-store.mjs';

const deployLedgerOwners = [
  'scripts/deploy-ledger.mjs',
  'scripts/lib/documentation-review.mjs',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const text = (bytes) =>
  typeof bytes === 'string' ? bytes : utf8.decode(bytes);

const kinds = new Set([
  'current',
  'historical',
  'design',
  'policy',
  'release-note',
  'generated',
  'fixture',
]);
const states = new Set(['classified', 'partial', 'source-reviewed']);
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Missing review ${label}`);
}

function validateRecord(record, tracked, reportMissing) {
  if (typeof record?.path !== 'string' || !record.path)
    throw new Error('Missing reviewed document path');
  if (!kinds.has(record.kind) || !states.has(record.state))
    throw new Error(`Invalid review classification: ${record.path}`);
  if (
    record.historyChanges === undefined &&
    (!digestPattern.test(record.documentDigest) ||
      !revisionPattern.test(record.documentRevision))
  )
    throw new Error(`Invalid review identity: ${record.path}`);
  for (const field of ['summary', 'limits']) requireText(record[field], field);
  if (!Array.isArray(record.checks) || !Array.isArray(record.sources))
    throw new Error(`Missing review evidence arrays: ${record.path}`);
  for (const check of record.checks) requireText(check, 'check');
  if (record.state === 'source-reviewed' && !record.sources.length)
    throw new Error(`Source review has no code evidence: ${record.path}`);
  const sources = new Set();
  for (const source of record.sources) {
    if (
      !isBindingPath(source?.path) ||
      (!reportMissing && !tracked.has(bindingFile(source.path))) ||
      sources.has(source.path) ||
      (record.historyChanges === undefined &&
        (!digestPattern.test(source.digest) ||
          !revisionPattern.test(source.revision)))
    )
      throw new Error(
        `Invalid review source: ${record.path} -> ${source.path}`,
      );
    sources.add(source.path);
  }
}

function absentReleaseNote(record, documents, tracked) {
  return (
    !documents.has(record.path) &&
    !tracked.has(record.path) &&
    /^\.changeset\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(record.path) &&
    record.path.toLowerCase() !== '.changeset/readme.md' &&
    record.kind === 'release-note' &&
    record.state === 'classified' &&
    record.sources.length === 0 &&
    record.checks.length === 0
  );
}

/** The bytes a review record vouches for: its document and recorded sources. */
export function reviewInputs(record) {
  return [record.path, ...record.sources.map((source) => source.path)];
}

/**
 * Shared interpretation for strict builds and advisory catch-up reporting.
 * `requireFresh` is a boolean or the scoped decision from
 * `freshnessRequirement` in documentation-freshness.mjs.
 * @param {any} record
 * @param {Map<string, string>} documents
 * @param {Set<string>} tracked
 * @param {(path: string) => any} readSource
 * @param {{ requireFresh?: boolean | ((entry: { path: string, inputs: string[] }) => boolean), reportMissing?: boolean }} [options]
 */
export async function evaluateDocumentationReview(
  record,
  documents,
  tracked,
  readSource,
  { requireFresh = false, reportMissing = false } = {},
) {
  validateRecord(record, tracked, reportMissing);
  if (absentReleaseNote(record, documents, tracked))
    return {
      ...record,
      recordedState: record.state,
      state: 'absent-historical',
      changed: [],
      observedChanges: [record.path],
      validation: {
        kind: 'historical-absence',
        summary:
          'The classified note is absent; publication is not established.',
      },
    };
  if (!documents.has(record.path) && !reportMissing)
    throw new Error(`Unknown reviewed document: ${record.path}`);

  const captured = new Map();
  const read = async (path) => {
    if (!captured.has(path)) captured.set(path, await readSource(path));
    return captured.get(path);
  };
  const observedChanges = [];
  const missing = new Set();
  if (!documents.has(record.path)) missing.add(record.path);
  if (
    record.historyChanges === undefined &&
    documents.get(record.path) !== record.documentDigest
  )
    observedChanges.push(record.path);
  for (const source of record.sources) {
    const file = bindingFile(source.path);
    if (!tracked.has(file)) missing.add(source.path);
    let sourceDigest;
    if (!missing.has(source.path)) {
      try {
        sourceDigest = bindingDigest(source.path, await read(file));
      } catch (error) {
        if (!reportMissing || error?.code !== 'ENOENT') throw error;
        missing.add(source.path);
      }
    }
    if (
      missing.has(source.path) ||
      (record.historyChanges === undefined && sourceDigest !== source.digest)
    )
      observedChanges.push(source.path);
  }

  if (record.historyChanges !== undefined)
    observedChanges.splice(
      0,
      observedChanges.length,
      ...new Set([...record.historyChanges, ...missing]),
    );
  let changed = observedChanges;
  let validation;
  const generated =
    record.path === DEPLOY_LEDGER_MD_PATH &&
    record.kind === 'generated' &&
    record.state === 'source-reviewed';
  if (generated) {
    for (const path of [DEPLOY_LEDGER_JSON_PATH, ...deployLedgerOwners])
      if (!record.sources.some((source) => source.path === path))
        throw new Error(`Missing generated review source: ${path}`);
    changed = observedChanges.filter(
      (path) =>
        missing.has(path) ||
        (path !== record.path && path !== DEPLOY_LEDGER_JSON_PATH),
    );
    if (changed.length === 0) {
      const data = await read(DEPLOY_LEDGER_JSON_PATH);
      const entries = JSON.parse(text(data));
      if (!Array.isArray(entries))
        throw new Error('Generated deploy ledger must be an array');
      const identities = new Set();
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('Invalid generated deploy ledger entry');
        const result = validateEntry(entry);
        if (!result.ok)
          throw new Error(
            `Invalid generated deploy ledger entry: ${result.errors.join('; ')}`,
          );
        const identity = entryIdentityKey(entry);
        if (identities.has(identity))
          throw new Error(
            `Duplicate generated deploy ledger identity: ${identity}`,
          );
        identities.add(identity);
      }
      const markdown = text(await read(record.path));
      if (
        digest(markdown) !== documents.get(record.path) ||
        markdown !==
          renderLedgerMarkdown({ entries, githubRepo: 'kontourai/station' })
      )
        throw new Error(
          'Generated deploy ledger Markdown does not match its captured data',
        );
      validation = {
        kind: 'deploy-ledger-projection',
        dataPath: DEPLOY_LEDGER_JSON_PATH,
        dataDigest: digest(data),
        documentDigest: digest(markdown),
        entryCount: entries.length,
        summary:
          'Current data and projection validated; new release claims were not human-reviewed or independently verified.',
      };
    }
  }
  if (
    changed.length &&
    (typeof requireFresh === 'function'
      ? requireFresh({ path: record.path, inputs: reviewInputs(record) })
      : requireFresh)
  )
    throw reviewError(
      'needs-refresh',
      `Documentation review needs refresh: ${record.path}; changed: ${changed.join(', ')}`,
      { path: record.path, changed },
    );
  return {
    ...record,
    recordedState: record.state,
    state: changed.length
      ? 'needs-review'
      : generated
        ? 'generated-validated'
        : record.state,
    changed,
    observedChanges,
    ...(validation ? { validation } : {}),
  };
}

/**
 * @param {any} ledger
 * @param {Map<string, string>} documents
 * @param {Set<string>} tracked
 * @param {(path: string) => any} readSource
 * @param {{ requireFresh?: boolean | ((entry: { path: string, inputs: string[] }) => boolean), reportMissing?: boolean }} [options]
 * `reportMissing` reports an absent document or source as a changed input
 * instead of refusing the ledger, so the freshness policy decides it.
 */
export async function compileDocumentationReviews(
  ledger,
  documents,
  tracked,
  readSource,
  { requireFresh = false, reportMissing = false } = {},
) {
  if (ledger?.version !== 2 || !Array.isArray(ledger.records))
    throw new Error(
      'Documentation review ledger requires compiled version 2 records (scripts/lib/review-ledger-store.mjs).',
    );
  const seen = new Set();
  const captured = new Map();
  const read = async (path) => {
    if (!captured.has(path)) captured.set(path, await readSource(path));
    return captured.get(path);
  };
  const results = new Map();
  for (const record of ledger.records) {
    if (seen.has(record?.path))
      throw new Error(
        `Unknown or duplicate reviewed document: ${record?.path}`,
      );
    seen.add(record?.path);
    results.set(
      record?.path,
      await evaluateDocumentationReview(record, documents, tracked, read, {
        requireFresh,
        reportMissing,
      }),
    );
  }
  return results;
}
