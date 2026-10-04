import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import {
  extractModules,
  validateCatalog,
} from '../../scripts/lib/documentation-model.mjs';
import { renderLearningDocument } from '../../scripts/lib/learning-markdown.mjs';
import { createLearningSourceReader } from '../../scripts/lib/learning-source-reader.mjs';
import {
  bindingDigest,
  bindingFile,
} from '../../scripts/lib/review-binding.mjs';
import {
  parseRecordFile,
  REVIEW_LEDGER_INDEX,
  REVIEW_LEDGER_VERSION,
  recordFile,
} from '../../scripts/lib/review-ledger-store.mjs';

export const GRAPH_SCHEMA = 'station.repository-knowledge-graph/v1';
export const GRAPH_AGENT = 'station.repository-knowledge-graph';
export const GRAPH_LIMITS = Object.freeze({
  records: 2500,
  edges: 15000,
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 12 * 1024 * 1024,
});
const INPUTS = [
  'docs/learn/atlas.json',
  'docs/architecture/module-map.md',
  REVIEW_LEDGER_INDEX,
];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const allowed = (path) =>
  /^(?:docs|src-server|src-ui|src-shared|src-desktop|packages|tests|scripts|examples)\//.test(
    path,
  ) && !path.split('/').some((part) => part.startsWith('.'));
const isTest = (path) =>
  /(?:__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(path);
const safeExcerpt = (value) => value.replaceAll('[[', '&#91;[').slice(0, 1600);

function moduleSections(source) {
  const headings = [];
  const text = (node) => node.value ?? (node.children ?? []).map(text).join('');
  const capture = () => (tree) => {
    for (const node of tree.children) {
      if (node.type === 'heading' && node.depth === 2)
        headings.push({
          title: text(node),
          start: node.position.start.offset,
          end: node.position.end.offset,
        });
    }
  };
  renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [capture] }, source),
  );
  const sections = new Map(
    headings.map((heading, index) => [
      heading.title,
      source.slice(heading.end, headings[index + 1]?.start ?? source.length),
    ]),
  );
  if (sections.size !== headings.length)
    throw new Error('Duplicate module-map section.');
  return sections;
}

function git(root, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return execFileSync('git', ['--no-replace-objects', ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** Snapshot public, tracked references. Edges describe documentation, not inferred code calls. */
export function exportRepositoryKnowledge({ root = process.cwd() } = {}) {
  root = realpathSync(root);
  if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root)
    throw new Error('Select the repository root, not a subdirectory.');
  const revision = git(root, ['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error('Expected a full Git revision.');
  const tracked = new Set(
    git(root, ['ls-files', '-z']).split('\0').filter(Boolean),
  );
  const committed = new Map(
    git(root, ['ls-tree', '-r', '-z', revision])
      .split('\0')
      .flatMap((entry) => {
        const match = /^\d+ blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
        return match ? [[match[2], match[1]]] : [];
      }),
  );
  const reader = createLearningSourceReader(root);
  const observations = new Map();
  const omitted = new Set();
  const read = (path, required = false) => {
    if (!required && observations.has(path)) return undefined;
    if (!tracked.has(path) || !allowed(path)) {
      if (required)
        throw new Error(`Required tracked input unavailable: ${path}`);
      omitted.add(path);
      return undefined;
    }
    if (!reader.exists(path)) {
      observations.set(path, { path, availability: 'missing' });
      if (required) throw new Error(`Required input missing: ${path}`);
      return undefined;
    }
    const stat = lstatSync(resolve(root, path));
    if (!stat.isFile()) return undefined;
    if (stat.size > GRAPH_LIMITS.inputBytes)
      throw new Error(`Input exceeds byte limit: ${path}`);
    const bytes = reader.read(path);
    observations.set(path, {
      path,
      availability: 'present',
      digest: hash(bytes),
      existsAtRevision: committed.has(path),
      matchesRevision:
        committed.get(path) ===
        createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex'),
    });
    return bytes.toString('utf8');
  };
  const [atlasText, moduleText, ledgerText] = INPUTS.map((path) =>
    read(path, true),
  );
  const atlas = JSON.parse(atlasText);
  if (
    atlas.version !== 1 ||
    !Array.isArray(atlas.groups) ||
    ![REVIEW_LEDGER_VERSION, 3].includes(JSON.parse(ledgerText).version)
  )
    throw new Error('Unsupported atlas or review ledger.');
  // One record file per document (scripts/lib/review-ledger-store.mjs); each
  // one read is an observed input of this snapshot.
  const reviewCache = new Map();
  const review = (path) => {
    if (!reviewCache.has(path)) {
      const file = recordFile(path);
      const text = tracked.has(file) ? read(file) : undefined;
      reviewCache.set(
        path,
        text === undefined ? undefined : parseRecordFile(file, text),
      );
    }
    return reviewCache.get(path);
  };
  const modules = atlas.groups.flatMap((group) => group.modules ?? []);
  if (
    !modules.length ||
    modules.some((name) => typeof name !== 'string') ||
    new Set(modules).size !== modules.length
  )
    throw new Error('Atlas module identities must be unique.');
  const sections = moduleSections(moduleText);
  validateCatalog(atlas, extractModules(moduleText), tracked);
  const nodes = new Map();
  const edges = new Map();
  const documents = new Set();
  const add = (key, node) => {
    if (!nodes.has(key)) nodes.set(key, { key, ...node });
    if (nodes.size > GRAPH_LIMITS.records)
      throw new Error('Graph record limit exceeded.');
    return key;
  };
  const edge = (source, target, kind, label = kind) => {
    edges.set(JSON.stringify([source, target, kind, label]), {
      source,
      target,
      kind,
      label,
    });
    if (edges.size > GRAPH_LIMITS.edges)
      throw new Error('Graph edge limit exceeded.');
  };
  const fileNode = (path) => {
    if (!tracked.has(path) || !allowed(path)) {
      omitted.add(path);
      return undefined;
    }
    read(path);
    const observation = observations.get(path);
    if (!observation) return undefined;
    const kind = path.endsWith('.md')
      ? 'document'
      : isTest(path)
        ? 'test'
        : 'source';
    if (kind === 'document') documents.add(path);
    return add(`file:${path}`, {
      kind,
      title: path,
      path,
      observation,
      reviewState: review(path)?.state ?? 'unrecorded',
    });
  };
  const fileSet = new Set([...tracked].filter((path) => path.endsWith('.md')));
  const moduleDocument = fileNode(INPUTS[1]);
  const allHeadings = renderLearningDocument(
    moduleText,
    INPUTS[1],
    fileSet,
    revision,
    tracked,
  ).headings;
  for (const group of atlas.groups) {
    const groupKey = add(`group:${group.id}`, {
      kind: 'subsystem',
      title: group.title,
      purpose: safeExcerpt(group.summary ?? ''),
    });
    for (const path of group.docs ?? []) {
      const target = fileNode(path.split('#')[0]);
      if (target) edge(groupKey, target, 'reading-path');
    }
    for (const name of group.modules ?? []) {
      const body = sections.get(name);
      if (body === undefined)
        throw new Error(`Atlas module has no canonical section: ${name}`);
      const heading = allHeadings.find(
        (item) => item.level === 2 && item.title === name,
      );
      if (!heading) throw new Error(`Module heading was not rendered: ${name}`);
      const key = add(`module:${name}`, {
        kind: 'module',
        title: name,
        path: INPUTS[1],
        fragment: heading.id,
        purpose: safeExcerpt(body.trim().split('\n\n')[0]),
        rationale:
          'Historical reason for addition is unknown unless established by the linked canonical decisions. The excerpt states documented purpose, not inferred intent.',
      });
      edge(groupKey, key, 'contains-module');
      edge(key, moduleDocument, 'documented-in');
      const rendered = renderLearningDocument(
        body,
        INPUTS[1],
        fileSet,
        revision,
        tracked,
      );
      for (const link of rendered.links) {
        const destination = link.destination;
        if (destination.kind === 'local') {
          const target = fileNode(destination.file);
          if (target)
            edge(
              key,
              target,
              isTest(destination.file)
                ? 'references-test'
                : destination.file.endsWith('.md')
                  ? 'references-document'
                  : 'references-source',
            );
        } else if (
          destination.kind === 'external' &&
          /^https:\/\/github\.com\/kontourai\/station(?:-archive)?\/(?:issues|pull)\/\d+$/.test(
            destination.href,
          )
        ) {
          const target = add(`reference:${destination.href}`, {
            kind: 'decision-reference',
            title: destination.href.split('/').slice(-3).join('/'),
            url: destination.href,
            rationale:
              'Referenced by the canonical section; remote content and historical intent were not fetched or verified by this export.',
          });
          edge(key, target, 'references-decision');
        } else if (destination.kind === 'external')
          omitted.add(`external:${destination.href}`);
      }
      // A literal complete tracked path is a reference; an ambiguous basename is not guessed.
      for (const match of body.matchAll(/`([^`\n]+)`/g)) {
        const path = match[1];
        if (!path.includes('/') || !tracked.has(path)) continue;
        const target = fileNode(path);
        if (target)
          edge(
            key,
            target,
            isTest(path)
              ? 'references-test'
              : path.endsWith('.md')
                ? 'references-document'
                : 'references-source',
          );
      }
    }
  }
  // These dependencies belong to the whole reviewed document, never each module within it.
  for (const path of [...documents].sort()) {
    const record = review(path);
    if (!record) continue;
    const node = nodes.get(`file:${path}`);
    node.reviewDigest = record.document?.digest;
    node.reviewComparison = !record.document
      ? 'history-derived-not-judged-by-export'
      : node.observation.digest === record.document.digest
        ? 'matches-recorded-digest'
        : 'changed-since-recorded-review';
    for (const dependency of record.sources) {
      const source =
        typeof dependency === 'string' ? { path: dependency } : dependency;
      if (typeof source.path !== 'string')
        throw new Error('Malformed review source.');
      // A value binding (package.json#/scripts/x) depends on its file.
      const file = bindingFile(source.path);
      const target = fileNode(file);
      if (!target) continue;
      const observed = observations.get(file);
      const current =
        file === source.path
          ? observed?.digest
          : observed?.availability === 'present'
            ? bindingDigest(source.path, reader.read(file))
            : undefined;
      const comparison = !record.document
        ? 'recorded-dependency'
        : current === source.digest
          ? 'matches-recorded-digest'
          : 'changed-or-missing';
      edge(
        `file:${path}`,
        target,
        'review-dependency',
        `Whole-document review dependency: ${comparison}`,
      );
    }
  }
  const inputs = [...observations.values()].sort((a, b) =>
    compare(a.path, b.path),
  );
  for (const input of inputs) {
    if (input.availability === 'missing' && reader.exists(input.path))
      throw new Error(`Input appeared during export: ${input.path}`);
    if (
      input.availability === 'present' &&
      hash(reader.read(input.path)) !== input.digest
    )
      throw new Error(`Input changed during export: ${input.path}`);
  }
  const inputDigest = hash(JSON.stringify({ revision, inputs }));
  const identities = new Map(
    [...nodes.keys()].map((key) => [
      key,
      `repo-${hash(`${inputDigest}\0${key}`).slice(0, 40)}`,
    ]),
  );
  const records = [...nodes.values()]
    .sort((a, b) => compare(a.key, b.key))
    .map((node) => {
      const links = [...edges.values()]
        .filter((item) => item.source === node.key)
        .sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
        .map((item) => ({
          target_id: identities.get(item.target),
          kind: item.kind,
          label: item.label,
        }));
      const url =
        node.url ??
        (node.path && committed.has(node.path)
          ? `https://github.com/kontourai/station/blob/${revision}/${node.path}${node.fragment ? `#${node.fragment}` : ''}`
          : undefined);
      return {
        id: identities.get(node.key),
        type:
          node.kind === 'module' || node.kind === 'subsystem'
            ? 'concept'
            : 'raw',
        title: node.title,
        category: `repository.${node.kind}`,
        tags: [
          'repository-derived',
          node.kind,
          `snapshot-${inputDigest.slice(0, 16)}`,
        ],
        body: [
          `Derived repository snapshot at Git HEAD ${revision}; working files were hashed independently. A matching hash is not semantic approval.`,
          url
            ? `${node.path ? 'Committed counterpart (working bytes may differ)' : 'Canonical reference'}: ${url}`
            : node.path
              ? `Working source: ${node.path}; not present at the recorded Git revision.`
              : '',
          node.purpose
            ? `Documented purpose (attributed excerpt):\n\n${node.purpose}`
            : '',
          node.rationale ?? '',
          node.observation
            ? `Source observation: ${JSON.stringify(node.observation)}`
            : '',
          node.reviewComparison
            ? `Recorded whole-document review: ${node.reviewState}; ${node.reviewComparison}. The scope is not per-module certification.`
            : '',
          node.kind === 'test'
            ? 'This is a test reference, not evidence that the test passed or ran for this snapshot.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        links,
        provenance: {
          agent: GRAPH_AGENT,
          note: JSON.stringify({
            schemaVersion: GRAPH_SCHEMA,
            revision,
            inputDigest,
            key: node.key,
            derived: true,
          }),
        },
      };
    });
  const snapshot = {
    schemaVersion: GRAPH_SCHEMA,
    revision,
    inputDigest,
    payloadDigest: hash(JSON.stringify(records)),
    inputs,
    counts: {
      modules: modules.length,
      records: records.length,
      edges: edges.size,
      omittedReferences: omitted.size,
    },
    records,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > GRAPH_LIMITS.outputBytes)
    throw new Error('Graph output byte limit exceeded.');
  return snapshot;
}

export function validateKnowledgeSnapshot(value) {
  if (
    value?.schemaVersion !== GRAPH_SCHEMA ||
    !/^[a-f0-9]{64}$/.test(value.inputDigest) ||
    !/^[a-f0-9]{40}$/.test(value.revision) ||
    !Array.isArray(value.records) ||
    value.records.length === 0 ||
    value.records.length > GRAPH_LIMITS.records
  )
    throw new Error('Invalid repository knowledge snapshot.');
  if (
    !Array.isArray(value.inputs) ||
    value.inputDigest !==
      hash(JSON.stringify({ revision: value.revision, inputs: value.inputs }))
  )
    throw new Error('Snapshot input digest mismatch.');
  const paths = new Set();
  for (const input of value.inputs) {
    if (
      typeof input.path !== 'string' ||
      !allowed(input.path) ||
      paths.has(input.path) ||
      !['missing', 'present'].includes(input.availability) ||
      (input.availability === 'present' &&
        (!/^[a-f0-9]{64}$/.test(input.digest) ||
          typeof input.existsAtRevision !== 'boolean' ||
          typeof input.matchesRevision !== 'boolean'))
    )
      throw new Error('Invalid snapshot input observation.');
    paths.add(input.path);
  }
  if (INPUTS.some((path) => !paths.has(path)))
    throw new Error('Snapshot required input missing.');
  if (value.payloadDigest !== hash(JSON.stringify(value.records)))
    throw new Error('Snapshot payload digest mismatch.');
  const ids = new Set();
  let edges = 0;
  for (const record of value.records) {
    if (
      !/^repo-[a-f0-9]{40}$/.test(record.id) ||
      ids.has(record.id) ||
      !['concept', 'raw'].includes(record.type) ||
      !record.title ||
      typeof record.body !== 'string' ||
      !record.body ||
      record.body.includes('[[') ||
      !record.category?.startsWith('repository.') ||
      record.provenance?.agent !== GRAPH_AGENT ||
      !Array.isArray(record.links)
    )
      throw new Error('Invalid derived record.');
    const note = JSON.parse(record.provenance.note);
    if (
      note.inputDigest !== value.inputDigest ||
      note.revision !== value.revision ||
      note.schemaVersion !== GRAPH_SCHEMA ||
      note.derived !== true ||
      typeof note.key !== 'string' ||
      record.id !==
        `repo-${hash(`${value.inputDigest}\0${note.key}`).slice(0, 40)}`
    )
      throw new Error('Derived record provenance mismatch.');
    ids.add(record.id);
    edges += record.links.length;
  }
  if (
    edges > GRAPH_LIMITS.edges ||
    Buffer.byteLength(JSON.stringify(value)) > GRAPH_LIMITS.outputBytes
  )
    throw new Error('Snapshot limit exceeded.');
  if (
    value.counts?.records !== value.records.length ||
    value.counts?.edges !== edges ||
    value.counts?.modules !==
      value.records.filter((record) => record.category === 'repository.module')
        .length ||
    !Number.isSafeInteger(value.counts?.omittedReferences) ||
    value.counts.omittedReferences < 0
  )
    throw new Error('Snapshot counts do not match its records.');
  for (const record of value.records)
    for (const link of record.links)
      if (
        !ids.has(link.target_id) ||
        typeof link.kind !== 'string' ||
        !link.kind ||
        typeof link.label !== 'string'
      )
        throw new Error('Snapshot contains an unresolved edge.');
  return value;
}
