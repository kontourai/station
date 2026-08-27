/**
 * Namespace-to-project-root compat re-expression (K2 Wave 2, AC4
 * `k2-compat-path-unchanged`). A PURE, descriptor-only mapping: for a project's
 * existing `ProjectConfig.knowledgeNamespaces`, produce one project-scoped
 * `KnowledgeStoreRoot` descriptor per namespace — without reading, writing, or
 * otherwise touching a single byte of the existing namespace data.
 *
 * This is deliberately NOT a migration. K2 must not touch (and this function never
 * does): `{dataDir}/vectordb/**` or `{dataDir}/projects/<slug>/knowledge/**` (the
 * legacy paths `defaultKnowledgeStorageDir`/`knowledgeVectorNamespace` compute — see
 * `src-server/services/knowledge-storage.ts`). The computed `storeRoot` for each
 * mapped `KnowledgeStoreRoot` therefore points at a FRESH location
 * (`{projectHomeDir}/knowledge-stores/projects/<slug>/<namespaceId>`) reserved for the
 * K2 seam, distinct from every legacy path — actually MIGRATING a namespace's existing
 * documents/vectors into a K2 store is explicitly K3's scope (ADR-0009's Migration
 * section), not this function's.
 *
 * Signature note (deviation from the plan's literal
 * `projectNamespacesToRoots(project: ProjectConfig): KnowledgeStoreRoot[]`): a
 * `KnowledgeStoreRoot.storeRoot` is documented as "the absolute path handed to the
 * adapter constructor" (`packages/contracts/src/knowledge-store.ts`) — an absolute
 * path cannot be computed from `ProjectConfig` alone (it has no notion of the
 * Station home directory). This function therefore takes `projectHomeDir` as an
 * explicit second parameter. Grounded, minimal, and documented here rather than
 * silently matching the plan's simplified signature and returning a
 * non-absolute/fabricated path.
 */
import { join } from 'node:path';
import type {
  KnowledgeRootScope,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { ProjectConfig } from '@kontourai/station-contracts/project';

export interface ProjectNamespacesToRootsOptions {
  /** Injectable "now" for deterministic tests (Addendum J.5 precedent). Defaults to `new Date()`. */
  now?: Date;
  /** Which registered adapter backs the mapped roots. Default: `kit-default-store` — the
   * file-format most similar in shape to the legacy per-namespace document storage this
   * is re-expressing. */
  adapterId?: string;
}

/**
 * Fresh K2 storage location for a project namespace's re-expressed root — distinct
 * from every legacy namespace/vectordb path (see module doc above).
 */
export function knowledgeStoreRootPathForNamespace(
  projectHomeDir: string,
  projectSlug: string,
  namespaceId: string,
): string {
  return join(
    projectHomeDir,
    'knowledge-stores',
    'projects',
    projectSlug,
    namespaceId,
  );
}

/**
 * Re-express a project's existing `knowledgeNamespaces` as project-scoped
 * `KnowledgeStoreRoot` descriptors — pure, synchronous, and side-effect-free (no
 * `fs` access at all; verified by the accompanying test via an `fs`-call spy).
 * A project with no `knowledgeNamespaces` maps to an empty array.
 */
export function projectNamespacesToRoots(
  project: ProjectConfig,
  projectHomeDir: string,
  options: ProjectNamespacesToRootsOptions = {},
): KnowledgeStoreRoot[] {
  const namespaces = project.knowledgeNamespaces ?? [];
  if (namespaces.length === 0) return [];

  const createdAt = (options.now ?? new Date()).toISOString();
  const adapterId = options.adapterId ?? 'kit-default-store';
  const scope: KnowledgeRootScope = {
    kind: 'project',
    projectSlug: project.slug,
  };

  return namespaces.map((namespace) => ({
    id: `root:project-${project.slug}:${namespace.id}`,
    scope,
    adapterId,
    storeRoot: knowledgeStoreRootPathForNamespace(
      projectHomeDir,
      project.slug,
      namespace.id,
    ),
    displayName: namespace.label,
    createdAt,
  }));
}
