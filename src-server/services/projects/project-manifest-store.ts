/**
 * archive#1499 — the project manifest sidecar
 * (`docs/design/portable-project-identity.md` §3.2, §5).
 *
 * `<home>/projects/<slug>/manifest.json` is additive: `project.json` keeps its
 * exact shape, and a Station with no manifests behaves identically to before
 * this module existed. The absence of a manifest IS the compat shim (§5.1) —
 * there is no flag.
 *
 * Load-bearing decisions:
 *
 * 1. **The SIDECAR persists only what has no other source of truth.** §3.2's
 *    illustrative manifest carries `slug`, `name`, `icon`, `description`,
 *    `agents`, and `knowledge`, every one of which already lives in
 *    `project.json`. Writing them here would create a second, drifting copy of
 *    a value that has an owner — the exact defect archive#1497 closed at the
 *    layout layer, which §5 warns "would be much worse" at this layer. So
 *    {@link ProjectManifestRecord} holds `{ schemaVersion, id, repos,
 *    createdAt, updatedAt }` and nothing else, and
 *    {@link ProjectManifestStore.readProjectManifest} composes the full
 *    §3.2 {@link ProjectManifest} by joining the record with the LIVE
 *    `project.json` on every read. Renaming a project is therefore reflected
 *    with no sidecar write at all.
 * 2. **Backfill runs from a WRITE path only, and is an exclusive create.**
 *    `docs/strategy/multi-agent-delivery-protocol.md` §6 is unconditional —
 *    "a projection/join that mutates state on read is a defect EVEN WHEN THE
 *    WRITE LOOKS IDEMPOTENT" — so the exclusive-create argument that once
 *    justified calling this from `resolveProjectResource` does not survive it,
 *    and that call is gone (see `project-resource-resolver.ts`). The callers
 *    are write boundaries: `ProjectService.createProject` today, the explicit
 *    bind/re-derive actions in slices 3–4 next. §5's "the legacy path shrinks
 *    monotonically" defence only ever needed the create path.
 *
 *    The exclusive create still matters for concurrency: two writers racing on
 *    the same slug must not produce two portable ids. The write either creates
 *    the file or fails with `EEXIST`, and on `EEXIST` the loser RE-READS THE
 *    WINNER AND ADOPTS IT. Do not "simplify" this into a plain write: a plain
 *    write turns a losing racer into a silent clobber of the winner's portable
 *    `id` — the one field in this system that must never change once anything
 *    has joined on it (archive#1392 channels, archive#1123 delegation, archive#1409 provenance).
 *
 *    It is ALSO atomic. `writeFileSync(path, data, { flag: 'wx' })` is
 *    open(O_CREAT|O_EXCL) → write → close: the file exists at zero bytes in
 *    between, unflushed. A crash there leaves a zero-length `manifest.json`
 *    that this store refuses to read and `ensureProjectManifest` cannot repair
 *    (it reads first), i.e. a permanently bricked project — the strongest
 *    failure in the slice attached to the weakest write. {@link
 *    writeManifestRecordExclusively} writes a same-directory temp file,
 *    `fsync`s it, and `link`s it into place: `link` fails `EEXIST` when the
 *    target exists, so exclusivity is preserved AND the target only ever
 *    appears complete. (`rename` would be atomic but would silently overwrite
 *    the winner, which is the one thing that must never happen here.)
 * 3. **`schemaVersion` GATES parsing; it is never cast** (§2.5's
 *    `KnownEnvironment` lesson — a version written by every producer and read
 *    by none). An unknown version throws
 *    {@link ProjectManifestSchemaVersionError} rather than being treated as
 *    absent, because "treated as absent" would silently downgrade a project to
 *    the legacy path and then try to backfill over a manifest this Station
 *    cannot understand.
 * 4. **Backfill NEVER writes a binding row** (§5 point 2). During compat
 *    `ProjectConfig.workingDirectory` stays authoritative, and a binding whose
 *    `path` merely duplicates `workingDirectory` would be — again — a second
 *    copy of a value that has an owner. The resolver falls back to
 *    `workingDirectory` for a manifest resource that has no binding; the
 *    binding store's write path exists for the explicit bind action (slice 4).
 * 5. **A derivation that cannot be performed writes NOTHING.** If `git` cannot
 *    be run, or the checkout advertises several remotes and none is `origin`,
 *    the backfill returns `unavailable` instead of recording a `local-only`
 *    resource. Recording local-only there would permanently mark a portable
 *    project non-portable on the strength of a transient failure — a default
 *    that decides (`docs/guides/code-quality.md`), and one nothing later
 *    corrects because the sidecar is written exactly once.
 * 6. **A path-shaped origin is `local-only`, never a `git` identity** (§3.2:
 *    "no absolute or tilde-prefixed paths, anywhere", and `id` is "portable and
 *    opaque … not derived from any repo, path, or machine"). `git clone
 *    /var/folders/…/mirror` is an ordinary workflow whose `origin` is a
 *    filesystem path; canonicalizing it yields an absolute, LOWERCASED path
 *    that names nothing on another machine and may not even name the right
 *    directory on a case-sensitive filesystem here. {@link
 *    isLocalCloneSource} refuses those, and the resource is recorded as the
 *    local-only thing it actually is. Slice 1's `validateRepoResource` refuses
 *    the same shape on the read side, so the two must land together: the
 *    validator alone would make this backfill write a manifest it then cannot
 *    read back.
 *
 * 7. **UNREADABLE and UNSELECTABLE are different failures** (slice 1's
 *    decision 11, archive#1499). {@link ProjectManifestStore.composeManifest}
 *    runs slice 1's validator on every read, and slice 1 enforces §3.5's
 *    primary cardinality there — so a manifest with two primaries, or with
 *    several resources and none, would fail a read. That manifest is not
 *    unreadable: every field parses and every resource is well-formed; it
 *    simply cannot name ONE resource for a caller that asked for "the
 *    primary". §3.6 has a state for exactly that (`ambiguous`), and throwing
 *    instead converts this arc's central idiom — an honest unavailable —
 *    into an exception the caller cannot answer. So a failure whose
 *    diagnostics are ALL selection ambiguities returns the composed manifest
 *    and leaves the choice to the resolver, and everything else still fails
 *    closed. The classification is by
 *    {@link isSelectionAmbiguityOnly} over the validator's structured
 *    diagnostics — never by matching error message text, which would be a
 *    stringly-typed join across a package boundary.
 *
 * DISCLOSED GAP: the composed manifest's `integrations` is always `[]`.
 * Station's integrations are global (`<home>/integrations/<id>/`) and
 * `ProjectConfig` carries no per-project integration list, so no producer for
 * that field exists yet. It is reported as empty rather than invented, and
 * nothing in this slice exports a manifest to a peer.
 */

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import {
  isLocalCloneSource,
  isSelectionAmbiguityOnly,
  PROJECT_MANIFEST_SCHEMA_VERSION,
  type ProjectManifest,
  type ProjectRepoResource,
  validateProjectManifest,
} from '@kontourai/station-contracts/project-identity';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { projectManifestBackfills } from '../../telemetry/metrics.js';
import { expandTilde } from '../../utils/paths.js';
import {
  type CheckoutRemoteReader,
  readCheckoutRemotes,
} from './checkout-remote-reader.js';
import {
  applyHostAlias,
  ProjectBindingsStore,
} from './project-binding-store.js';

export const PROJECT_MANIFEST_FILENAME = 'manifest.json';

/**
 * The on-disk sidecar. Deliberately a strict subset of {@link ProjectManifest}
 * — see decision 1. Everything omitted here is joined from `project.json` (or
 * the layout store) at read time.
 */
export interface ProjectManifestRecord {
  schemaVersion: typeof PROJECT_MANIFEST_SCHEMA_VERSION;
  /** Portable, opaque, generated once. Never machine- or path-derived (§3.2). */
  id: string;
  repos: ProjectRepoResource[];
  createdAt: string;
  updatedAt: string;
}

export class ProjectManifestSchemaVersionError extends Error {
  constructor(
    readonly filePath: string,
    readonly foundVersion: unknown,
  ) {
    super(
      `Project manifest schema version is not readable (expected ${PROJECT_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(foundVersion)}): ${filePath}`,
    );
    this.name = 'ProjectManifestSchemaVersionError';
  }
}

export class ProjectManifestUnreadableError extends Error {
  constructor(
    readonly filePath: string,
    readonly problems: string[],
  ) {
    super(
      `Project manifest is not readable: ${filePath}\n- ${problems.join('\n- ')}`,
    );
    this.name = 'ProjectManifestUnreadableError';
  }
}

/**
 * A sidecar that exists but holds no content at all. Distinct from
 * {@link ProjectManifestUnreadableError} on purpose: malformed content is
 * something a human (or a future version) wrote, while a zero-length file is
 * the signature of an INTERRUPTED WRITE. The repair differs — this one is safe
 * to delete and re-derive, and nothing was ever joined on the id it does not
 * contain. See decision 2 for why the write path makes this unreachable for
 * writes this Station performs.
 */
export class ProjectManifestIncompleteError extends ProjectManifestUnreadableError {
  constructor(filePath: string) {
    super(filePath, [
      'file is zero-length — the signature of an interrupted write, not manifest content. It holds no portable id, so it is safe to delete and let the manifest be re-derived.',
    ]);
    this.name = 'ProjectManifestIncompleteError';
  }
}

export function projectManifestPath(homeDir: string, slug: string): string {
  return join(homeDir, 'projects', slug, PROJECT_MANIFEST_FILENAME);
}

/** The subset of the storage adapter a manifest read needs. */
export type ProjectManifestSource = Pick<
  IStorageAdapter,
  'getProject' | 'listLayouts'
>;

export type EnsureProjectManifestResult =
  | {
      outcome: 'existing' | 'created' | 'adopted-existing';
      record: ProjectManifestRecord;
    }
  /** Identity could not be derived truthfully right now; nothing was written. */
  | { outcome: 'unavailable'; reason: string };

export interface ProjectManifestStoreOptions {
  /** Host aliases come from the binding store — checkout side only (§3.3(a)). */
  bindings?: ProjectBindingsStore;
  readRemotes?: CheckoutRemoteReader;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateManifestRecord(
  value: unknown,
  filePath: string,
): ProjectManifestRecord {
  if (!isPlainObject(value)) {
    throw new ProjectManifestUnreadableError(filePath, ['must be an object']);
  }
  // Gate FIRST: a version this Station does not know is refused by name, never
  // cast and never treated as absent (decision 3).
  if (value.schemaVersion !== PROJECT_MANIFEST_SCHEMA_VERSION) {
    throw new ProjectManifestSchemaVersionError(filePath, value.schemaVersion);
  }
  const problems: string[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) {
    problems.push('id: must be a non-empty string');
  }
  if (!Array.isArray(value.repos)) {
    problems.push('repos: must be an array');
  }
  if (typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    problems.push('createdAt: must be a non-empty string');
  }
  if (typeof value.updatedAt !== 'string' || value.updatedAt.length === 0) {
    problems.push('updatedAt: must be a non-empty string');
  }
  if (problems.length > 0) {
    throw new ProjectManifestUnreadableError(filePath, problems);
  }
  // Per-resource §3.2 rules stay with slice 1's validator, applied to the
  // COMPOSED manifest in `readProjectManifest` — one authority, not two.
  return value as unknown as ProjectManifestRecord;
}

/**
 * `fsync` on a WRITE descriptor — Windows implements it as FlushFileBuffers
 * and returns EPERM on a read-only handle (archive#1162, the same gotcha
 * `json-store.ts` records).
 */
function fsyncManifestFile(filePath: string): void {
  const fd = openSync(filePath, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Creates `filePath` with exactly `contents`, ATOMICALLY and EXCLUSIVELY
 * (decision 2). Writes a same-directory temp file, `fsync`s it, then `link`s
 * it into place:
 *
 * - `link` fails with `EEXIST` when the target exists, so the exclusive-create
 *   semantics the adopt-the-winner path depends on are preserved. (`rename`
 *   would be atomic too, but it would silently replace the winner's portable
 *   `id`.)
 * - the target is only ever observed complete, so an interrupted write cannot
 *   leave a zero-length `manifest.json` that permanently bricks the project.
 *
 * Throws the underlying `ErrnoException` (including `EEXIST`) to the caller.
 */
export function writeManifestRecordExclusively(
  filePath: string,
  contents: string,
): void {
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(tempPath, contents, { flag: 'wx' });
    fsyncManifestFile(tempPath);
    linkSync(tempPath, filePath);
    try {
      fsyncDirectorySync(directory);
    } catch {
      // Directory fsync is unavailable on some hosts/filesystems. A durability
      // limitation is not a reason to fall back to an in-place write.
    }
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best-effort cleanup: the temp file is never the manifest of record.
    }
  }
}

/**
 * One line per resource, sorted, covering exactly the identity-bearing fields.
 * Used to tell "adopted a record that says what we derived" from "adopted a
 * record that CONTRADICTS what we derived" — the second is a real divergence
 * an operator may need to know about, and an undifferentiated
 * `adopted-existing` metric cannot express it.
 */
function repoFingerprints(repos: ProjectRepoResource[]): string[] {
  return repos
    .map((repo) => {
      if (repo.kind !== 'git') return `local-only ${repo.id}`;
      const aliases = repo.aliases ?? [];
      return `git ${repo.id} canonicalRemote=${repo.canonicalRemote} role=${repo.role ?? '(none)'} aliases=[${[...aliases].sort().join(', ')}]`;
    })
    .sort();
}

/**
 * A canonical remote that is really a filesystem path (decision 6). `git clone
 * /path/to/mirror` and `git clone ../sibling` are ordinary workflows, and their
 * `origin` canonicalizes to something that is neither portable nor opaque.
 *
 * The rule itself lives in `@kontourai/station-contracts/project-identity` as
 * `isLocalCloneSource`, and this module calls it rather than restating it.
 * Delta review measured the two copies diverging in BOTH directions — one
 * of which persisted a manifest the validator could never read back, with no
 * write to repair it. Its disclosed residual is documented there.
 */

export class ProjectManifestStore {
  private readonly bindings: ProjectBindingsStore;
  private readonly readRemotes: CheckoutRemoteReader;

  constructor(
    private readonly homeDir: string,
    private readonly source: ProjectManifestSource,
    options: ProjectManifestStoreOptions = {},
  ) {
    this.bindings = options.bindings ?? new ProjectBindingsStore(homeDir);
    this.readRemotes = options.readRemotes ?? readCheckoutRemotes;
  }

  manifestPath(slug: string): string {
    return projectManifestPath(this.homeDir, slug);
  }

  /** The raw sidecar. `undefined` means no manifest exists (the compat state). */
  readRecord(slug: string): ProjectManifestRecord | undefined {
    const filePath = this.manifestPath(slug);
    if (!existsSync(filePath)) return undefined;
    const contents = readFileSync(filePath, 'utf-8');
    if (contents.trim().length === 0) {
      throw new ProjectManifestIncompleteError(filePath);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(contents);
    } catch (error) {
      // A corrupt sidecar is NOT "no manifest": treating it as absent would
      // downgrade the project to the legacy path and then attempt a backfill
      // that can never succeed.
      throw new ProjectManifestUnreadableError(filePath, [
        `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    return validateManifestRecord(raw, filePath);
  }

  /**
   * The full §3.2 manifest: the sidecar record joined with the LIVE
   * `project.json` (and the live layout store) on every read — decision 1.
   * Throws if the project does not exist, or if the composed manifest is
   * UNREADABLE. A manifest that is readable but from which no single resource
   * can be selected is returned as-is — decision 7.
   */
  readProjectManifest(slug: string): ProjectManifest | undefined {
    const record = this.readRecord(slug);
    if (!record) return undefined;
    return this.composeManifest(record, this.source.getProject(slug));
  }

  composeManifest(
    record: ProjectManifestRecord,
    project: ProjectConfig,
  ): ProjectManifest {
    const candidate: ProjectManifest = {
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      id: record.id,
      // Every field below comes from the live project record, never from the
      // sidecar — that is what makes a rename a zero-write operation.
      slug: project.slug,
      name: project.name,
      ...(project.icon === undefined ? {} : { icon: project.icon }),
      ...(project.description === undefined
        ? {}
        : { description: project.description }),
      repos: record.repos,
      // `?? []` here is a composition default, not a decision default: an
      // absent list on the project record means the project declares none.
      //
      // archive#1503 — a namespace anchored to a named repo composes as
      // §3.2's `{kind: 'repo', repoId, path}`. Before this, EVERY namespace
      // composed as `station-managed` unconditionally, so that arm of
      // `ProjectKnowledgeRef` was a documented shape with no writer.
      //
      // The reference is emitted VERBATIM, including one that names a repo this
      // manifest does not declare. Slice 1's validator refuses that, so such a
      // project reads as `unreadable` (with the field path and the bad id in
      // the reason) rather than resolving with the reference quietly rewritten.
      // That IS severe — an unreadable manifest fails every seam closed — and it
      // is the deliberate choice: the two alternatives are dropping the
      // namespace (a silent omission) and composing it as `station-managed` (a
      // claim that the operator's repo anchor is not there), and both hide a
      // misconfiguration in the layer that is supposed to surface it. The
      // knowledge scanner independently refuses the same reference with its own
      // message, so the scan fails closed even where this composition is never
      // read.
      knowledge: (project.knowledgeNamespaces ?? []).map((namespace) => ({
        namespaceId: namespace.id,
        root: namespace.repoRoot
          ? {
              kind: 'repo' as const,
              repoId: namespace.repoRoot.repoId,
              path: namespace.repoRoot.path,
            }
          : { kind: 'station-managed' as const },
      })),
      agents: [...(project.agents ?? [])],
      // Disclosed gap (see the module docblock): no producer exists yet.
      integrations: [],
      layouts: this.source.listLayouts(project.slug).map((layout) => layout.id),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const validation = validateProjectManifest(candidate);
    if (!validation.ok) {
      if (!isSelectionAmbiguityOnly(validation.diagnostics)) {
        throw new ProjectManifestUnreadableError(
          this.manifestPath(project.slug),
          validation.errors,
        );
      }
      // Decision 7: readable, but no single resource is selectable from it.
      // `candidate` is the same object the validator would have returned; the
      // only assertions it failed are §3.5's cardinality rules, which are the
      // resolver's `ambiguous` answer, not this reader's failure.
      return candidate;
    }
    return validation.manifest;
  }

  /**
   * Backfill (§5 point 4) — see decision 2 for why this is a write-path-only
   * operation and an exclusive, atomic create, and decision 4 for why it
   * writes no binding row.
   */
  async ensureProjectManifest(
    project: ProjectConfig,
  ): Promise<EnsureProjectManifestResult> {
    const existing = this.readRecord(project.slug);
    if (existing) return { outcome: 'existing', record: existing };

    const derived = await this.deriveRepos(project);
    if (!derived.ok) {
      projectManifestBackfills.add(1, { outcome: 'unavailable' });
      return { outcome: 'unavailable', reason: derived.reason };
    }

    const now = new Date().toISOString();
    const candidate: ProjectManifestRecord = {
      schemaVersion: PROJECT_MANIFEST_SCHEMA_VERSION,
      id: `prj_${randomUUID()}`,
      repos: derived.repos,
      createdAt: now,
      updatedAt: now,
    };
    const filePath = this.manifestPath(project.slug);
    try {
      writeManifestRecordExclusively(
        filePath,
        `${JSON.stringify(candidate, null, 2)}\n`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Lost the race. The winner's `id` is the project's identity now; adopt
      // it rather than clobbering it (decision 2).
      const winner = this.readRecord(project.slug);
      if (!winner) {
        throw new ProjectManifestUnreadableError(filePath, [
          'exclusive create reported EEXIST but no manifest could be read back',
        ]);
      }
      // Adopting a record that AGREES with what we derived and adopting one
      // that contradicts it are different events. The second means two writers
      // observed different identities for the same project, and it is the
      // operator's to resolve — so it is named here rather than folded into an
      // undifferentiated `adopted-existing`.
      const derivedFingerprints = repoFingerprints(candidate.repos);
      const adoptedFingerprints = repoFingerprints(winner.repos);
      const divergent =
        derivedFingerprints.join('\n') !== adoptedFingerprints.join('\n');
      projectManifestBackfills.add(1, {
        outcome: 'adopted-existing',
        adopted: divergent ? 'divergent' : 'identical',
      });
      if (divergent) {
        console.warn(
          `Project manifest backfill adopted an existing sidecar whose resources CONTRADICT this derivation: ${filePath}\n  adopted: ${adoptedFingerprints.join('; ') || '(none)'}\n  derived: ${derivedFingerprints.join('; ') || '(none)'}`,
        );
      }
      return { outcome: 'adopted-existing', record: winner };
    }
    projectManifestBackfills.add(1, { outcome: 'created' });
    return { outcome: 'created', record: candidate };
  }

  /**
   * §5: `repos` is the canonicalized `origin` of the working directory when it
   * is a git checkout with a remote, and a `local-only` resource otherwise —
   * including the seeded `default` project, which has no directory at all.
   */
  private async deriveRepos(
    project: ProjectConfig,
  ): Promise<
    { ok: true; repos: ProjectRepoResource[] } | { ok: false; reason: string }
  > {
    const localOnly = {
      ok: true as const,
      repos: [
        {
          kind: 'local-only' as const,
          // This DOES persist a copy of `slug`, three lines above a comment
          // refusing to persist `label` for that reason — deliberately. `slug`
          // is immutable (the on-disk project directory and every
          // `/api/projects/:slug/*` route are keyed by it, and nothing renames
          // it), so this copy cannot drift the way `name` would; and a
          // manifest-local id for a resource that has no portable identity has
          // no other source to derive from. If `slug` ever becomes mutable,
          // this becomes a real second copy and must move to an opaque id.
          id: `local:${project.slug}`,
          // Deliberately NO `label`. Deriving one from `project.name` would
          // persist a copy of the name in the sidecar and drift on the very
          // next rename — decision 1, caught by this module's own
          // "persists ONLY id/repos/timestamps" test. `label` stays for a
          // manifest AUTHORED with a deliberate, shared name (§3.2).
        },
      ],
    };

    const workingDirectory = project.workingDirectory?.trim();
    if (!workingDirectory) return localOnly;
    // `expandTilde` FIRST (`path.resolve` does not expand `~` and would
    // silently probe `<cwd>/~/dev`), then `resolve`, because `expandTilde`
    // alone leaves a relative `workingDirectory` relative — and every
    // filesystem call below would then be evaluated against the SERVER
    // PROCESS's cwd rather than anything the operator chose.
    const absolute = resolve(expandTilde(workingDirectory));
    if (!existsSync(absolute)) return localOnly;

    const result = await this.readRemotes(absolute);
    if (!result.ok) {
      // Decision 5: refuse to record an identity we could not read.
      return { ok: false, reason: result.reason };
    }
    if (result.remotes.length === 0) return localOnly;

    const origin =
      result.remotes.find((remote) => remote.name === 'origin') ??
      (result.remotes.length === 1 ? result.remotes[0] : undefined);
    if (!origin) {
      // Never a coin flip: several remotes and no `origin` has no truthful
      // primary, so nothing is written and the project stays on the legacy
      // path until an operator binds it explicitly (slice 4).
      return {
        ok: false,
        reason: `checkout ${absolute} advertises no "origin" remote; candidates: ${result.remotes
          .map((remote) => remote.name)
          .join(', ')}`,
      };
    }

    // Host aliases are machine-local knowledge about a LOCAL CHECKOUT and are
    // applied before canonicalization (§3.3(a)); they are never applied to a
    // value already in a manifest.
    const canonicalRemote = normalizeGitOrigin(
      applyHostAlias(origin.url, this.bindings.hostAliases()),
    );
    if (canonicalRemote.length === 0) return localOnly;
    // Decision 6: a path-shaped origin is a local clone, not a portable
    // identity. Recording it would put an absolute, lowercased filesystem path
    // in `id`/`canonicalRemote`, which §3.2 refuses outright.
    if (isLocalCloneSource(canonicalRemote)) return localOnly;
    return {
      ok: true,
      repos: [
        {
          kind: 'git',
          id: canonicalRemote,
          canonicalRemote,
          role: 'primary',
        },
      ],
    };
  }
}
