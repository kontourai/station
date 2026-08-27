/**
 * K2 seam types — Knowledge Kit store layer (ADR-0009 Layer 1).
 *
 * Transcribed from `docs/design/knowledge-foundation.md`'s K2 section, which is itself
 * normative against the Knowledge Kit's published store contract
 * (`kits/knowledge/docs/store-contract.md` §1/§4/§6/§7/§8/§8.1, plus Addendum A.6
 * `supersede` and Addendum B.5 `retire`). Field names and method signatures here are
 * the shared vocabulary both `kit-default-store` and (Wave 2) `kit-obsidian-store`
 * adapters implement — do not rename fields to something not present in that contract.
 *
 * Station never parses or writes the Kit's on-disk format via a Kit-internal import
 * (ADR-0001): adapters implement the *published file format*, not Kit module internals.
 */

// ── Root registry ───────────────────────────────────────────────────────────

/** Scope tier of a store root. Org tier is deferred (ADR-0009) — not in the union on purpose. */
export type KnowledgeRootScope =
  | { kind: 'personal' } // exactly one per user
  | { kind: 'project'; projectSlug: string }; // one or more per project

export interface KnowledgeStoreRoot {
  id: string; // stable id, e.g. 'root:personal', 'root:project-<slug>[:<name>]'
  scope: KnowledgeRootScope;
  adapterId: string; // which registered adapter serves this root
  storeRoot: string; // absolute path handed to the adapter constructor — the Kit's
  // real published axis (store-contract.md §8: `{ storeRoot: string }`)
  displayName: string;
  createdAt: string; // ISO-8601
}

// ── Record envelope (store-contract.md §1, §4, Addendum A.2/A.3, B.1) ──────

/** The four original record types plus Addendum A's `snapshot` and Addendum C's `person`. */
export type KitRecordType =
  | 'raw'
  | 'compiled'
  | 'concept'
  | 'snapshot'
  | 'person';

/** Lifecycle status (Addendum B.1). Records without a `status` are treated as `active`. */
export type KitRecordStatus = 'active' | 'implemented' | 'retired';

/** A directed link from a source record to a target record (store-contract.md §2.1). */
export interface KitLink {
  target_id: string;
  kind: string;
  label?: string;
}

/**
 * An inbound (reverse) edge as returned by `getLinks(id).reverse` and persisted in
 * `graph-index.json`'s `reverse` map (store-contract.md §5.1: `{ source_id, kind }`,
 * with no `label` — the label lives only on the *forward* entry). Deliberately
 * distinct from `KitLink`: a reverse entry names the *source* that points at the
 * queried record, not a `target_id` — the design doc's simplified K2 excerpt
 * collapses this to `KitLink[]`, but §5.1's schema and the Kit's own reference
 * adapter both return `source_id`-shaped objects (no `label`) for `reverse`, which
 * this type follows precisely (see s200-knowledge-store plan notes for the record).
 */
export interface KitReverseLink {
  source_id: string;
  kind: string;
}

/** Immutable creation provenance (store-contract.md §4.1). */
export interface KitProvenance {
  source_ids?: string[];
  agent: string;
  session_id?: string;
  note?: string;
}

/** One append-only mutation log entry (store-contract.md §4.2). */
export interface KitMutationLogEntry {
  op: string;
  at: string; // ISO-8601
  agent: string;
  note?: string;
  evidence?: Record<string, unknown>;
  // supersede/retire log entries carry additional op-specific top-level fields
  // (e.g. `rationale`, `new_id`, `targetStatus`) alongside `evidence`.
  [key: string]: unknown;
}

/** The common record envelope (store-contract.md §1.1) as returned by `get`/list ops. */
export interface KitRecord {
  id: string;
  type: KitRecordType;
  title: string;
  body: string;
  category: string;
  tags?: string[];
  aliases?: string[]; // Addendum H — human-readable, category-scoped slug aliases
  links?: KitLink[];
  provenance: KitProvenance;
  created_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  expires_at?: string; // ISO-8601 (Addendum J — optional record-carried expiry)
  ttl_seconds?: number; // Addendum J — relative expiry in seconds from created_at
  status?: KitRecordStatus;
  mutation_log?: KitMutationLogEntry[];
}

// ── Mutation input/evidence types (store-contract.md §6, A.5, B.4) ─────────

export interface CreateInput {
  id?: string; // adapter generates when omitted
  type: KitRecordType;
  title: string;
  body: string;
  category: string;
  tags?: string[];
  aliases?: string[];
  links?: KitLink[];
  provenance: KitProvenance;
  expires_at?: string;
  ttl_seconds?: number;
}

export interface UpdateFields {
  title?: string;
  body?: string;
  category?: string;
  tags?: string[];
  links?: KitLink[];
  aliases?: string[]; // append-only union with existing aliases (Addendum H.4)
  /** `null`/`""` clears the field (Addendum J.2). */
  expires_at?: string | null;
  ttl_seconds?: number | null;
}

export interface UpdateEvidence {
  agent: string;
  note?: string;
}

export interface LinkEvidence {
  agent: string;
  note?: string;
}

export interface ProposeEvidence {
  agent: string;
  proposal: string;
}

export interface ApplyEvidence {
  agent: string;
  new_body: string;
  rationale: string;
}

export interface RejectEvidence {
  agent: string;
  reason: string;
}

/** Addendum A.6 — `supersede` evidence. */
export interface SupersedeEvidence {
  agent: string;
  rationale: string;
  note?: string;
}

/** Addendum B.5 — `retire` evidence. `implementedByRef` required iff targetStatus === 'implemented'. */
export interface RetireEvidence {
  agent: string;
  rationale: string;
  implementedByRef?: string;
  supersededByRef?: string;
  note?: string;
}

// ── Error contract (store-contract.md §8.1) ────────────────────────────────

export type KnowledgeStoreErrorCode =
  | 'MISSING_EVIDENCE'
  | 'NOT_FOUND'
  | 'AMBIGUOUS_ID'
  | 'SLUG_CONFLICT'
  /**
   * station#1879: a Station extension BEYOND store-contract §8.1 — the published
   * Kit contract has no notion of a non-writing adapter, so this code is not part
   * of the upstream error vocabulary. Thrown by adapters that implement
   * `KnowledgeStoreAdapter` over a derived, read-only projection (e.g. Station's
   * conversation-history root) from every one of the eight mutation verbs
   * (`create`/`update`/`link`/`propose`/`apply`/`reject`/`supersede`/`retire`).
   * A conformant, non-Station reader of the same contract will not encounter this
   * code, because a non-Station adapter never returns it.
   */
  | 'READ_ONLY';

export interface KnowledgeStoreError extends Error {
  code: KnowledgeStoreErrorCode;
  /** Populated on AMBIGUOUS_ID — the colliding full ids (Addendum H.3). */
  matches?: string[];
}

// ── Adapter contract (store-contract.md §8 + Addendum A.6/B.5, Addendum H) ─

/**
 * The Kit's adapter contract, §8 verbatim (+ A.6 supersede, B.5 retire).
 * Station TYPES this seam but the implementations are Station-owned adapters
 * (`kit-default-store`, `kit-obsidian-store`) that read/write the Kit's published
 * on-disk file format directly — never a deep/internal import of the Kit package
 * (ADR-0001; the Kit's own `exports` map does not expose these modules for import).
 */
export interface KnowledgeStoreAdapter {
  create(record: CreateInput): Promise<string>;
  update(
    id: string,
    fields: UpdateFields,
    evidence: UpdateEvidence,
  ): Promise<void>;
  link(
    sourceId: string,
    links: KitLink[],
    evidence: LinkEvidence,
  ): Promise<void>;
  propose(
    conceptId: string,
    proposerId: string,
    evidence: ProposeEvidence,
  ): Promise<void>;
  apply(
    conceptId: string,
    proposerId: string,
    evidence: ApplyEvidence,
  ): Promise<void>;
  reject(
    conceptId: string,
    proposerId: string,
    evidence: RejectEvidence,
  ): Promise<void>;
  supersede(
    newId: string,
    supersededIds: string[],
    evidence: SupersedeEvidence,
  ): Promise<void>; // A.6
  retire(
    id: string,
    targetStatus: 'implemented' | 'retired',
    evidence: RetireEvidence,
  ): Promise<void>; // B.5
  /** Addendum H: idOrHandle may be a full id, a slug alias, or an unambiguous ≥8-char id prefix. */
  get(idOrHandle: string): Promise<KitRecord | null>;
  getLinks(
    idOrHandle: string,
  ): Promise<{ forward: KitLink[]; reverse: KitReverseLink[] }>;
  // B.5 also adds `includeRetired?: boolean` to both list methods' options (default: excludes retired).
  listByCategory(
    category: string,
    options?: { prefix?: boolean; includeRetired?: boolean },
  ): Promise<KitRecord[]>;
  listByType(
    type: KitRecordType,
    options?: { includeRetired?: boolean },
  ): Promise<KitRecord[]>;
}

/** Adapter registration — additive, mirroring `registerConnectionFactory`. */
export interface KnowledgeAdapterDescriptor {
  id: string; // 'kit-default-store' | 'kit-obsidian-store' | plugin-contributed
  displayName: string;
  create(options: { storeRoot: string }): Promise<KnowledgeStoreAdapter>;
  /** e.g. the Obsidian adapter validating an existing vault; optional. */
  validateRoot?(storeRoot: string): Promise<{ ok: boolean; reason?: string }>;
}

/** The K2 seam Station's services and routes consume. */
export interface KnowledgeStoreProvider {
  // Root registry
  listRoots(): Promise<KnowledgeStoreRoot[]>;
  getRoot(rootId: string): Promise<KnowledgeStoreRoot | null>;
  createRoot(
    input: Omit<KnowledgeStoreRoot, 'id' | 'createdAt'>,
  ): Promise<KnowledgeStoreRoot>;
  removeRoot(rootId: string): Promise<void>; // deregisters only — NEVER deletes store files

  // Adapter registry (additive provider pattern; plugins may contribute)
  registerAdapter(descriptor: KnowledgeAdapterDescriptor): void;
  listAdapters(): KnowledgeAdapterDescriptor[];

  /**
   * K4 onboarding hook (additive): validates a candidate `storeRoot` against a
   * REGISTERED adapter's own `validateRoot` hook (e.g. the Obsidian adapter
   * checking for a real vault) BEFORE a root is created — never rewrites the
   * adapter's own `reason` string (dishonest-validation stop-short risk).
   * An adapter with no `validateRoot` hook (e.g. `kit-default-store`, which is
   * always safe to create fresh) is trivially `{ ok: true }`. An unknown
   * `adapterId` is `{ ok: false, reason }`, never a throw — callers always get
   * the same `{ ok, reason? }` shape regardless of why validation failed.
   */
  validateRootForAdapter(
    adapterId: string,
    storeRoot: string,
  ): Promise<{ ok: boolean; reason?: string }>;

  // Record access — thin delegation to the root's adapter instance
  adapterFor(rootId: string): Promise<KnowledgeStoreAdapter>;

  // Change signal for the derived index (K3 subscribes; see rebuild contract)
  onRecordsChanged(
    listener: (event: { rootId: string; recordIds: string[] }) => void,
  ): () => void;
}
