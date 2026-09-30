import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  createKnowledgeRecord,
  getKnowledgeGraph,
  getKnowledgeRecord,
  linkKnowledgeRecord,
  listKnowledgeRecordsByType,
  listKnowledgeRoots,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { invokedDirectly } from '../../scripts/lib/module-entry.mjs';
import {
  GRAPH_AGENT,
  GRAPH_LIMITS,
  validateKnowledgeSnapshot,
} from './graph.mjs';

export function isolatedOrigin(apiBase) {
  const url = new URL(apiBase);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port ||
    ['3000', '3141'].includes(url.port) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use an explicit isolated loopback HTTP origin on a non-default port.',
    );
  return url.origin;
}

function comparable(record, includeLinks = true) {
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    body: record.body,
    category: record.category,
    tags: [...(record.tags ?? [])].sort(),
    links: [...(includeLinks ? (record.links ?? []) : [])].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    ),
    provenance: record.provenance,
  };
}

/** A dedicated single-writer root is required; the public API has no bulk transaction. */
export async function ingestKnowledgeSnapshot({
  snapshot,
  apiBase,
  rootId,
  credential,
  apply = false,
  paceMilliseconds = 250,
  onProgress = () => {},
}) {
  validateKnowledgeSnapshot(snapshot);
  apiBase = isolatedOrigin(apiBase);
  if (!rootId || !credential)
    throw new Error('An explicit isolated root and credential are required.');
  if (
    !Number.isInteger(paceMilliseconds) ||
    paceMilliseconds < 250 ||
    paceMilliseconds > 1000
  )
    throw new Error('Invalid ingestion pacing.');
  const options = {
    credential,
    credentialOrigin: apiBase,
    requireCredential: true,
    authentication: 'required',
    redirect: 'error',
    maxResponseBytes: GRAPH_LIMITS.outputBytes,
    signal: AbortSignal.timeout(15 * 60_000),
  };
  const root = (await listKnowledgeRoots(apiBase, options)).find(
    (item) => item.id === rootId,
  );
  if (
    root?.adapterId !== 'kit-default-store' ||
    root.scope.kind !== 'project' ||
    root.displayName !== 'Station repository graph dogfood'
  )
    throw new Error(
      'Select the dedicated Project root named Station repository graph dogfood.',
    );
  const existing = new Map();
  for (const type of ['raw', 'compiled', 'concept', 'snapshot', 'person']) {
    for (const record of await listKnowledgeRecordsByType(
      apiBase,
      rootId,
      type,
      { includeRetired: true },
      options,
    )) {
      if (
        record.provenance?.agent !== GRAPH_AGENT ||
        !record.id.startsWith('repo-')
      )
        throw new Error(
          'The selected root contains records owned by another writer.',
        );
      existing.set(record.id, record);
      if (existing.size > GRAPH_LIMITS.records * 4)
        throw new Error(
          'Root retention limit exceeded; use a fresh isolated root.',
        );
    }
  }
  const missing = [];
  const pendingLinks = [];
  let unchanged = 0;
  let present = 0;
  for (const record of snapshot.records) {
    const prior = existing.get(record.id);
    if (!prior) missing.push(record);
    else {
      present++;
      if (
        !isDeepStrictEqual(
          comparable(prior, false),
          comparable(record, false),
        ) ||
        !(prior.links ?? []).every((link) =>
          record.links.some((expected) => isDeepStrictEqual(link, expected)),
        )
      )
        throw new Error(
          `Existing derived record differs: ${record.id}. No overwrite was attempted.`,
        );
      if (isDeepStrictEqual(comparable(prior), comparable(record))) unchanged++;
    }
    const links = record.links.filter(
      (link) =>
        !(prior?.links ?? []).some((existingLink) =>
          isDeepStrictEqual(existingLink, link),
        ),
    );
    if (links.length) pendingLinks.push({ record, links });
  }
  if (!apply)
    return {
      outcome: 'dry-run',
      wouldCreate: missing.length,
      wouldLinkEdges: pendingLinks.reduce(
        (count, item) => count + item.links.length,
        0,
      ),
      unchanged,
      retainedOtherSnapshots: existing.size - present,
      snapshot: snapshot.inputDigest,
    };
  const completed = [];
  const admission = { rateLimitWaits: 0, retryAfterMilliseconds: 0 };
  let nextWriteAt = performance.now();
  const waitForWrite = async () => {
    while (performance.now() < nextWriteAt)
      await delay(Math.ceil(nextWriteAt - performance.now()), undefined, {
        signal: options.signal,
      });
    options.signal.throwIfAborted();
    nextWriteAt = performance.now() + paceMilliseconds;
  };
  const pauseForLimit = (error) => {
    if (
      !(error instanceof StationHttpError) ||
      error.status !== 429 ||
      error.code !== 'rate_limited' ||
      !Number.isFinite(error.retryAfterMs) ||
      error.retryAfterMs < 0 ||
      error.retryAfterMs > 60_000 ||
      admission.rateLimitWaits >= 8
    )
      throw error;
    admission.rateLimitWaits++;
    admission.retryAfterMilliseconds += error.retryAfterMs;
    nextWriteAt = Math.max(
      nextWriteAt,
      performance.now() + Math.max(250, error.retryAfterMs),
    );
    onProgress({
      stage: 'rate-limited',
      confirmedCreates: completed.length,
      retryAfterMilliseconds: error.retryAfterMs,
    });
  };
  const matchesMetadataAndKnownLinks = (actual, expected) =>
    isDeepStrictEqual(comparable(actual, false), comparable(expected, false)) &&
    (actual.links ?? []).every((link) =>
      expected.links.some((candidate) => isDeepStrictEqual(link, candidate)),
    );
  try {
    for (const record of missing) {
      let retry = false;
      while (true) {
        await waitForWrite();
        if (retry) {
          try {
            const observed = await getKnowledgeRecord(
              apiBase,
              rootId,
              record.id,
              options,
            );
            if (!matchesMetadataAndKnownLinks(observed, record))
              throw new Error('Retry identity readback differs.');
            break;
          } catch (error) {
            if (!(error instanceof StationHttpError) || error.status !== 404)
              throw error;
          }
        }
        try {
          const created = await createKnowledgeRecord(
            apiBase,
            rootId,
            { ...record, links: [] },
            options,
          );
          if (
            !isDeepStrictEqual(
              comparable(created),
              comparable({ ...record, links: [] }),
            )
          )
            throw new Error('Created record readback differs.');
          break;
        } catch (error) {
          pauseForLimit(error);
          retry = true;
        }
      }
      completed.push(record.id);
      if (completed.length % 100 === 0)
        onProgress({
          stage: 'creating',
          confirmedCreates: completed.length,
          totalCreates: missing.length,
        });
    }
    for (const { record, links } of pendingLinks) {
      let remaining = links;
      let retry = false;
      while (remaining.length) {
        await waitForWrite();
        if (retry) {
          const observed = await getKnowledgeRecord(
            apiBase,
            rootId,
            record.id,
            options,
          );
          if (!matchesMetadataAndKnownLinks(observed, record))
            throw new Error('Retry identity readback differs.');
          remaining = record.links.filter(
            (link) =>
              !(observed.links ?? []).some((current) =>
                isDeepStrictEqual(current, link),
              ),
          );
          if (!remaining.length) break;
        }
        try {
          const linked = await linkKnowledgeRecord(
            apiBase,
            rootId,
            record.id,
            {
              links: remaining,
              evidence: {
                agent: GRAPH_AGENT,
                note: `Derived snapshot ${snapshot.inputDigest}; all target records created before linking.`,
              },
            },
            options,
          );
          if (!isDeepStrictEqual(comparable(linked), comparable(record)))
            throw new Error('Linked record readback differs.');
          break;
        } catch (error) {
          pauseForLimit(error);
          retry = true;
        }
      }
    }
    onProgress({ stage: 'verifying', records: snapshot.records.length });
    const graph = await getKnowledgeGraph(apiBase, rootId, options);
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    const edges = new Set(
      graph.edges.map((edge) =>
        JSON.stringify([edge.source, edge.target, edge.kind, edge.label]),
      ),
    );
    for (const record of snapshot.records) {
      if (!nodeIds.has(record.id))
        throw new Error(`Missing graph node: ${record.id}`);
      for (const link of record.links)
        if (
          !edges.has(
            JSON.stringify([record.id, link.target_id, link.kind, link.label]),
          )
        )
          throw new Error(`Missing graph edge from ${record.id}`);
      const canonical = await getKnowledgeRecord(
        apiBase,
        rootId,
        record.id,
        options,
      );
      if (!isDeepStrictEqual(comparable(canonical), comparable(record)))
        throw new Error('Canonical record readback differs.');
    }
    return {
      outcome: 'verified',
      created: completed.length,
      existing: present,
      linkedEdges: pendingLinks.reduce(
        (count, item) => count + item.links.length,
        0,
      ),
      unchanged,
      retainedOtherSnapshots: existing.size - present,
      recordsVerified: snapshot.records.length,
      edgesVerified: snapshot.records.reduce(
        (count, record) => count + record.links.length,
        0,
      ),
      admission,
      snapshot: snapshot.inputDigest,
    };
  } catch (error) {
    throw new Error(
      `Ingestion incomplete after ${completed.length} confirmed creates; earlier records are retained. Rerun the same snapshot to inspect/reconcile; a transport failure may have applied the last write. ${error instanceof StationHttpError ? `HTTP ${error.status}.` : 'Readback or transport did not complete.'}`,
      { cause: error },
    );
  }
}

/** Recall exact records in this snapshot through the public graph and canonical record APIs. */
export async function recallKnowledgeSnapshot({
  snapshot,
  apiBase,
  rootId,
  credential,
  query,
}) {
  validateKnowledgeSnapshot(snapshot);
  apiBase = isolatedOrigin(apiBase);
  if (
    !credential ||
    !rootId ||
    typeof query !== 'string' ||
    query.trim().length < 2 ||
    query.length > 160
  )
    throw new Error(
      'Recall requires an explicit root, credential and a 2–160 character query.',
    );
  const options = {
    credential,
    credentialOrigin: apiBase,
    requireCredential: true,
    authentication: 'required',
    redirect: 'error',
    maxResponseBytes: GRAPH_LIMITS.outputBytes,
  };
  const expected = new Map(
    snapshot.records.map((record) => [record.id, record]),
  );
  const graph = await getKnowledgeGraph(apiBase, rootId, options);
  const matches = graph.nodes
    .filter(
      (node) =>
        expected.has(node.id) &&
        node.title.toLowerCase().includes(query.trim().toLowerCase()),
    )
    .slice(0, 10);
  const results = [];
  for (const match of matches) {
    const record = await getKnowledgeRecord(apiBase, rootId, match.id, options);
    if (
      !isDeepStrictEqual(comparable(record), comparable(expected.get(match.id)))
    )
      throw new Error('Recall record differs from the selected snapshot.');
    const outgoing = graph.edges
      .filter((edge) => edge.source === match.id)
      .map((edge) => ({
        kind: edge.kind,
        targetId: edge.target,
        title: expected.get(edge.target)?.title ?? 'Outside selected snapshot',
      }));
    results.push({
      id: record.id,
      title: record.title,
      body: record.body,
      provenance: record.provenance,
      outgoing,
    });
  }
  return {
    outcome: results.length ? 'recalled' : 'no-answer',
    retrieval:
      'Graph title match plus canonical record read; no embedding or semantic ranking.',
    snapshot: snapshot.inputDigest,
    results,
  };
}

export async function main(args = process.argv.slice(2)) {
  const flags = new Map();
  for (const arg of args) {
    const match = /^--(input|api-base|root|query)=(.+)$/.exec(arg);
    if (match && !flags.has(match[1])) flags.set(match[1], match[2]);
    else if (arg === '--apply' && !flags.has('apply')) flags.set('apply', true);
    else throw new Error(`Unknown or duplicate ingestion option: ${arg}`);
  }
  if (!flags.get('input'))
    throw new Error('--input=<snapshot.json> is required.');
  if (flags.has('query') && flags.has('apply'))
    throw new Error('Recall cannot apply an import.');
  const bytes = readFileSync(flags.get('input'));
  if (bytes.length > GRAPH_LIMITS.outputBytes)
    throw new Error('Snapshot exceeds byte limit.');
  const input = {
    snapshot: JSON.parse(bytes.toString('utf8')),
    apiBase: flags.get('api-base'),
    rootId: flags.get('root'),
    credential: process.env.STATION_GRAPH_TOKEN,
  };
  const result = flags.has('query')
    ? await recallKnowledgeSnapshot({ ...input, query: flags.get('query') })
    : await ingestKnowledgeSnapshot({
        ...input,
        apply: flags.get('apply') === true,
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Ingestion failed.');
    process.exitCode = 1;
  });
}
