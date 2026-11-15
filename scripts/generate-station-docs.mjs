import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleDigest, bundleShapeError } from '@kontourai/corpus';
import {
  documentSections,
  extractModules,
  headingId,
  validateCatalog,
} from './lib/documentation-model.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = 'src-server/tools/station-docs-content.ts';

/**
 * The sources compileStationDocs reads, in its argument order. Callers that
 * need only the topics (documentation-impact.mjs maps changed sources to topic
 * ids) read these and nothing else.
 */
export const STATION_DOCS_TOPIC_INPUT_PATHS = Object.freeze([
  'docs/reference/station-docs.md',
  'docs/learn/mcp-topics.json',
  'docs/architecture/module-map.md',
  'docs/learn/atlas.json',
]);

/** Every input of the shipped bundle: a change to any of them means regenerating it. */
export const STATION_DOCS_INPUT_PATHS = Object.freeze([
  ...STATION_DOCS_TOPIC_INPUT_PATHS,
  // Bundle identity (product, title, purpose, builtOn) and search synonyms.
  // Required: a bundle without it would ship without its identity.
  'corpus.json',
]);

export function compileStationDocs(manual, catalog, moduleSource, atlas) {
  if (
    catalog?.version !== 1 ||
    !Array.isArray(catalog.topics) ||
    catalog.source !== 'docs/reference/station-docs.md'
  )
    throw new Error('Invalid shipped-documentation catalog.');
  const bodies = new Map();
  for (const { title, body } of documentSections(manual)) {
    if (bodies.has(title))
      throw new Error(`Duplicate documentation section: ${title}`);
    bodies.set(title, body);
  }
  const topics = catalog.topics.map(({ section, ...metadata }) => {
    const body = bodies.get(section);
    if (!body)
      throw new Error(`Missing shipped-documentation section: ${section}`);
    bodies.delete(section);
    return {
      ...metadata,
      body,
      parentId: 'manual',
      sourcePath: catalog.source,
      sourceAnchor: headingId(section),
    };
  });
  if (bodies.size)
    throw new Error(
      `Uncatalogued shipped sections: ${[...bodies.keys()].join(', ')}`,
    );
  const modules = extractModules(moduleSource);
  validateCatalog(
    atlas,
    modules,
    new Set(
      atlas.groups.flatMap((group) =>
        group.docs.map((doc) => doc.split('#')[0]),
      ),
    ),
  );
  for (const group of atlas.groups) {
    const parentId = `architecture-${group.id}`;
    topics.push({
      id: parentId,
      title: group.title,
      summary: group.summary,
      body: `${group.summary}\n\nThis is a reading path through shipped documentation, not live state or a completed semantic audit.\n\nQuestions:\n${group.questions.map((question) => `- ${question}`).join('\n')}\n\nRead module topics with get_station_docs_topic:\n${group.modules.map((title) => `- architecture-${headingId(title)}: ${title}`).join('\n')}\n\nCanonical reading:\n${group.docs.map((doc) => `- ${doc}`).join('\n')}`,
      tags: ['architecture', group.id],
      parentId: 'architecture',
      sourcePath: 'docs/learn/atlas.json',
      sourceAnchor: '',
    });
    for (const title of group.modules) {
      const module = modules.find((entry) => entry.title === title);
      topics.push({
        id: `architecture-${module.id}`,
        title,
        summary: `Interface, composition, invariants, and documented evidence for ${title}.`,
        body: `Shipped architecture reference. Source and test links describe evidence to inspect; they do not establish live state or that those tests have been executed for this installation.\n\n${module.text.trim()}`,
        tags: ['architecture', group.id, title],
        parentId,
        sourcePath: 'docs/architecture/module-map.md',
        sourceAnchor: module.id,
      });
    }
  }
  const ids = new Set();
  for (const topic of topics) {
    if (
      typeof topic.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(topic.id) ||
      ids.has(topic.id)
    )
      throw new Error(`Invalid or duplicate shipped topic: ${topic.id}`);
    ids.add(topic.id);
    for (const key of ['title', 'summary', 'body'])
      if (typeof topic[key] !== 'string' || !topic[key].trim())
        throw new Error(`Missing ${key} for ${topic.id}`);
    if (
      !Array.isArray(topic.tags) ||
      topic.tags.some((tag) => typeof tag !== 'string')
    )
      throw new Error(`Invalid tags for ${topic.id}`);
    if (topic.body.length > 64_000)
      throw new Error(`Split oversized shipped topic: ${topic.id}`);
  }
  return topics;
}

async function readInputs() {
  const read = (file) => readFile(path.join(root, file), 'utf8');
  const [[manual, catalog, modules, atlas], manifest] = await Promise.all([
    Promise.all(STATION_DOCS_TOPIC_INPUT_PATHS.map(read)),
    read('corpus.json'),
  ]);
  return {
    topics: compileStationDocs(
      manual,
      JSON.parse(catalog),
      modules,
      JSON.parse(atlas),
    ),
    manifest: JSON.parse(manifest),
  };
}

export async function readStationDocsInputs() {
  return (await readInputs()).topics;
}

// The two roots the compiled topics hang from. Corpus refuses a parentId that
// names no topic in the bundle, and list_station_docs_topics filters on these
// ids, so they are topics of their own. Their text is deliberately short and
// lists no children: a root that repeated every child's title would compete
// with those children in search. Children are listed by parentId instead.
const ROOT_TOPICS = Object.freeze([
  {
    id: 'manual',
    title: 'Station manual',
    summary:
      'How Station works in general: its concepts, surfaces, and what its tools can and cannot do.',
    markdown:
      "Station's shipped manual. It describes the product in general, not this Station's live state. List its topics with list_station_docs_topics and parentId manual.",
    tags: ['manual', 'index'],
    sourcePath: 'docs/reference/station-docs.md',
  },
  {
    id: 'architecture',
    title: 'Architecture learning tree',
    summary:
      "Reading paths through Station's architecture module map, grouped by responsibility.",
    markdown:
      'Reading paths through the architecture module map. This is shipped documentation, not live state or a completed semantic audit. List its branches with list_station_docs_topics and parentId architecture.',
    tags: ['architecture', 'index'],
    sourcePath: 'docs/learn/atlas.json',
  },
]);

/**
 * The compiled topics as one Corpus docs bundle (schemaVersion 2), the only
 * shipped documentation artifact: list, get, and search in
 * station-docs-mcp-server.ts all read it.
 *
 * It is committed and byte-compared by docs:mcp:check, so it must not change
 * unless its sources do. It therefore records no build: `sha` is null and
 * `builtAt` is empty. Topic URLs use `blob/HEAD`, which is what Corpus's own
 * builder writes for a bundle-only document when there is no sha. Corpus's
 * `digest` is left out for the reason the server computes its digest at
 * runtime: a committed digest line conflicts between every pair of
 * docs-touching branches. validateStationDocsBundle adds it before Corpus
 * checks the shape.
 */
export function stationDocsBundle(topics, manifest) {
  const url = (sourcePath, anchor) =>
    `https://github.com/${manifest.repo}/blob/HEAD/${sourcePath}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
  const corpusTopic = ({
    id,
    title,
    summary,
    tags,
    parentId,
    sourcePath,
    sourceAnchor = '',
    markdown,
  }) => ({
    id,
    title,
    source: sourceAnchor ? `${sourcePath}#${sourceAnchor}` : sourcePath,
    url: url(sourcePath, sourceAnchor),
    markdown,
    summary,
    tags: [...tags],
    ...(parentId ? { parentId } : {}),
  });
  return {
    schemaVersion: 2,
    product: manifest.product,
    title: manifest.title,
    tagline: manifest.tagline,
    purpose: manifest.purpose,
    repo: manifest.repo,
    sha: null,
    builtAt: '',
    siteUrl: `https://kontourai.github.io/${manifest.product}/`,
    builtOn: manifest.builtOn,
    documents: [],
    topics: [
      ...ROOT_TOPICS.map(corpusTopic),
      ...topics.map(({ body, ...topic }) =>
        corpusTopic({ ...topic, markdown: body }),
      ),
    ],
    ...(manifest.synonyms ? { synonyms: manifest.synonyms } : {}),
  };
}

/** Refuse a bundle Corpus would refuse, with Corpus's own reason. */
export function validateStationDocsBundle(bundle) {
  const problem = bundleShapeError({
    ...bundle,
    digest: bundleDigest(bundle.documents, bundle.topics),
  });
  if (problem)
    throw new Error(`Invalid shipped documentation bundle: ${problem}`);
  return bundle;
}

export async function readStationDocsBundle() {
  const { topics, manifest } = await readInputs();
  return validateStationDocsBundle(stationDocsBundle(topics, manifest));
}

export function stationDocsDigest(bundle) {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

const GENERATED_TYPES = `export interface StationDocsBundleTopic {
  readonly id: string;
  readonly title: string;
  readonly source: string;
  readonly url: string;
  readonly markdown: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly parentId?: string;
}

export interface StationDocsBuiltOn {
  readonly product: string;
  readonly via: string | readonly string[];
  readonly for: string;
  readonly evidence?: 'cli';
  readonly bin?: string;
}

/** A Corpus docs bundle (schemaVersion 2) without its build-only fields. */
export interface StationDocsBundle {
  readonly schemaVersion: 2;
  readonly product: string;
  readonly title: string;
  readonly tagline: string;
  readonly purpose: string;
  readonly repo: string;
  readonly sha: null;
  readonly builtAt: string;
  readonly siteUrl: string;
  readonly builtOn: readonly StationDocsBuiltOn[];
  readonly documents: readonly never[];
  readonly topics: readonly StationDocsBundleTopic[];
  readonly synonyms?: readonly (readonly string[])[];
}`;

export async function generateStationDocs({ check = false } = {}) {
  const bundle = await readStationDocsBundle();
  const source = `// Generated by npm run docs:mcp:generate. Edit the canonical Markdown and catalogs.\n// Static data only: the credential-free MCP must not acquire live-state access.\n\n${GENERATED_TYPES}\n\nexport const STATION_DOCS_BUNDLE: StationDocsBundle = ${JSON.stringify(bundle, null, 2)};\n`;
  const formatted = execFileSync(
    process.execPath,
    [
      path.join(root, 'node_modules/@biomejs/biome/bin/biome'),
      'format',
      '--stdin-file-path',
      outputPath,
    ],
    {
      cwd: root,
      input: source,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (check) {
    if ((await readFile(path.join(root, outputPath), 'utf8')) !== formatted)
      throw new Error(
        'Shipped documentation is stale. Run npm run docs:mcp:generate.',
      );
  } else await writeFile(path.join(root, outputPath), formatted);
  console.log(
    `${check ? 'Validated' : 'Generated'} a Corpus bundle of ${bundle.topics.length} shipped documentation topics; digest ${stationDocsDigest(bundle)}.`,
  );
}

if (invokedDirectly(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check'))
      throw new Error('Usage: generate-station-docs.mjs [--check]');
    await generateStationDocs({ check: args.includes('--check') });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
