import { createHash } from 'node:crypto';
import type {
  ReviewGitTarget,
  ReviewGitTargetInput,
} from '@kontourai/station-contracts/review-evidence';
import { classifyNodes } from '@kontourai/veritas/engine';
import { execGit } from '../../utils/git-exec.js';
import {
  type GitReviewRangeInspection,
  inspectGitReviewRange,
} from './git-review-workspace-source.js';

const POLICY_INPUTS = [
  '.veritas/repo-map.json',
  'config/review-lenses.json',
  'packages/contracts/src/review-evidence.ts',
  'src-server/runtime/routes/runtime-routes.ts',
  'src-server/services/evidence/review-lens-router.ts',
  'src-server/services/evidence/git-review-workspace-source.ts',
  'src-server/services/evidence/orchestration-review-executor.ts',
  'src-server/services/evidence/repo-map-review-selection.ts',
  'src-server/services/evidence/review-evidence-module.ts',
  'src-server/providers/adapters/codex-approval-mode.ts',
  'src-server/providers/adapters/codex-adapter.ts',
  'src-server/services/orchestration/orchestration-service.ts',
] as const;
const SHA = /^[0-9a-f]{40}$/;

export interface ReviewLensDefinition {
  id: string;
  nodeIds: string[];
  instructions: string;
}

export interface ReviewLensPlan {
  kind: 'planned';
  lenses: ReviewLensDefinition[];
  /** Trusted registry snapshot for retaining prior lens IDs without reuse. */
  registry: ReviewLensDefinition[];
  affectedNodes: string[];
  target: ReviewGitTarget;
  policy: {
    revision: string;
    repoMapSha256: string;
    registrySha256: string;
    routerVersion: 1;
  };
  changes: ReviewPathChange[];
}

export type ReviewLensRouting =
  | ReviewLensPlan
  | { kind: 'no-change'; changes: [] }
  | {
      kind: 'human-review-required';
      reason: string;
      unavailableLenses: string[];
      changes: ReviewPathChange[];
    };

export interface ReviewPathChange {
  status: string;
  oldPath?: string;
  newPath?: string;
}

/**
 * Deterministic, policy-only planning. This module never creates a workspace,
 * allocates an Agent, or invokes a model. Policy is always read with git-show
 * from the server-selected trusted revision, never from the candidate tree.
 */
export class ReviewLensRouter {
  constructor(private readonly policyRevision = 'origin/main') {}

  async plan(input: {
    repositoryRoot: string;
    target?: ReviewGitTargetInput;
    /** Test-only legacy shape; production selection passes `target`. */
    baseSha?: string;
    headSha?: string;
  }): Promise<ReviewLensRouting> {
    let inspection: GitReviewRangeInspection;
    try {
      inspection = await inspectGitReviewRange(
        input.repositoryRoot,
        input.target ?? {
          kind: 'git-range',
          projectSlug: 'review-routing',
          baseRevision: input.baseSha ?? '',
          headRevision: input.headSha ?? '',
        },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('no revision change')
      ) {
        return { kind: 'no-change', changes: [] };
      }
      throw error;
    }
    const changes = inspection.changes;
    if (!changes.length) return { kind: 'no-change', changes: [] };

    if (changesTouchPolicy(changes)) {
      return humanRequired(
        'Review routing policy changed in the candidate.',
        changes,
      );
    }
    let policySha: string;
    let repoMapText: string;
    let registryText: string;
    try {
      policySha = await revision(input.repositoryRoot, this.policyRevision);
      [repoMapText, registryText] = await Promise.all([
        gitShow(input.repositoryRoot, policySha, '.veritas/repo-map.json'),
        gitShow(input.repositoryRoot, policySha, 'config/review-lenses.json'),
      ]);
    } catch {
      return humanRequired(
        'Trusted review routing policy is unavailable.',
        changes,
      );
    }
    let repoMap: unknown;
    let registry: ReviewLensDefinition[];
    try {
      repoMap = JSON.parse(repoMapText);
      registry = parseRegistry(JSON.parse(registryText));
    } catch {
      return humanRequired(
        'Trusted review routing policy is malformed.',
        changes,
      );
    }
    const paths = routingPaths(changes);
    let classified: ReturnType<typeof classifyNodes>;
    try {
      classified = classifyNodes(paths, repoMap, input.repositoryRoot);
    } catch {
      return humanRequired(
        'Trusted Repo Map could not classify the change.',
        changes,
      );
    }
    if (classified.unmatchedFiles.length) {
      return humanRequired(
        'Changed paths are not covered by the trusted Repo Map.',
        changes,
      );
    }
    const coveredNodeIds = new Set(registry.flatMap((lens) => lens.nodeIds));
    const uncoveredPaths = Object.entries(classified.fileNodes).filter(
      ([, nodes]) => nodes.some((node) => !coveredNodeIds.has(node.id)),
    );
    if (uncoveredPaths.length) {
      return humanRequired(
        'Changed Repo Map paths have no configured review lens coverage.',
        changes,
      );
    }
    const nodeSet = new Set(classified.affectedNodes);
    const lenses = registry
      .filter((lens) => lens.nodeIds.some((nodeId) => nodeSet.has(nodeId)))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!lenses.length) {
      return humanRequired(
        'No trusted review lens covers the affected Repo Map nodes.',
        changes,
      );
    }
    return {
      kind: 'planned',
      lenses,
      registry,
      affectedNodes: [...nodeSet].sort(),
      target: inspection.target,
      policy: {
        revision: policySha,
        repoMapSha256: digest(repoMapText),
        registrySha256: digest(registryText),
        routerVersion: 1,
      },
      changes,
    };
  }
}

function humanRequired(
  reason: string,
  changes: ReviewPathChange[],
): ReviewLensRouting {
  return {
    kind: 'human-review-required',
    reason,
    unavailableLenses: ['human-review'],
    changes,
  };
}

function parseRegistry(value: unknown): ReviewLensDefinition[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review lens registry must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !['version', 'lenses'].includes(key)) ||
    record.version !== 1 ||
    !Array.isArray(record.lenses) ||
    !record.lenses.length ||
    record.lenses.length > 8
  ) {
    throw new Error('Review lens registry is invalid.');
  }
  const lenses = record.lenses.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Review lens registry entry is invalid.');
    }
    const lens = entry as Record<string, unknown>;
    if (
      Object.keys(lens).some(
        (key) => !['id', 'nodeIds', 'instructions'].includes(key),
      ) ||
      typeof lens.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(lens.id) ||
      !Array.isArray(lens.nodeIds) ||
      !lens.nodeIds.length ||
      lens.nodeIds.some((id) => typeof id !== 'string' || !id) ||
      typeof lens.instructions !== 'string' ||
      !lens.instructions.trim() ||
      lens.instructions.length > 2_000
    ) {
      throw new Error('Review lens registry entry is invalid.');
    }
    return {
      id: lens.id,
      nodeIds: [...new Set(lens.nodeIds as string[])].sort(),
      instructions: lens.instructions.trim(),
    };
  });
  if (new Set(lenses.map((lens) => lens.id)).size !== lenses.length) {
    throw new Error('Review lens registry contains duplicate ids.');
  }
  return lenses;
}

function routingPaths(changes: readonly ReviewPathChange[]): string[] {
  return [
    ...new Set(
      changes.flatMap((change) =>
        [change.oldPath, change.newPath].filter((path): path is string =>
          Boolean(path),
        ),
      ),
    ),
  ].sort();
}

function changesTouchPolicy(changes: readonly ReviewPathChange[]): boolean {
  return changes.some((change) =>
    [change.oldPath, change.newPath].some(
      (path) =>
        path !== undefined &&
        POLICY_INPUTS.includes(path as (typeof POLICY_INPUTS)[number]),
    ),
  );
}

async function revision(root: string, rev: string): Promise<string> {
  const value = (
    await execGit(['-C', root, 'rev-parse', '--verify', `${rev}^{commit}`])
  ).stdout.trim();
  if (!SHA.test(value)) throw new Error('Trusted policy revision is invalid.');
  return value;
}

async function gitShow(
  root: string,
  sha: string,
  path: string,
): Promise<string> {
  return (
    await execGit(['-C', root, 'show', `${sha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
