import { createHash } from 'node:crypto';

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

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`Missing review ${label}`);
}

function validateRecord(record, documents, tracked, seen) {
  if (!documents.has(record?.path) || seen.has(record.path))
    throw new Error(`Unknown or duplicate reviewed document: ${record?.path}`);
  seen.add(record.path);
  if (!kinds.has(record.kind) || !states.has(record.state))
    throw new Error(`Invalid review classification: ${record.path}`);
  if (
    !digestPattern.test(record.documentDigest) ||
    !/^[a-f0-9]{40}$/.test(record.sourceRevision)
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
      !tracked.has(source.path) ||
      sources.has(source.path) ||
      !digestPattern.test(source.digest)
    )
      throw new Error(
        `Invalid review source: ${record.path} -> ${source.path}`,
      );
    sources.add(source.path);
  }
}

export async function compileDocumentationReviews(
  ledger,
  documents,
  tracked,
  readSource,
  { requireFresh = false } = {},
) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.records))
    throw new Error('Documentation review ledger requires version 1 records.');
  const seen = new Set();
  const digests = new Map();
  const results = new Map();
  for (const record of ledger.records) {
    validateRecord(record, documents, tracked, seen);
    const changed = [];
    if (documents.get(record.path) !== record.documentDigest)
      changed.push(record.path);
    for (const source of record.sources) {
      if (!digests.has(source.path))
        digests.set(
          source.path,
          createHash('sha256')
            .update(await readSource(source.path))
            .digest('hex'),
        );
      if (digests.get(source.path) !== source.digest) changed.push(source.path);
    }
    if (requireFresh && changed.length)
      throw new Error(
        `Documentation review needs refresh: ${record.path}; changed: ${changed.join(', ')}`,
      );
    results.set(record.path, {
      ...record,
      recordedState: record.state,
      state: changed.length ? 'needs-review' : record.state,
      changed,
    });
  }
  return results;
}
