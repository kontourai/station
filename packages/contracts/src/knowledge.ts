import {
  type RepoRelativePathProblem,
  repoRelativePathProblem,
} from './project-identity.js';

export type KnowledgeNamespaceBehavior = 'rag' | 'inject';

/**
 * A knowledge root anchored to a NAMED repo of the project's manifest
 * (station#1503 slice 5; `docs/design/portable-project-identity.md` §3.2's
 * `{namespaceId, root: {kind: 'repo', repoId, path}}`).
 *
 * This is the producer for a manifest knowledge root that is not
 * `station-managed`. Before it existed, `ProjectManifestStore.composeManifest`
 * mapped every namespace to `{kind: 'station-managed'}` unconditionally, so the
 * repo-rooted arm of {@link ProjectKnowledgeRef} was a documented capability
 * with no writer — the reader-without-a-producer defect the delivery protocol
 * §6 names.
 *
 * It matters for multi-repo specifically: with one repo per project, "the
 * project's directory" and "the repo's checkout" are the same place and scanning
 * the former is accidentally right. With three, a namespace that means "the docs
 * in the API repo" has no way to say so, and the scan silently indexes whichever
 * repo the project's working directory happens to hold.
 */
export interface KnowledgeRepoRoot {
  /**
   * A resource id declared in the project's manifest `repos[]` — for a git
   * resource, its canonical remote. Resolved through `resolveProjectResource`,
   * so a repo that is not bound on THIS Station yields an honest absence rather
   * than using some other repo's checkout.
   */
  repoId: string;
  /**
   * REPO-RELATIVE. Never absolute, tilde-prefixed, drive-letter/UNC, or
   * `..`-escaping — enforced by `isRepoRelativePath`
   * (`@kontourai/station-contracts/project-identity`), the same rule the
   * manifest validator applies, because this value is joined onto a resolved
   * checkout path. `.` names the repo root.
   */
  path: string;
}

export interface KnowledgeNamespaceConfig {
  id: string;
  label: string;
  behavior: KnowledgeNamespaceBehavior;
  description?: string;
  builtIn?: boolean;
  storageDir?: string;
  /**
   * Anchors this namespace to one named repo of the project (station#1503).
   * Absent means the namespace is station-managed, exactly as before — the
   * default is unchanged, and a single-repo project never needs to set it.
   *
   * Precedence is `storageDir` > `repoRoot` > the project's own directory, and
   * that order is deliberate: `storageDir` is an explicit operator choice about
   * where documents live and is not a project resource at all, while `repoRoot`
   * is a statement about WHICH resource this namespace belongs to.
   */
  repoRoot?: KnowledgeRepoRoot;
  writeFiles?: boolean;
  syncOnScan?: boolean;
  enhance?: {
    agent: string;
    auto?: boolean;
  };
}

/**
 * Why a {@link KnowledgeRepoRoot} cannot be accepted, or `undefined` when it can
 * (station#1503 review, H2).
 *
 * ## Why this exists at the WRITE, not only at the read
 *
 * The read side already refuses a bad anchor: the manifest validator rejects a
 * `knowledge[].root.repoId` naming a resource the manifest does not declare, so
 * `composeManifest` fails such a project closed as `unreadable`. That is the
 * right *outcome* — the two alternatives are dropping the namespace (a silent
 * omission) and composing it as `station-managed` (a claim that the operator's
 * anchor is not there) — but it is a terrible *place*: an unreadable manifest
 * fails EVERY seam closed at once (session cwd, knowledge scan, task workspace,
 * the resolution surface), and the operator who caused it is long gone.
 *
 * Review found the writer that makes this reachable rather than theoretical:
 * `PluginManifest.knowledge.namespaces` is typed `KnowledgeNamespaceConfig[]`,
 * so it inherits `repoRoot` the moment that field exists, and
 * `registerPluginNamespaces` copies plugin-declared namespaces into the project
 * verbatim. Installing a plugin could therefore brick a project until someone
 * hand-edited storage.
 *
 * So the refusal moves to the write, where the operator IS present and the
 * repair is obvious. The read-side refusal stays as the backstop for a
 * hand-edited store — it is not redundant, it is the layer that cannot be
 * bypassed.
 */
export type KnowledgeRepoRootProblem =
  /** `repoId` is absent, empty, or not a string. */
  | { code: 'repo-id-missing' }
  /** `path` is absolute, tilde/UNC/drive-lettered, `..`-escaping, or empty. */
  | { code: 'path-invalid'; problem: RepoRelativePathProblem }
  /**
   * `repoId` names no resource this project declares. Only reported when the
   * declared set is KNOWN — see {@link knowledgeRepoRootProblem}.
   */
  | { code: 'repo-not-declared'; declaredRepoIds: string[] };

/**
 * Validates one repo anchor.
 *
 * `declaredRepoIds` is `undefined` when the caller cannot know the declared set
 * — a project with no manifest record. That is not a gap being waved through:
 * with no record there is nothing for `composeManifest` to compose, so the
 * unreadable-manifest failure this guard exists to prevent is unreachable for
 * that project. The SHAPE checks still run, because a traversal-shaped path is
 * wrong whether or not a manifest exists, and it is about to be joined onto a
 * resolved checkout.
 */
export function knowledgeRepoRootProblem(
  repoRoot: KnowledgeRepoRoot,
  declaredRepoIds: readonly string[] | undefined,
): KnowledgeRepoRootProblem | undefined {
  if (typeof repoRoot.repoId !== 'string' || repoRoot.repoId.length === 0) {
    return { code: 'repo-id-missing' };
  }
  const problem = repoRelativePathProblem(repoRoot.path);
  if (problem !== undefined) return { code: 'path-invalid', problem };
  if (declaredRepoIds === undefined) return undefined;
  if (!declaredRepoIds.includes(repoRoot.repoId)) {
    return { code: 'repo-not-declared', declaredRepoIds: [...declaredRepoIds] };
  }
  return undefined;
}

/** The refusal as a sentence an operator can act on. Names ids, never contents. */
export function describeKnowledgeRepoRootProblem(
  namespaceId: string,
  repoRoot: KnowledgeRepoRoot,
  problem: KnowledgeRepoRootProblem,
): string {
  const prefix = `Knowledge namespace "${namespaceId}" anchors to a repo`;
  switch (problem.code) {
    case 'repo-id-missing':
      return `${prefix} but names no repo id. Name one of the project's declared resources, or remove the anchor.`;
    case 'path-invalid':
      return `${prefix} at a path that is not repo-relative (${problem.problem}). The path is joined onto the resolved checkout, so it must stay inside it.`;
    case 'repo-not-declared':
      return `${prefix} this project does not declare ("${repoRoot.repoId}"). Its resources are: ${problem.declaredRepoIds.join(', ') || '(none)'}. Nothing was saved.`;
  }
}

export interface KnowledgeDocumentMeta {
  id: string;
  filename: string;
  namespace: string;
  path: string;
  source: 'upload' | 'directory-scan' | 'sync';
  chunkCount: number;
  /** SHA-256 of the body represented by derived vector chunks. */
  contentHash?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, any>;
  eventId?: string;
  eventSubject?: string;
  enhancedFrom?: string;
  enhancedTo?: string;
  status?: 'raw' | 'enhanced';
}

export interface KnowledgeTreeNode {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: KnowledgeTreeNode[];
  doc?: KnowledgeDocumentMeta;
  fileCount?: number;
}

export interface KnowledgeSearchFilter {
  query?: string;
  metadata?: Record<string, string | string[]>;
  tags?: string[];
  after?: string;
  before?: string;
  pathPrefix?: string;
  status?: string;
}

export const BUILTIN_KNOWLEDGE_NAMESPACES: KnowledgeNamespaceConfig[] = [
  { id: 'default', label: 'Documents', behavior: 'rag', builtIn: true },
  { id: 'rules', label: 'Rules & Steering', behavior: 'inject', builtIn: true },
];
