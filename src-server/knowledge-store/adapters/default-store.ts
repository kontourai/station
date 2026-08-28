/**
 * `kit-default-store` — Station-owned adapter implementing the Knowledge Kit's
 * published on-disk file format (store-contract.md §8/§9 + Addendum A.6 `supersede`,
 * Addendum B.5 `retire`, Addendum H identity resolution) directly.
 *
 * This is a from-scratch, file-format-conformant implementation — it never imports
 * `@kontourai/flow-agents` Kit internals (ADR-0001; the Kit's package `exports` map
 * does not expose `kits/knowledge/adapters/**` for import, confirmed empirically —
 * see the s200-knowledge-store plan's Evidence section). Records are markdown files
 * with YAML frontmatter (`records/<id>.md`), a JSON graph index (`graph-index.json`),
 * and a JSON slug-alias index (`alias-index.json`), exactly as store-contract.md §9
 * specifies, so a human, the Kit's own CLI, or any other conformant reader can open
 * a store this adapter wrote.
 *
 * Contract version: written against `store-contract.md` as of `@kontourai/flow-agents`
 * **3.3.0** (Addendum H / §8.1 / non-MISSING_EVIDENCE error codes) — ahead of the `^2.2.0`
 * sidecar-tooling pin in this repo's `package.json`, which this adapter imports nothing
 * from and is therefore unaffected by. See `docs/design/knowledge-foundation.md`'s
 * "Contract version" note and archive#218 for the tracked upgrade of the sidecar pin.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  ApplyEvidence,
  CreateInput,
  KitLink,
  KitRecord,
  KitRecordType,
  KitReverseLink,
  KnowledgeAdapterDescriptor,
  KnowledgeStoreAdapter,
  LinkEvidence,
  ProposeEvidence,
  RejectEvidence,
  RetireEvidence,
  SupersedeEvidence,
  UpdateEvidence,
  UpdateFields,
} from '@kontourai/station-contracts/knowledge-store';
import { createLogger } from '../../utils/logger.js';
import {
  KnowledgeRecordNotFoundError,
  KnowledgeStoreCorruptionError,
  MissingEvidenceError,
} from '../errors.js';
import { isValidCategory } from './shared/category.js';
import { KnowledgeFileTransactions } from './shared/file-transactions.js';
import { freshnessPatch } from './shared/freshness.js';
import { parseMarkdown, serializeMarkdown } from './shared/frontmatter.js';
import {
  addLinksToGraph,
  assertGraphIndex,
  canonicalGraph,
  emptyGraph,
  type GraphIndex,
  type ReindexResult,
  removeLinksFromGraph,
} from './shared/graph-index.js';
import {
  type AliasIndex,
  assertAliasIndex,
  emptyAliasIndex,
  normalizeAliases,
  registerAliases,
  resolveRecordId,
} from './shared/identity.js';
import {
  assertKitRecord,
  VALID_STATUS_TRANSITIONS,
  VALID_TYPES,
} from './shared/record-schema.js';
import {
  appendUniqueLinks,
  extractWikilinks,
  mergeLinks,
  sanitizeLinks,
} from './shared/wikilinks.js';

const logger = createLogger({ name: 'knowledge-store:kit-default-store' });

export type { ReindexResult };

export interface KitDefaultStoreOptions {
  storeRoot: string;
}

export class KitDefaultStoreAdapter implements KnowledgeStoreAdapter {
  private readonly root: string;
  private readonly recordsDir: string;
  private readonly graphPath: string;
  private readonly aliasPath: string;
  private readonly files: KnowledgeFileTransactions;

  constructor(options: KitDefaultStoreOptions) {
    if (!options?.storeRoot) throw new Error('storeRoot is required');
    this.root = resolve(options.storeRoot);
    this.recordsDir = join(this.root, 'records');
    this.graphPath = join(this.root, 'graph-index.json');
    this.aliasPath = join(this.root, 'alias-index.json');
    mkdirSync(this.recordsDir, { recursive: true });
    this.files = new KnowledgeFileTransactions(this.root);
  }

  // ── Internal: record file access ─────────────────────────────────────────

  private recordPath(id: string): string {
    return join(this.recordsDir, `${id}.md`);
  }

  private idExists(id: string): boolean {
    return this.files.readText(this.recordPath(id)) !== null;
  }

  private listIds(): string[] {
    return this.files
      .listFileNames(this.recordsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3));
  }

  private readRecord(id: string): KitRecord | null {
    const path = this.recordPath(id);
    const text = this.files.readText(path);
    if (text === null) return null;
    try {
      const { meta, body } = parseMarkdown(text);
      const record = assertKitRecord(meta, body, path);
      if (record.id !== id) {
        throw new KnowledgeStoreCorruptionError(
          `${path}: record id does not match its authoritative filename`,
        );
      }
      return record;
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreCorruptionError(`${path}: record is corrupt`, {
        cause: error,
      });
    }
  }

  private writeRecord(record: KitRecord): void {
    const { body, ...meta } = record;
    // Unconditionally sanitize `links` here, on the single write path every
    // mutation funnels through (create/update/link/propose/apply/reject/
    // supersede/retire) — closes the gap the Wave-2 code review named: label
    // sanitization previously only happened inside `appendUniqueLinks`
    // (create/update-with-links/link/supersede's new-record merge), so a
    // metadata-only mutation (retire, a tags-only update, apply/reject/
    // propose's untouched-links spreads) would carry forward an already-bad,
    // legacy/externally-authored `KitLink.label` on disk indefinitely instead
    // of ever actually cleaning it up at rest. Idempotent/harmless for
    // already-sanitized links (no re-warn) per `sanitizeLinks`'s own contract.
    const sanitizedMeta = Array.isArray((meta as { links?: KitLink[] }).links)
      ? { ...meta, links: sanitizeLinks((meta as { links: KitLink[] }).links) }
      : meta;
    this.files.writeText(
      this.recordPath(record.id),
      serializeMarkdown(sanitizedMeta, body),
    );
  }

  private allRecords(): KitRecord[] {
    return this.listIds()
      .map((id) => this.readRecord(id))
      .filter((r): r is KitRecord => r !== null);
  }

  private resolveId(input: string): string | null {
    const aliasIndex = this.loadAliasIndex();
    return resolveRecordId(input, {
      idExists: (rid) => this.idExists(rid),
      listIds: () => this.listIds(),
      bySlug: aliasIndex.by_slug,
    });
  }

  // ── Internal: graph + alias index (derived caches, §5.2 / Addendum H.5) ──

  /**
   * Single parse+catch+log site for `graph-index.json` (mirrors `readAliasRaw`'s
   * shape for the alias index). Returns `undefined` — after logging — when the
   * file exists but fails to parse; callers decide how to treat that outcome.
   * `readGraphRaw()` and `loadGraph()` both route through this so there is
   * exactly one place that can emit the corrupt-parse breadcrumb.
   */
  private parseGraphFile(): GraphIndex | undefined {
    const raw = this.files.readText(this.graphPath);
    if (raw === null) return undefined;
    try {
      return assertGraphIndex(JSON.parse(raw), this.graphPath);
    } catch (err) {
      // Self-heal path (§5.2/H.5): an unparsable graph-index.json (hand-corrupted,
      // interrupted write, permissions surfacing as a parse error) is indistinguishable
      // from "not yet created" without a trace, so log a breadcrumb an operator can
      // find — the caller still falls back to an empty graph and rebuilds.
      logger.warn(
        'graph-index.json failed to parse; self-healing to an empty graph (will rebuild from record links)',
        { path: this.graphPath, error: err },
      );
      return undefined;
    }
  }

  private readGraphRaw(): GraphIndex {
    return this.parseGraphFile() ?? emptyGraph();
  }

  private saveGraph(graph: GraphIndex): void {
    this.files.writeText(this.graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }

  private readAliasRaw(): AliasIndex | undefined {
    const raw = this.files.readText(this.aliasPath);
    if (raw === null) return undefined;
    try {
      return assertAliasIndex(JSON.parse(raw), this.aliasPath);
    } catch (err) {
      // Same self-heal rationale as readGraphRaw() above.
      logger.warn(
        'alias-index.json failed to parse; self-healing to an empty alias index (will rebuild from record aliases)',
        { path: this.aliasPath, error: err },
      );
      return undefined;
    }
  }

  private saveAliasIndex(index: AliasIndex): void {
    this.files.writeText(this.aliasPath, `${JSON.stringify(index, null, 2)}\n`);
  }

  /**
   * Rebuild both derived caches (graph index + alias index) authoritatively from
   * records' own `links`/`aliases` (§5.2, Addendum H.5) — the recovery path for a
   * lost, hand-edited, or drifted index file.
   *
   * `priorRawGraph`, when supplied, is used for the `changed` diagnostic instead
   * of re-parsing `graph-index.json` via `readGraphRaw()` — callers that already
   * attempted (and logged) a parse of the corrupt file (`loadGraph()`) pass the
   * already-known-empty result so the file is parsed at most once per corrupt
   * read, instead of a second, silently-relogging re-parse here.
   */
  private rebuildIndexes(priorRawGraph?: GraphIndex): {
    result: ReindexResult;
    graph: GraphIndex;
    aliasIndex: AliasIndex;
  } {
    const records = this.allRecords().sort((a, b) => a.id.localeCompare(b.id));

    const rebuiltGraph = emptyGraph();
    for (const record of records) {
      addLinksToGraph(
        rebuiltGraph,
        record.id,
        Array.isArray(record.links) ? record.links : [],
      );
    }
    const links = Object.values(rebuiltGraph.forward).reduce(
      (n, arr) => n + arr.length,
      0,
    );
    const changed =
      canonicalGraph(priorRawGraph ?? this.readGraphRaw()) !==
      canonicalGraph(rebuiltGraph);
    this.saveGraph(rebuiltGraph);

    const rebuiltAliases = emptyAliasIndex();
    for (const record of records) {
      const slugs = normalizeAliases(record.aliases);
      if (slugs.length) registerAliases(rebuiltAliases, record.id, slugs);
    }
    this.saveAliasIndex(rebuiltAliases);

    return {
      result: {
        records: records.length,
        links,
        forwardSources: Object.keys(rebuiltGraph.forward).length,
        reverseTargets: Object.keys(rebuiltGraph.reverse).length,
        changed,
      },
      graph: rebuiltGraph,
      aliasIndex: rebuiltAliases,
    };
  }

  /** Defensive load: missing/corrupt index files self-heal via `rebuildIndexes()`. */
  private loadGraph(): GraphIndex {
    const parsed = this.parseGraphFile();
    if (parsed !== undefined) return parsed;
    // parseGraphFile() already logged the corrupt-parse breadcrumb above; pass the
    // now-known-empty raw graph through so rebuildIndexes()'s `changed` diagnostic
    // doesn't re-parse (and silently re-warn on) the same corrupt file.
    return this.rebuildIndexes(emptyGraph()).graph;
  }

  private loadAliasIndex(): AliasIndex {
    const idx = this.readAliasRaw();
    // A missing/corrupt cache rebuilds from authoritative records. An explicitly
    // empty but valid alias map remains valid and does not rebuild on every read.
    return idx ?? this.rebuildIndexes().aliasIndex;
  }

  /** Rebuild the graph + alias index from scratch. Exposed per store-contract.md §5.2. */
  async reindex(): Promise<ReindexResult> {
    return this.files.mutate('reindex', () => this.rebuildIndexes().result);
  }

  // ── create (§6.1) ──────────────────────────────────────────────────────

  async create(input: CreateInput): Promise<string> {
    return this.files.mutate('create', () => this.createLocked(input));
  }

  private createLocked(input: CreateInput): string {
    if (!input.type) {
      throw new MissingEvidenceError('create: missing required field: type');
    }
    if (!VALID_TYPES.has(input.type)) {
      throw new MissingEvidenceError(
        `create: type must be one of raw, compiled, concept, snapshot, person; got: ${input.type}`,
      );
    }
    if (!input.title?.trim()) {
      throw new MissingEvidenceError('create: missing required field: title');
    }
    if (typeof input.body !== 'string' || input.body.trim() === '') {
      throw new MissingEvidenceError('create: missing required field: body');
    }
    if (!input.category) {
      throw new MissingEvidenceError(
        'create: missing required field: category',
      );
    }
    if (!isValidCategory(input.category)) {
      throw new MissingEvidenceError(
        `create: invalid category: ${input.category}`,
      );
    }
    if (!input.provenance?.agent) {
      throw new MissingEvidenceError(
        'create: missing required provenance field: provenance.agent',
      );
    }

    const id = input.id || randomUUID();
    const now = new Date().toISOString();

    // Reserve slug aliases BEFORE any write, so a SLUG_CONFLICT aborts create
    // without a partial record.
    const aliases = normalizeAliases(input.aliases);
    let aliasIndex: AliasIndex | null = null;
    if (aliases.length) {
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, aliases);
    }

    // Validate freshness fields before any write (malformed → never reaches disk).
    const fresh = freshnessPatch(input);

    const explicitLinks = input.links ?? [];
    const wikilinks = extractWikilinks(input.body);
    const links = mergeLinks(explicitLinks, wikilinks);

    const record: KitRecord = {
      id,
      type: input.type,
      title: input.title,
      category: input.category,
      tags: input.tags ?? [],
      ...(aliases.length ? { aliases } : {}),
      status: 'active',
      created_at: now,
      updated_at: now,
      ...fresh,
      provenance: {
        agent: input.provenance.agent,
        ...(input.provenance.session_id
          ? { session_id: input.provenance.session_id }
          : {}),
        ...(input.provenance.source_ids?.length
          ? { source_ids: input.provenance.source_ids }
          : {}),
        ...(input.provenance.note ? { note: input.provenance.note } : {}),
      },
      links,
      mutation_log: [],
      body: input.body,
    };

    this.writeRecord(record);

    const graph = this.loadGraph();
    addLinksToGraph(graph, id, links);
    this.saveGraph(graph);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);

    return id;
  }

  // ── update (§6.2) ──────────────────────────────────────────────────────

  async update(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): Promise<void> {
    return this.files.mutate('update', () =>
      this.updateLocked(id, fields, evidence),
    );
  }

  private updateLocked(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'update: missing required evidence field: agent',
      );
    }

    const record = this.readRecord(id);
    if (!record) throw new KnowledgeRecordNotFoundError(id);

    const mutableKeys = [
      'title',
      'body',
      'category',
      'tags',
      'links',
      'aliases',
      'expires_at',
      'ttl_seconds',
    ] as const;
    const suppliedFields = fields as Record<string, unknown>;
    const supplied = mutableKeys.filter((k) => suppliedFields[k] !== undefined);
    if (supplied.length === 0) {
      throw new MissingEvidenceError(
        'update: at least one mutable field must be supplied',
      );
    }

    if (fields.category !== undefined && !isValidCategory(fields.category)) {
      throw new MissingEvidenceError(
        `update: invalid category: ${fields.category}`,
      );
    }

    const fresh = freshnessPatch(fields);
    const now = new Date().toISOString();

    // Slug aliases are append-only: supplied aliases UNION with existing ones so a
    // previously issued slug keeps resolving after a restructure (Addendum H.4).
    const mergedAliases: string[] = Array.isArray(record.aliases)
      ? record.aliases.slice()
      : [];
    let aliasIndex: AliasIndex | null = null;
    if (fields.aliases !== undefined) {
      const incoming = normalizeAliases(fields.aliases);
      const seen = new Set(mergedAliases);
      for (const slug of incoming) {
        if (!seen.has(slug)) {
          seen.add(slug);
          mergedAliases.push(slug);
        }
      }
      aliasIndex = this.loadAliasIndex();
      registerAliases(aliasIndex, id, mergedAliases);
    }

    let newLinks: KitLink[] = record.links ?? [];
    if (fields.links !== undefined) {
      const wikilinks = extractWikilinks(
        fields.body !== undefined ? fields.body : record.body,
      );
      newLinks = mergeLinks(fields.links, wikilinks);
    } else if (fields.body !== undefined) {
      const wikilinks = extractWikilinks(fields.body);
      newLinks = mergeLinks(record.links ?? [], wikilinks);
    }

    const updated: KitRecord = {
      ...record,
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.body !== undefined ? { body: fields.body } : {}),
      ...(fields.category !== undefined ? { category: fields.category } : {}),
      ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
      ...(mergedAliases.length ? { aliases: mergedAliases } : {}),
      ...fresh,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'update',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { fields: supplied },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, id);
    addLinksToGraph(graph, id, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated);

    if (aliasIndex) this.saveAliasIndex(aliasIndex);
  }

  // ── link (§6.3) ────────────────────────────────────────────────────────

  async link(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): Promise<void> {
    return this.files.mutate('link', () =>
      this.linkLocked(sourceId, links, evidence),
    );
  }

  private linkLocked(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'link: missing required evidence field: agent',
      );
    }
    if (!links || links.length === 0) {
      throw new MissingEvidenceError('link: links array must be non-empty');
    }

    const source = this.readRecord(sourceId);
    if (!source) throw new KnowledgeRecordNotFoundError(sourceId);

    for (const l of links) {
      if (!this.readRecord(l.target_id))
        throw new KnowledgeRecordNotFoundError(l.target_id);
    }

    const now = new Date().toISOString();
    const newLinks = appendUniqueLinks(source.links ?? [], links);

    const updated: KitRecord = {
      ...source,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(source.mutation_log ?? []),
        {
          op: 'link',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { added: links },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, sourceId);
    addLinksToGraph(graph, sourceId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updated);
  }

  // ── propose (§6.4) ─────────────────────────────────────────────────────

  async propose(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): Promise<void> {
    return this.files.mutate('propose', () =>
      this.proposeLocked(conceptId, proposerId, evidence),
    );
  }

  private proposeLocked(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: agent',
      );
    }
    if (!evidence?.proposal?.trim()) {
      throw new MissingEvidenceError(
        'propose: missing required evidence field: proposal',
      );
    }

    const concept = this.readRecord(conceptId);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `propose: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const now = new Date().toISOString();

    const proposerLinks = proposer.links ?? [];
    const alreadyLinked = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!alreadyLinked) {
      const updatedProposer: KitRecord = {
        ...proposer,
        links: [...proposerLinks, { target_id: conceptId, kind: 'proposes' }],
        updated_at: now,
        mutation_log: [
          ...(proposer.mutation_log ?? []),
          {
            op: 'propose',
            at: now,
            agent: evidence.agent,
            evidence: { concept_id: conceptId, proposal: evidence.proposal },
          },
        ],
      };
      this.writeRecord(updatedProposer);

      const graph = this.loadGraph();
      removeLinksFromGraph(graph, proposerId);
      addLinksToGraph(graph, proposerId, updatedProposer.links ?? []);
      this.saveGraph(graph);
    }

    const updatedConcept: KitRecord = {
      ...concept,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'propose',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, proposal: evidence.proposal },
        },
      ],
    };
    this.writeRecord(updatedConcept);
  }

  // ── apply (§6.5) ───────────────────────────────────────────────────────

  async apply(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): Promise<void> {
    return this.files.mutate('apply', () =>
      this.applyLocked(conceptId, proposerId, evidence),
    );
  }

  private applyLocked(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: agent',
      );
    }
    if (typeof evidence?.new_body !== 'string' || !evidence.new_body.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: new_body',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'apply: missing required evidence field: rationale',
      );
    }

    const concept = this.readRecord(conceptId);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `apply: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `apply: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date().toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      body: evidence.new_body,
      updated_at: now,
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'apply',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, rationale: evidence.rationale },
        },
      ],
    };
    this.writeRecord(updatedConcept);
  }

  // ── reject (§6.6) ──────────────────────────────────────────────────────

  async reject(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): Promise<void> {
    return this.files.mutate('reject', () =>
      this.rejectLocked(conceptId, proposerId, evidence),
    );
  }

  private rejectLocked(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: agent',
      );
    }
    if (!evidence?.reason?.trim()) {
      throw new MissingEvidenceError(
        'reject: missing required evidence field: reason',
      );
    }

    const concept = this.readRecord(conceptId);
    if (!concept) throw new KnowledgeRecordNotFoundError(conceptId);
    if (concept.type !== 'concept') {
      throw new MissingEvidenceError(
        `reject: concept_id ${conceptId} is not of type "concept" (got: ${concept.type})`,
      );
    }

    const proposer = this.readRecord(proposerId);
    if (!proposer) throw new KnowledgeRecordNotFoundError(proposerId);

    const proposerLinks = proposer.links ?? [];
    const hasProposesLink = proposerLinks.some(
      (l) => l.target_id === conceptId && l.kind === 'proposes',
    );
    if (!hasProposesLink) {
      throw new MissingEvidenceError(
        `reject: no "proposes" link from ${proposerId} to ${conceptId}`,
      );
    }

    const now = new Date().toISOString();
    const updatedConcept: KitRecord = {
      ...concept,
      // updated_at NOT changed — concept body was not mutated.
      mutation_log: [
        ...(concept.mutation_log ?? []),
        {
          op: 'reject',
          at: now,
          agent: evidence.agent,
          evidence: { proposer_id: proposerId, reason: evidence.reason },
        },
      ],
    };
    this.writeRecord(updatedConcept);
  }

  // ── supersede (Addendum A.5/A.6) ──────────────────────────────────────

  async supersede(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): Promise<void> {
    return this.files.mutate('supersede', () =>
      this.supersedeLocked(newId, supersededIds, evidence),
    );
  }

  private supersedeLocked(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'supersede: missing required evidence field: rationale',
      );
    }
    if (!supersededIds || supersededIds.length === 0) {
      throw new MissingEvidenceError(
        'supersede: supersededIds must be a non-empty array',
      );
    }

    const newRecord = this.readRecord(newId);
    if (!newRecord) throw new KnowledgeRecordNotFoundError(newId);

    for (const sid of supersededIds) {
      if (!this.readRecord(sid)) throw new KnowledgeRecordNotFoundError(sid);
    }

    const now = new Date().toISOString();

    const supersededLinks: KitLink[] = supersededIds.map((sid) => ({
      target_id: sid,
      kind: 'supersedes',
    }));

    const newLinks = appendUniqueLinks(newRecord.links ?? [], supersededLinks);

    const updatedNew: KitRecord = {
      ...newRecord,
      links: newLinks,
      updated_at: now,
      mutation_log: [
        ...(newRecord.mutation_log ?? []),
        {
          op: 'supersede',
          at: now,
          agent: evidence.agent,
          rationale: evidence.rationale,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: { superseded_count: supersededIds.length },
        },
      ],
    };

    const graph = this.loadGraph();
    removeLinksFromGraph(graph, newId);
    addLinksToGraph(graph, newId, newLinks);
    this.saveGraph(graph);

    this.writeRecord(updatedNew);

    // Records are NOT deleted — supersede-not-delete invariant (A.5).
    for (const sid of supersededIds) {
      const supersededRecord = this.readRecord(sid);
      if (!supersededRecord) continue; // already verified above; defensive.
      const updatedSuperseded: KitRecord = {
        ...supersededRecord,
        // updated_at NOT changed — the record content is not mutated.
        mutation_log: [
          ...(supersededRecord.mutation_log ?? []),
          {
            op: 'superseded-by',
            at: now,
            agent: evidence.agent,
            new_id: newId,
            rationale: evidence.rationale,
            ...(evidence.note ? { note: evidence.note } : {}),
            evidence: { superseded_by_id: newId },
          },
        ],
      };
      this.writeRecord(updatedSuperseded);
    }
  }

  // ── retire (Addendum B.4/B.5) ─────────────────────────────────────────

  async retire(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): Promise<void> {
    return this.files.mutate('retire', () =>
      this.retireLocked(id, targetStatus, evidence),
    );
  }

  private retireLocked(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): void {
    if (!evidence?.agent) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: agent',
      );
    }
    if (!evidence?.rationale?.trim()) {
      throw new MissingEvidenceError(
        'retire: missing required evidence field: rationale',
      );
    }
    if (targetStatus !== 'implemented' && targetStatus !== 'retired') {
      throw new MissingEvidenceError(
        `retire: targetStatus must be "implemented" or "retired"; got: ${targetStatus}`,
      );
    }
    if (targetStatus === 'implemented' && !evidence.implementedByRef?.trim()) {
      throw new MissingEvidenceError(
        'retire: implementedByRef is required when targetStatus is "implemented"',
      );
    }

    const record = this.readRecord(id);
    if (!record) throw new KnowledgeRecordNotFoundError(id);

    const currentStatus = record.status ?? 'active';
    const allowed = VALID_STATUS_TRANSITIONS[currentStatus];
    if (!allowed?.has(targetStatus)) {
      throw new MissingEvidenceError(
        `retire: invalid transition from "${currentStatus}" to "${targetStatus}"`,
      );
    }

    const now = new Date().toISOString();
    const updated: KitRecord = {
      ...record,
      status: targetStatus,
      updated_at: now,
      mutation_log: [
        ...(record.mutation_log ?? []),
        {
          op: 'retire',
          at: now,
          agent: evidence.agent,
          ...(evidence.note ? { note: evidence.note } : {}),
          evidence: {
            targetStatus,
            rationale: evidence.rationale,
            ...(evidence.implementedByRef
              ? { implementedByRef: evidence.implementedByRef }
              : {}),
            ...(evidence.supersededByRef
              ? { supersededByRef: evidence.supersededByRef }
              : {}),
          },
        },
      ],
    };
    this.writeRecord(updated);
  }

  // ── get / getLinks (§7, Addendum H) ───────────────────────────────────

  async get(idOrHandle: string): Promise<KitRecord | null> {
    return this.files.read(() => {
      const resolvedId = this.resolveId(idOrHandle);
      if (!resolvedId) return null;
      return this.readRecord(resolvedId);
    });
  }

  async getLinks(
    idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }> {
    return this.files.read(() => {
      // Resolve prefix/slug to a full id; fall back to the raw token when it resolves
      // to nothing so an unknown id still returns empty arrays (not throw) — an
      // ambiguous prefix still throws via resolveId.
      const key = this.resolveId(idOrHandle) ?? idOrHandle;
      const graph = this.loadGraph();
      return {
        forward: (graph.forward[key] ?? []).map((l) => ({ ...l })),
        reverse: (graph.reverse[key] ?? []).map((l) => ({ ...l })),
      };
    });
  }

  // ── listByCategory / listByType (§7, B.3/B.5) ─────────────────────────

  async listByCategory(
    category: string,
    options: { prefix?: boolean; includeRetired?: boolean } = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() => {
      const includeRetired = options.includeRetired === true;
      const keep = (r: KitRecord) =>
        includeRetired || (r.status ?? 'active') !== 'retired';
      const records = this.allRecords();
      if (options.prefix) {
        return records.filter(
          (r) =>
            (r.category === category ||
              r.category.startsWith(`${category}.`)) &&
            keep(r),
        );
      }
      return records.filter((r) => r.category === category && keep(r));
    });
  }

  async listByType(
    type: KitRecordType,
    options: { includeRetired?: boolean } = {},
  ): Promise<KitRecord[]> {
    return this.files.read(() => {
      const includeRetired = options.includeRetired === true;
      return this.allRecords().filter(
        (r) =>
          r.type === type &&
          (includeRetired || (r.status ?? 'active') !== 'retired'),
      );
    });
  }
}

export const kitDefaultStoreAdapterDescriptor: KnowledgeAdapterDescriptor = {
  id: 'kit-default-store',
  displayName: 'Default File Store',
  create: async (options) => new KitDefaultStoreAdapter(options),
};
