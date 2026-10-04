import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  compileStationDocs,
  STATION_DOCS_INPUT_PATHS,
} from './generate-station-docs.mjs';
import { evaluateDocumentationReview } from './lib/documentation-review.mjs';
import {
  createLearningSourceReader,
  isLearningSourcePath,
} from './lib/learning-source-reader.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
import { bindingFile, isBindingPath } from './lib/review-binding.mjs';
import {
  LEGACY_REVIEW_LEDGER,
  REVIEW_LEDGER_DIR,
  readGitObjects,
  readReviewState,
  readReviewStateAt,
} from './lib/review-ledger-store.mjs';

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
  if (ledger?.version !== 2 || !Array.isArray(ledger.records))
    throw new Error(
      'Documentation impact requires a compiled version 2 review ledger.',
    );
  const paths = new Set();
  for (const record of ledger.records) {
    if (
      !isLearningSourcePath(record.path) ||
      paths.has(record.path) ||
      !Array.isArray(record.sources) ||
      record.sources.some((source) => !isBindingPath(source.path))
    )
      throw new Error('Invalid documentation impact record.');
    paths.add(record.path);
  }
}

/**
 * Recorded dependencies are review leads, not a complete code import graph.
 * @param {{ changedPaths: string[], ledgers: unknown[], topics: { id: string, sourcePath: string }[] }} input
 */
export function documentationImpact({ changedPaths, ledgers, topics }) {
  const reverse = new Map();
  const records = new Map();
  for (const ledger of ledgers) {
    validateLedger(ledger);
    for (const record of ledger.records) {
      records.set(record.path, record);
      // A value binding (package.json#/scripts/x) is led by its file: the
      // report cannot tell which value a path change touched.
      for (const source of record.sources) {
        const file = bindingFile(source.path);
        const targets = reverse.get(file) ?? new Set();
        targets.add(record.path);
        reverse.set(file, targets);
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

function ledgerRevisionsSince(root, base) {
  return [
    base,
    ...git(root, [
      'log',
      '--format=%H',
      '--reverse',
      `${base}..HEAD`,
      '--',
      LEGACY_REVIEW_LEDGER,
      REVIEW_LEDGER_DIR,
    ])
      .split('\n')
      .filter(Boolean),
    'HEAD',
  ];
}

/** Compiled ledgers at each ref, in either storage layout. */
function historicalLedgers(root, refs) {
  return [...new Set(refs)].flatMap((ref) => {
    // Historical records supply dependency leads, not current review approval.
    // Their semantic bindings remain strict even if an intermediate commit was
    // reformatted; working-tree records and append-only notes retain byte checks.
    const { ledger } = readReviewStateAt(root, ref, {
      purpose: 'advisory-dependency-history',
    });
    if (!ledger) return [];
    validateLedger(ledger);
    return [ledger];
  });
}

/** @param {{ root?: string, changedPaths?: string[], mergeBase?: string }} [input] */
export function readDocumentationImpact({
  root = process.cwd(),
  changedPaths,
  mergeBase,
} = {}) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  const ledgers = mergeBase
    ? historicalLedgers(root, ledgerRevisionsSince(root, mergeBase))
    : [];
  ledgers.push(readReviewState(root).ledger);
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
          ...(report.catchUp.historyUnavailable
            ? [report.catchUp.historyUnavailable]
            : []),
          `  Catch-up since coverage baseline ${report.catchUp.coverageBase}: ${report.catchUp.staleReviews.length} stale reviews; ${report.catchUp.unchangedReviews} unchanged ordinary records; ${report.catchUp.generatedValidated.length} generated validations; ${report.catchUp.absentHistorical.length} absent historical notes.`,
          ...report.catchUp.generatedValidated.map(
            (entry) =>
              `  Generated validation: ${entry.path}; ${entry.validation.summary}`,
          ),
          ...report.catchUp.absentHistorical.map(
            (entry) =>
              `  Historical absence: ${entry.path}; ${entry.validation.summary}`,
          ),
          ...report.catchUp.staleReviews.map(
            (review) =>
              `  ${review.path}: changed inputs (reviewed at): ${review.changedInputs.map((input) => `${input} (${review.reviewedRevisions[input]})`).join(', ')}${review.unavailableRevisions.length ? `; unavailable locally, compare recorded hashes: ${review.unavailableRevisions.join(', ')}` : ''}; last committed page edit ${review.lastCommittedEdit ?? 'none'}`,
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

/** @param {{ root?: string, base?: string }} [input] */
export async function documentationCatchUp({
  root = process.cwd(),
  base,
} = {}) {
  const reader = createLearningSourceReader(root);
  const { ledger } = readReviewState(root);
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
  const selection = collectDocumentationChanges(
    root,
    ledger.historyUnavailable && base === undefined ? 'HEAD' : coverageBase,
  );
  const priorRecords = new Map();
  for (const previous of historicalLedgers(
    root,
    ledgerRevisionsSince(root, selection.mergeBase),
  )) {
    for (const record of previous.records) {
      const sources = priorRecords.get(record.path) ?? new Set();
      for (const source of record.sources) sources.add(source.path);
      priorRecords.set(record.path, sources);
    }
  }
  const currentRecords = new Map(
    ledger.records.map((record) => [record.path, record]),
  );
  const removedDependencies = [];
  for (const [path, previous] of priorRecords) {
    const current = currentRecords.get(path);
    const currentSources = new Set(
      current?.sources.map((source) => source.path),
    );
    // Narrowing a whole-file binding to values inside that file keeps
    // coverage of the file; it is not a removed dependency.
    const currentFiles = new Set(
      current?.sources.map((source) => bindingFile(source.path)),
    );
    const removed = [...previous].filter(
      (source) =>
        !currentSources.has(source) &&
        !(source === bindingFile(source) && currentFiles.has(source)),
    );
    if (!current || removed.length)
      removedDependencies.push({
        path,
        recordRemoved: !current,
        sourcesRemoved: removed,
      });
  }

  const captured = new Map();
  const readSource = (path) => {
    if (!captured.has(path)) captured.set(path, reader.read(path));
    return captured.get(path);
  };
  const tracked = new Set(
    git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter(Boolean),
  );
  const documents = new Map(
    ledger.records
      .filter((record) => reader.exists(record.path))
      .map((record) => [
        record.path,
        createHash('sha256').update(readSource(record.path)).digest('hex'),
      ]),
  );
  const reviews = [];
  const generatedValidated = [];
  const absentHistorical = [];
  const stalePaths = [];
  for (const record of ledger.records) {
    const evaluated = await evaluateDocumentationReview(
      record,
      documents,
      tracked,
      readSource,
      { reportMissing: true },
    );
    if (evaluated.state === 'generated-validated') {
      generatedValidated.push({
        path: record.path,
        state: evaluated.state,
        recordedState: evaluated.recordedState,
        observedChanges: evaluated.observedChanges,
        validation: evaluated.validation,
      });
    } else if (evaluated.state === 'absent-historical') {
      absentHistorical.push({
        path: record.path,
        state: evaluated.state,
        recordedState: evaluated.recordedState,
        validation: evaluated.validation,
      });
    }
    const changed = evaluated.changed;
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
    // Each input carries the revision its reviewed bytes were bound to.
    const reviewedRevisions = Object.fromEntries(
      sorted(changed).map((input) => [
        input,
        record.reviewBaseline ??
          (input === record.path
            ? record.documentRevision
            : record.sources.find((source) => source.path === input)?.revision),
      ]),
    );
    const revisions = [...new Set(Object.values(reviewedRevisions))];
    const available = readGitObjects(
      root,
      revisions.map((revision) => `${revision}^{commit}`),
    );
    reviews.push({
      path: record.path,
      reviewedRevisions,
      unavailableRevisions: revisions.filter(
        (_, index) => available[index] === undefined,
      ),
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
  const staleDocs = new Set([
    ...reviews.map((review) => review.path),
    ...removedDependencies.map((entry) => entry.path),
  ]);
  // Unchanged recorded bytes need no catch-up review merely because their history changed.
  report.documents = report.documents.filter(
    (doc) => staleDocs.has(doc.path) || doc.reviewState === 'unrecorded',
  );
  return {
    ...report,
    catchUp: {
      historyUnavailable: ledger.historyUnavailable,
      coverageBase: ledger.historyUnavailable
        ? coverageBase
        : selection.mergeBase,
      reviewedDocuments: ledger.records.length,
      staleReviews: reviews,
      generatedValidated,
      absentHistorical,
      removedDependencies,
      unchangedReviews:
        ledger.records.length -
        reviews.length -
        generatedValidated.length -
        absentHistorical.length,
      limits:
        'Review freshness is derived from source changes and covering notes in Git history (legacy records compare stored bytes); this is not a semantic rescan. Generated validation and absent historical notes use the shared review compiler rules; generated validation is not human review of new release claims, and note absence is not publication proof. Last committed edit excludes working-tree edits. The coverage baseline anchors history inspection, separately from the page edit commit. Unmapped changes are searched since coverageBase, including staged, unstaged and untracked files. Do not advance that baseline to hide unresolved coverage.',
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
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
    const report = await documentationCatchUp({ base });
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
    await main();
  } catch (error) {
    console.error(
      `documentation-impact: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 2;
  }
}
