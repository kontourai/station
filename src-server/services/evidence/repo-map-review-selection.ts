import type { AgentMetadata } from '@kontourai/station-contracts/agent';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type {
  IndependentReviewReceipt,
  IndependentReviewRequest,
} from '@kontourai/station-contracts/review-evidence';
import type { ReviewSelectionResolver } from './review-evidence-module.js';
import {
  ReviewLensRouter,
  type ReviewLensRouting,
} from './review-lens-router.js';

export interface RepoMapReviewSelectionOptions {
  target(
    projectSlug: string,
  ):
    | { projectSlug: string; workspace: string; globalAgentSlugs: string[] }
    | undefined;
  listAgents(): Promise<AgentMetadata[]>;
  supportsReadOnlyReview(provider: ProviderKind): boolean;
  isCodexReviewerAvailable(agent: AgentMetadata): boolean;
  policyRevision?: string;
}

/**
 * Server composition for repo-map selection. It deliberately assigns only
 * existing, distinct Agent identities and refuses before executor invocation
 * if Codex cannot enforce the read-only review capability.
 */
export class RepoMapReviewSelection implements ReviewSelectionResolver {
  readonly #router: ReviewLensRouter;

  constructor(private readonly options: RepoMapReviewSelectionOptions) {
    this.#router = new ReviewLensRouter(options.policyRevision);
  }

  async resolve(
    request: IndependentReviewRequest,
    context: { prior?: IndependentReviewReceipt },
  ) {
    const target = this.options.target(request.target.projectSlug);
    if (!target || target.projectSlug !== request.target.projectSlug)
      return unavailable('Project workspace is unavailable.', ['human-review']);
    if (!this.options.supportsReadOnlyReview('codex')) {
      return unavailable('Codex cannot enforce read-only review access.', [
        'human-review',
      ]);
    }
    let plan: ReviewLensRouting;
    try {
      plan = await this.#router.plan({
        repositoryRoot: target.workspace,
        target: request.target,
      });
    } catch {
      return unavailable('The review range could not be safely classified.', [
        'human-review',
      ]);
    }
    if (plan.kind === 'no-change') {
      return unavailable('The exact review range has no changed paths.', [
        'human-review',
      ]);
    }
    if (plan.kind === 'human-review-required') {
      return unavailable(plan.reason, plan.unavailableLenses);
    }
    const lenses = [...plan.lenses];
    const trustedLenses = new Map(plan.registry.map((lens) => [lens.id, lens]));
    for (const execution of context.prior?.executions ?? []) {
      if (!lenses.some((lens) => lens.id === execution.lens.id)) {
        const trusted = trustedLenses.get(execution.lens.id);
        if (!trusted) {
          return unavailable(
            'A prior review lens is absent from trusted routing policy.',
            ['human-review'],
          );
        }
        lenses.push(trusted);
      }
    }
    lenses.sort((left, right) => left.id.localeCompare(right.id));
    const agents = (await this.options.listAgents())
      .filter(
        (agent) =>
          agent.slug !== request.implementerAgentSlug &&
          (agent.project === target.projectSlug ||
            (agent.project === undefined &&
              target.globalAgentSlugs.includes(String(agent.slug)))) &&
          this.options.isCodexReviewerAvailable(agent),
      )
      .map((agent) => String(agent.slug))
      .sort();
    if (agents.length < lenses.length) {
      return unavailable(
        'Not enough eligible Agents are available for independent repo-map review.',
        lenses.map((lens) => lens.id),
      );
    }
    return {
      kind: 'selected' as const,
      reviewers: lenses.map((lens, index) => ({
        reviewerId: `repo-map:${lens.id}:${index + 1}`,
        executorAgentSlug: agents[index],
        lens: { id: lens.id, instructions: lens.instructions },
      })),
      target: plan.target,
      routing: {
        kind: 'repo-map' as const,
        policyRevision: plan.policy.revision,
        repoMapSha256: plan.policy.repoMapSha256,
        registrySha256: plan.policy.registrySha256,
        routerVersion: 1 as const,
        affectedNodes: plan.affectedNodes,
      },
    };
  }
}

function unavailable(reason: string, unavailableLenses: string[]) {
  return { kind: 'unavailable' as const, reason, unavailableLenses };
}
