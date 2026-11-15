/**
 * #4830: the REST side of `propose_automation_source`,
 * `propose_automation_rule` and `list_automation_proposals`, and the person's
 * Confirm and Decline. Mounted under `/api/orchestration`, beside the
 * `propose_job` routes it is modeled on (`agent-schedule.ts`).
 *
 * Agent leaves (`/station-control/automation-proposals...`): only Station's
 * own station-control tool code calls them, so a request the runtime boundary
 * did not accept as Station's internal principal gets a 404. The
 * conversation is the VERIFIED caller's own; a body never chooses it. A
 * proposal is refused when the calling Session acts for no one (no recorded
 * owner, as for a Session an automation or another agent started) or when
 * its current work was started by an automation (§5 "Never": an automation
 * run cannot change automations). A proposal records what the agent asked
 * for and creates nothing.
 *
 * Person leaves (`/agent-schedule/:conversationId/automation-proposals/...`):
 * no station-control tool maps them, so the guard refuses an agent's
 * internal token outright, and each refuses a request that may be an agent's
 * besides. Confirm also needs the Station operator, because sources and rules
 * are Station-wide configuration; it creates through the ordinary
 * {@link AutomationStore}, disabled or in `observe` mode unless the person
 * asks for `enable` in the same confirmation.
 */

import {
  AUTOMATION_PROPOSAL_LIMITS,
  type AutomationProposal,
  type AutomationProposalRefusalCode,
} from '@kontourai/station-contracts/automation';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { readBoundedRequestBody } from '../../security/bounded-request-body.js';
import { requestMayBeAnAgent } from '../../security/coding-authority.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { automationConfigurationFingerprint } from '../../services/automation/automation-intent.js';
import {
  type AutomationProposalPlan,
  type AutomationProposalPlanContext,
  type AutomationProposalStore,
  type AutomationTargetBinding,
  automationIdForProposal,
  planRuleProposal,
  planSourceProposal,
  sameAutomationTargetBinding,
} from '../../services/automation/automation-proposals.js';
import {
  type AutomationStore,
  AutomationValidationError,
} from '../../services/automation/automation-store.js';
import {
  type StationControlPolicyCaller,
  stationControlRefusal,
  stationControlRefusalBody,
} from '../../tools/station-control-policy.js';
import { errorMessage } from '../../utils/error-message.js';
import type { AgentSchedulePerson } from './agent-schedule.js';

const MAX_BODY_BYTES = 32 * 1024;
const NO_STORE = { 'Cache-Control': 'no-store' };
const AGENT_LIST_LIMIT = 20;

/** Fixed copy an agent relays; each says what to do instead. */
export const AUTOMATION_PROPOSAL_COPY = {
  unattendedNoOwner:
    'This session acts for no one, so it cannot propose automations. Ask the person in their own chat.',
  startedByAutomation:
    'Only a turn a person sent in their own chat can propose automations. Work an automation, a delegation or a check-back started cannot create, change or remove automations. Tell the person what you would propose instead.',
  limitReached: `This chat already has ${AUTOMATION_PROPOSAL_LIMITS.maxOpenPerConversation} automation proposals waiting. Wait for the person to answer one.`,
  rateLimited:
    'This chat proposed too many automations in the last hour. Try again later.',
  unavailable: "Automation proposals aren't available on this Station.",
  waiting:
    'Waiting for the person to confirm it in this chat. Nothing is created until they do.',
} as const;

const STATUS: Record<AutomationProposalRefusalCode, 400 | 403 | 409 | 503> = {
  automation_proposal_invalid: 400,
  automation_proposal_exceeds_authority: 403,
  automation_proposal_unattended: 403,
  automation_proposal_limit_reached: 409,
  automation_proposal_rate_limited: 409,
  automation_proposal_unavailable: 503,
};

const confirmationSchema = z
  .object({ enable: z.boolean().optional() })
  .strict();

/** The person who may create Station-wide automations: the operator in person. */
export interface AutomationProposalOperator {
  readonly id: string;
  /** Re-checked inside the configuration lock; throws when no longer current. */
  assertCurrent(): Promise<void>;
}

export interface AutomationProposalRoutesDeps {
  /** True only for Station's own internal principal. */
  isInternalRequest(request: Request): boolean;
  /** Absent: proposals are unavailable on this Station. */
  store: AutomationProposalStore | undefined;
  automations:
    | Pick<
        AutomationStore,
        'read' | 'createSource' | 'createRule' | 'setEnabled'
      >
    | undefined;
  /** Hosted Stations have no Automation surface. */
  hosted?: boolean;
  /**
   * The pair resolved (Project, Agent and the Agent's definition digest)
   * when this caller could dispatch work to `agentId` in `projectId` itself,
   * by the one dispatch scope rule; `undefined` when it could not or Station
   * cannot read it. Asked at proposal time and again at Confirm.
   */
  bind(
    caller: StationControlPolicyCaller,
    projectId: string,
    agentId: string,
  ): Promise<AutomationTargetBinding | undefined>;
  /**
   * `proposingTurnId` over the Session's inferred calling turn (#4882 will
   * make it known): its id when that turn may propose, else `undefined`.
   * Asked before validation and again inside the transaction that stores
   * the proposal.
   */
  proposingTurn(sessionId: string): string | undefined;
  /** The conversation (or a child it delegated to) read untrusted content. */
  untrustedContent(conversationId: string): Promise<boolean>;
  projectName?(projectId: string): string | undefined;
  /** The person making a UI request, or undefined when it is not current. */
  person(c: Context): AgentSchedulePerson | undefined;
  /** The operator in person, or undefined. */
  operator(request: Request): Promise<AutomationProposalOperator | undefined>;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  now?: () => number;
}

async function readJson(request: Request): Promise<unknown> {
  const read = await readBoundedRequestBody(request, MAX_BODY_BYTES);
  if (read.status !== 'ok') return undefined;
  try {
    return JSON.parse(read.body);
  } catch {
    return undefined;
  }
}

/** A recorded binding no longer holds; nothing is created or enabled. */
class BindingChangedError extends Error {
  constructor(binding: AutomationTargetBinding) {
    super(
      `This chat can no longer start work for ${binding.agentId} in ${binding.projectId} as it could when it proposed this, or that Agent has changed. Nothing was created or enabled. Decline it and ask the agent again.`,
    );
    this.name = 'BindingChangedError';
  }
}

const bindingChanged = (c: Context, error: string) =>
  c.json(
    { success: false, code: 'automation_proposal_binding_changed', error },
    409,
    NO_STORE,
  );

export function createAutomationProposalRoutes(
  deps: AutomationProposalRoutesDeps,
) {
  const app = new Hono();
  const now = () => deps.now?.() ?? Date.now();

  const refusal = (
    c: Context,
    code: AutomationProposalRefusalCode,
    error: string,
    problems?: readonly string[],
  ) =>
    c.json(
      {
        success: false,
        code,
        error,
        ...(problems && problems.length > 0 ? { problems } : {}),
      },
      STATUS[code],
      NO_STORE,
    );

  /** The verified caller's own conversation, or the response refusing it. */
  const callerOf = (
    c: Context,
  ):
    | {
        conversationId: string;
        sessionId: string;
        policy: StationControlPolicyCaller;
      }
    | { refused: Response } => {
    if (!deps.isInternalRequest(c.req.raw))
      return {
        refused: c.json({ error: { code: 'not_found' } }, 404, NO_STORE),
      };
    const authority = stationControlRequestAuthority(c.req.raw);
    if (authority?.kind !== 'caller')
      return {
        refused: c.json(
          stationControlRefusalBody(
            stationControlRefusal('station_control_caller_required'),
          ),
          403,
          NO_STORE,
        ),
      };
    const { caller } = authority;
    return {
      conversationId: caller.conversationId ?? caller.sessionId,
      sessionId: caller.sessionId,
      policy: caller,
    };
  };

  const propose =
    (
      plan: (
        body: unknown,
        context: AutomationProposalPlanContext,
      ) => Promise<AutomationProposalPlan>,
    ) =>
    async (c: Context) => {
      const caller = callerOf(c);
      if ('refused' in caller) return caller.refused;
      const { store, automations } = deps;
      if (!store || !automations || deps.hosted)
        return refusal(
          c,
          'automation_proposal_unavailable',
          AUTOMATION_PROPOSAL_COPY.unavailable,
        );
      // A proposal carries the authority of the person the chat acts for. A
      // Session with no recorded owner (one an automation, a webhook or
      // another agent started) acts for no one, so it has none to offer.
      if (!caller.policy.principal)
        return refusal(
          c,
          'automation_proposal_unattended',
          AUTOMATION_PROPOSAL_COPY.unattendedNoOwner,
        );
      const turnId = deps.proposingTurn(caller.sessionId);
      if (turnId === undefined)
        return refusal(
          c,
          'automation_proposal_unattended',
          AUTOMATION_PROPOSAL_COPY.startedByAutomation,
        );
      let untrusted: boolean;
      try {
        untrusted = await deps.untrustedContent(caller.conversationId);
      } catch {
        // Unknown is labelled: the person sees the warning rather than not.
        untrusted = true;
      }
      const result = await plan(await readJson(c.req.raw), {
        conversationId: caller.conversationId,
        authority: {
          bind: (projectId, agentId) =>
            deps.bind(caller.policy, projectId, agentId),
        },
        configuration: () => automations.read(),
        proposal: (id) => store.proposal(id),
        ...(deps.projectName ? { projectName: deps.projectName } : {}),
        untrusted,
      });
      if (!result.ok)
        return refusal(c, result.code, result.error, result.problems);
      const inserted = store.insert({
        conversationId: caller.conversationId,
        sessionId: caller.sessionId,
        plan: result,
        proposer: {
          ...caller.policy,
          sessionId: caller.sessionId,
          conversationId: caller.conversationId,
        },
        untrusted,
        now: now(),
        // The same turn, still allowed, as the proposal is written.
        admit: () => deps.proposingTurn(caller.sessionId) === turnId,
      });
      if (inserted.outcome === 'not-admitted')
        return refusal(
          c,
          'automation_proposal_unattended',
          AUTOMATION_PROPOSAL_COPY.startedByAutomation,
        );
      if (inserted.outcome === 'limit-reached')
        return refusal(
          c,
          'automation_proposal_limit_reached',
          AUTOMATION_PROPOSAL_COPY.limitReached,
        );
      if (inserted.outcome === 'rate-limited')
        return refusal(
          c,
          'automation_proposal_rate_limited',
          AUTOMATION_PROPOSAL_COPY.rateLimited,
        );
      return c.json(
        {
          success: true,
          data: {
            id: inserted.proposal.id,
            state: inserted.proposal.state,
            description: inserted.proposal.description,
          },
          message: AUTOMATION_PROPOSAL_COPY.waiting,
        },
        200,
        NO_STORE,
      );
    };

  app.post(
    '/station-control/automation-proposals/sources',
    propose(planSourceProposal),
  );
  app.post(
    '/station-control/automation-proposals/rules',
    propose(planRuleProposal),
  );

  app.get('/station-control/automation-proposals', (c) => {
    const caller = callerOf(c);
    if ('refused' in caller) return caller.refused;
    if (!deps.store || deps.hosted)
      return refusal(
        c,
        'automation_proposal_unavailable',
        AUTOMATION_PROPOSAL_COPY.unavailable,
      );
    return c.json(
      {
        success: true,
        data: deps.store.recentProposals(
          caller.conversationId,
          AGENT_LIST_LIMIT,
        ),
      },
      200,
      NO_STORE,
    );
  });

  // ── the person's Confirm and Decline ────────────────────────────────────

  /** The person and the conversation's proposal a request names, or a refusal. */
  const personProposal = (
    c: Context,
  ):
    | { person: AgentSchedulePerson; proposal: AutomationProposal }
    | Response => {
    if (requestMayBeAnAgent(c.req.raw))
      return c.json(
        {
          success: false,
          code: 'person-approval-required',
          error: 'Only a person can answer an automation proposal.',
        },
        403,
        NO_STORE,
      );
    const conversationId = c.req.param('conversationId') ?? '';
    const person = deps.person(c);
    const proposal = deps.store?.proposal(c.req.param('proposalId') ?? '');
    if (
      !person?.mayMutate(conversationId) ||
      !proposal ||
      proposal.conversationId !== conversationId ||
      deps.hosted
    )
      return c.json({ success: false, error: 'Not found' }, 404, NO_STORE);
    return { person, proposal };
  };

  const settled = (c: Context, state: string | undefined) =>
    c.json(
      {
        success: false,
        code: 'automation_proposal_settled',
        error:
          state === 'confirming'
            ? 'This proposal is already being confirmed.'
            : `This proposal was already ${state ?? 'removed'}.`,
      },
      409,
      NO_STORE,
    );

  app.post(
    '/agent-schedule/:conversationId/automation-proposals/:proposalId/decline',
    (c) => {
      const found = personProposal(c);
      if (found instanceof Response) return found;
      // Only from `open`: a Confirm that already claimed it wins.
      const declined = deps.store!.transition(
        found.proposal.id,
        'open',
        'declined',
        found.person.userId,
        now(),
      );
      return c.json({ success: true, data: { declined } }, 200, NO_STORE);
    },
  );

  app.post(
    '/agent-schedule/:conversationId/automation-proposals/:proposalId/confirm',
    async (c) => {
      const found = personProposal(c);
      if (found instanceof Response) return found;
      const { proposal, person } = found;
      const store = deps.store!;
      const automations = deps.automations;
      if (!automations)
        return refusal(
          c,
          'automation_proposal_unavailable',
          AUTOMATION_PROPOSAL_COPY.unavailable,
        );
      const operator = await deps.operator(c.req.raw).catch(() => undefined);
      if (!operator)
        return c.json(
          {
            success: false,
            code: 'automation_proposal_operator_required',
            error:
              'Only the Station operator, in person, can create automations.',
          },
          403,
          NO_STORE,
        );
      const parsed = confirmationSchema.safeParse(
        (await readJson(c.req.raw)) ?? {},
      );
      if (!parsed.success)
        return c.json(
          {
            success: false,
            code: 'automation_proposal_invalid',
            error: 'A confirmation carries only `enable` (true or false).',
          },
          400,
          NO_STORE,
        );
      const enable = parsed.data.enable === true;
      if (proposal.state !== 'open')
        return settled(c, store.storedState(proposal.id));
      // A rule on a proposed source attaches to the source that source's
      // confirmation created; until then there is nothing to attach to.
      let sourceId: string | undefined;
      if (proposal.kind === 'rule') {
        sourceId = proposal.rule.sourceId;
        if (proposal.rule.sourceProposalId !== undefined) {
          const source = store.proposal(proposal.rule.sourceProposalId);
          if (source?.state !== 'confirmed' || !source.createdId)
            return c.json(
              {
                success: false,
                code: 'automation_proposal_source_pending',
                error:
                  source?.state === 'declined'
                    ? 'The source this rule needs was declined.'
                    : 'Confirm the source this rule needs first.',
              },
              409,
              NO_STORE,
            );
          sourceId = source.createdId;
        }
      }
      const recorded = store.authority(proposal.id);
      if (!recorded)
        return bindingChanged(
          c,
          'Station cannot read who proposed this. Decline it and ask the agent again.',
        );
      /**
       * What the proposing chat may do NOW, for what it named THEN (#4830
       * review): the scope rule decided again for the recorded caller, and
       * each Agent still the one it named (same slug, Project and
       * definition). Run before the claim, then again inside the store's
       * lock for creation and for enabling, with the operator's own check.
       */
      const recheck = async () => {
        await operator.assertCurrent();
        for (const binding of recorded.bindings) {
          let current: AutomationTargetBinding | undefined;
          try {
            current = await deps.bind(
              recorded.proposer,
              binding.projectId,
              binding.agentId,
            );
          } catch {
            current = undefined;
          }
          if (!sameAutomationTargetBinding(binding, current))
            throw new BindingChangedError(binding);
        }
      };
      try {
        await recheck();
      } catch (error) {
        if (error instanceof BindingChangedError)
          return bindingChanged(c, error.message);
        throw error;
      }
      let untrustedAtConfirm: boolean;
      try {
        untrustedAtConfirm = await deps.untrustedContent(
          proposal.conversationId,
        );
      } catch {
        untrustedAtConfirm = true;
      }
      if (
        !store.transition(
          proposal.id,
          'open',
          'confirming',
          person.userId,
          now(),
        )
      )
        return settled(c, store.storedState(proposal.id));
      // One proposal names one object, created under an id derived from the
      // proposal: a Confirm retried after an interrupted one finds what that
      // created and adopts it rather than creating a second (#4830 review).
      const createdId = automationIdForProposal(proposal.id);
      const kind = proposal.kind;
      try {
        const current = automations.read();
        const exists =
          kind === 'source'
            ? current.sources.some(({ id }) => id === createdId)
            : current.rules.some(({ id }) => id === createdId);
        if (!exists) {
          if (proposal.kind === 'source')
            await automations.createSource({ ...proposal.source }, recheck, {
              id: createdId,
            });
          else {
            const { sourceProposalId: _pending, ...rule } = proposal.rule;
            await automations.createRule(
              { ...rule, sourceId: sourceId! },
              recheck,
              {
                id: createdId,
              },
            );
          }
        }
      } catch (error) {
        store.transition(proposal.id, 'confirming', 'open', null, now());
        if (error instanceof BindingChangedError)
          return bindingChanged(c, error.message);
        if (error instanceof AutomationValidationError)
          return c.json(
            {
              success: false,
              code: 'automation_proposal_invalid',
              error:
                'Station would not create this as proposed any more. Decline it and ask the agent again.',
              problems: error.problems,
            },
            409,
            NO_STORE,
          );
        deps.logger.warn('automation proposal could not be created', {
          proposalId: proposal.id,
          error: errorMessage(error),
        });
        return refusal(
          c,
          'automation_proposal_unavailable',
          'Station could not create it. Nothing was created; try again.',
        );
      }
      // Default deny unless the person asked otherwise in this confirmation:
      // the store always creates a disabled source and an `observe` rule.
      let enabled = false;
      let enableRefusal: string | undefined;
      if (enable) {
        try {
          await automations.setEnabled(
            kind === 'source'
              ? {
                  kind: 'source',
                  id: createdId,
                  expectedFingerprint: automationConfigurationFingerprint(
                    automations.read(),
                  ),
                  enabled: true,
                }
              : {
                  kind: 'rule',
                  id: createdId,
                  expectedFingerprint: automationConfigurationFingerprint(
                    automations.read(),
                  ),
                  mode: 'live',
                },
            recheck,
          );
          enabled = true;
        } catch (error) {
          if (error instanceof BindingChangedError)
            enableRefusal = error.message;
          deps.logger.warn('confirmed automation was created but not enabled', {
            proposalId: proposal.id,
            error: errorMessage(error),
          });
        }
      }
      if (
        !store.transition(
          proposal.id,
          'confirming',
          'confirmed',
          person.userId,
          now(),
          { createdId, untrustedAtConfirm },
        )
      )
        deps.logger.warn(
          'confirmed automation proposal could not be recorded',
          {
            proposalId: proposal.id,
            state: store.storedState(proposal.id) ?? 'removed',
          },
        );
      return c.json(
        {
          success: true,
          data: {
            proposal: store.proposal(proposal.id),
            createdId,
            enabled,
            untrustedContentAtConfirm: untrustedAtConfirm,
            ...(enable && !enabled
              ? {
                  message:
                    enableRefusal ??
                    'Created, but it could not be enabled, so it starts disabled (a source) or observing (a rule).',
                }
              : {}),
          },
        },
        200,
        NO_STORE,
      );
    },
  );

  return app;
}
