import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileStationDocs,
  STATION_DOCS_INPUT_PATHS,
} from './generate-station-docs.mjs';
import {
  createLearningSourceReader,
  isLearningSourcePath,
} from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ledgerPath = 'docs/learn/review-ledger.json';
const sorted = (values) => [...new Set(values)].sort();

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function collectDocumentationChanges(root, base = 'origin/main') {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim();
  const changed = git(root, [
    'diff',
    '--no-renames',
    '--name-only',
    '-z',
    mergeBase,
    '--',
  ]);
  const untracked = git(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  return {
    mergeBase,
    paths: sorted(`${changed}${untracked}`.split('\0').filter(Boolean)),
  };
}

function validateLedger(ledger) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.records))
    throw new Error('Documentation impact requires a version 1 review ledger.');
  const paths = new Set();
  for (const record of ledger.records) {
    if (
      !isLearningSourcePath(record.path) ||
      paths.has(record.path) ||
      !Array.isArray(record.sources) ||
      record.sources.some((source) => !isLearningSourcePath(source.path))
    )
      throw new Error('Invalid documentation impact record.');
    paths.add(record.path);
  }
}

/** Recorded semantic dependencies are review leads, not a complete code import graph. */
export function documentationImpact({ changedPaths, ledgers, topics }) {
  const reverse = new Map();
  const records = new Map();
  for (const ledger of ledgers) {
    validateLedger(ledger);
    for (const record of ledger.records) {
      records.set(record.path, record);
      for (const source of record.sources) {
        const targets = reverse.get(source.path) ?? new Set();
        targets.add(record.path);
        reverse.set(source.path, targets);
      }
    }
  }
  const changed = sorted(changedPaths);
  const documents = new Map();
  const unmapped = [];
  for (const origin of changed) {
    const queue = [origin];
    const seen = new Set();
    let mapped = false;
    while (queue.length) {
      const path = queue.shift();
      if (seen.has(path)) continue;
      seen.add(path);
      if (path.endsWith('.md') || records.has(path)) {
        const reasons = documents.get(path) ?? new Set();
        reasons.add(origin);
        documents.set(path, reasons);
        mapped = true;
      }
      for (const target of reverse.get(path) ?? []) queue.push(target);
    }
    if (!mapped && !STATION_DOCS_INPUT_PATHS.includes(origin))
      unmapped.push(origin);
  }
  const affected = new Set([...changed, ...documents.keys()]);
  const mcpTopics = topics
    .filter((topic) => affected.has(topic.sourcePath))
    .map(({ id, sourcePath }) => ({ id, sourcePath }));
  const regenerateMcp = STATION_DOCS_INPUT_PATHS.some((path) =>
    affected.has(path),
  );
  return {
    version: 1,
    changedPaths: changed,
    documents: [...documents]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, reasons]) => ({
        path,
        changedBy: sorted(reasons),
        reviewState: records.get(path)?.state ?? 'unrecorded',
        scope: records.get(path)?.summary ?? 'No recorded claim review.',
      })),
    unmappedPaths: unmapped,
    mcpTopics,
    actions: [
      ...(documents.size
        ? [
            'Review affected claims and their real callers; update prose or record why it remains accurate.',
            'Rebuild the learning reader with npm run docs:learn:build after recording the review.',
          ]
        : []),
      ...(regenerateMcp
        ? [
            'Regenerate shipped MCP topics with npm run docs:mcp:generate after reviewing the canonical inputs.',
          ]
        : []),
      ...(unmapped.length
        ? [
            'Trace unmapped files through callers to their documentation owner; add missing source links or record a concrete no-impact reason in the PR.',
          ]
        : []),
      'Run npm run docs:truth:gate. Never refresh evidence hashes without reviewing the changed behavior.',
    ],
    limits:
      'Advisory dependency report, not semantic approval. Recorded document dependencies are followed transitively; arbitrary code imports, runtime dispatch and missing links are not inferred. Recorded review state is historical metadata, not a freshness verdict. A broad document such as the module map can conservatively select many topics.',
  };
}

function historicalLedgers(root, refs) {
  return [...new Set(refs)].flatMap((ref) => {
    const exists = git(root, [
      'ls-tree',
      '--name-only',
      ref,
      '--',
      ledgerPath,
    ]).trim();
    if (!exists) return [];
    const ledger = JSON.parse(git(root, ['show', `${ref}:${ledgerPath}`]));
    validateLedger(ledger);
    return [ledger];
  });
}

export function readDocumentationImpact({
  root = process.cwd(),
  changedPaths,
  mergeBase,
} = {}) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const ledgers = mergeBase ? historicalLedgers(root, [mergeBase, 'HEAD']) : [];
  ledgers.push(JSON.parse(read(ledgerPath)));
  const [manual, catalog, modules, atlas] = STATION_DOCS_INPUT_PATHS.map(read);
  const topics = compileStationDocs(
    manual,
    JSON.parse(catalog),
    modules,
    JSON.parse(atlas),
  );
  return documentationImpact({ changedPaths, ledgers, topics });
}

export function formatDocumentationImpact(report) {
  return [
    'Documentation impact — review leads from recorded source dependencies:',
    ...(report.catchUp
      ? [
          `  Catch-up since coverage baseline ${report.catchUp.coverageBase}: ${report.catchUp.staleReviews.length} stale reviews; ${report.catchUp.unchangedReviews} unchanged.`,
          ...report.catchUp.staleReviews.map(
            (review) =>
              `  ${review.path}: reviewed source ${review.reviewSourceRevision}${review.reviewRevisionAvailable ? '' : ' (commit unavailable locally; compare recorded hashes)'}; last committed page edit ${review.lastCommittedEdit ?? 'none'}; changed inputs: ${review.changedInputs.join(', ')}`,
          ),
          ...report.catchUp.removedDependencies.map(
            (entry) =>
              `  Removed review coverage: ${entry.path}; record removed: ${entry.recordRemoved}; source links removed: ${entry.sourcesRemoved.join(', ')}`,
          ),
          `  ${report.catchUp.limits}`,
        ]
      : []),
    ...report.documents.map(
      (doc) =>
        `  ${doc.path}\n    Affected by: ${doc.changedBy.join(', ')}\n    Recorded scope (${doc.reviewState}): ${doc.scope}`,
    ),
    ...(report.documents.length
      ? []
      : [
          '  No document dependencies found; this does not establish no documentation impact.',
        ]),
    ...(report.unmappedPaths.length
      ? [
          '  Unmapped paths (review coverage unknown):',
          ...report.unmappedPaths.map((path) => `    ${path}`),
        ]
      : []),
    ...(report.mcpTopics.length
      ? [
          `  Related shipped MCP topics: ${report.mcpTopics.map((topic) => topic.id).join(', ')}`,
        ]
      : []),
    ...report.actions.map((action) => `  ${action}`),
    `  Limits: ${report.limits}`,
  ].join('\n');
}

export function documentationCatchUp({ root = process.cwd(), base } = {}) {
  const reader = createLearningSourceReader(root);
  const ledger = JSON.parse(reader.read(ledgerPath).toString('utf8'));
  validateLedger(ledger);
  const coverageBase = base ?? ledger.coverageBaseline;
  if (
    !coverageBase ||
    !/^[a-zA-Z0-9_./-]+$/.test(coverageBase) ||
    coverageBase.startsWith('-')
  )
    throw new Error(
      'Catch-up requires --base=<ref> or a ledger coverageBaseline.',
    );
  const selection = collectDocumentationChanges(root, coverageBase);
  const priorRecords = new Map(
    historicalLedgers(root, [selection.mergeBase, 'HEAD'])
      .flatMap((previous) => previous.records)
      .map((record) => [record.path, record]),
  );
  const currentRecords = new Map(
    ledger.records.map((record) => [record.path, record]),
  );
  const removedDependencies = [];
  for (const [path, previous] of priorRecords) {
    const current = currentRecords.get(path);
    const currentSources = new Set(
      current?.sources.map((source) => source.path),
    );
    const removed = previous.sources.filter(
      (source) => !currentSources.has(source.path),
    );
    if (!current || removed.length)
      removedDependencies.push({
        path,
        recordRemoved: !current,
        sourcesRemoved: removed.map((source) => source.path),
      });
  }

  const digests = new Map();
  const digest = (path) => {
    if (!digests.has(path))
      digests.set(
        path,
        reader.exists(path)
          ? createHash('sha256').update(reader.read(path)).digest('hex')
          : null,
      );
    return digests.get(path);
  };
  const reviews = [];
  const stalePaths = [];
  for (const record of ledger.records) {
    if (
      !/^[a-f0-9]{40}$/.test(record.sourceRevision) ||
      !/^[a-f0-9]{64}$/.test(record.documentDigest) ||
      record.sources.some((source) => !/^[a-f0-9]{64}$/.test(source.digest))
    )
      throw new Error(`Invalid review identity: ${record.path}`);
    const inputs = [
      { path: record.path, digest: record.documentDigest },
      ...record.sources,
    ];
    const changed = inputs
      .filter((source) => digest(source.path) !== source.digest)
      .map((source) => source.path);
    if (!changed.length) continue;
    const lastEdit =
      git(root, [
        'log',
        '-1',
        '--format=%H',
        'HEAD',
        '--',
        record.path,
      ]).trim() || null;
    let reviewRevisionAvailable = true;
    try {
      git(root, ['cat-file', '-e', `${record.sourceRevision}^{commit}`]);
    } catch {
      reviewRevisionAvailable = false;
    }
    reviews.push({
      path: record.path,
      reviewRevisionAvailable,
      reviewSourceRevision: record.sourceRevision,
      lastCommittedEdit: lastEdit,
      changedInputs: sorted(changed),
    });
    stalePaths.push(...changed);
  }
  const report = readDocumentationImpact({
    root,
    changedPaths: sorted([...selection.paths, ...stalePaths]),
    mergeBase: selection.mergeBase,
  });
  const staleDocs = new Set(reviews.map((review) => review.path));
  // Unchanged recorded bytes need no catch-up review merely because their history changed.
  report.documents = report.documents.filter(
    (doc) => staleDocs.has(doc.path) || doc.reviewState === 'unrecorded',
  );
  report.catchUp = {
    coverageBase: selection.mergeBase,
    reviewedDocuments: ledger.records.length,
    staleReviews: reviews,
    removedDependencies,
    unchangedReviews: ledger.records.length - reviews.length,
    limits:
      'Hashes compare only recorded document/source bytes; this is not a semantic rescan. Last committed edit excludes working-tree edits. The review source revision plus recorded hashes identifies the prior evidence; it is distinct from the page edit commit. Unmapped changes are searched since coverageBase, including staged, unstaged and untracked files. Do not advance that baseline to hide unresolved coverage.',
  };
  return report;
}

export function main(argv = process.argv.slice(2)) {
  let base;
  let json = false;
  let catchUp = false;
  const explicit = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--catch-up') catchUp = true;
    else if (arg.startsWith('--base=')) base = arg.slice(7);
    else if (arg === '--base') {
      base = argv[++i];
      if (!base) throw new Error('--base requires a Git ref');
    } else if (arg.startsWith('--'))
      throw new Error(`Unknown documentation-impact option: ${arg}`);
    else explicit.push(arg);
  }
  if (base !== undefined && (!base || base.startsWith('-')))
    throw new Error('--base requires a Git ref');
  if (catchUp && explicit.length)
    throw new Error('--catch-up cannot be combined with explicit paths');
  if (catchUp) {
    const report = documentationCatchUp({ base });
    process.stdout.write(
      `${json ? JSON.stringify(report, null, 2) : formatDocumentationImpact(report)}\n`,
    );
    return;
  }
  const selection = explicit.length
    ? { paths: explicit }
    : collectDocumentationChanges(process.cwd(), base ?? 'origin/main');
  const report = readDocumentationImpact({
    changedPaths: selection.paths,
    mergeBase: selection.mergeBase,
  });
  process.stdout.write(
    `${json ? JSON.stringify(report, null, 2) : formatDocumentationImpact(report)}\n`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `documentation-impact: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}
