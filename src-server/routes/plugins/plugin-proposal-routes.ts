/**
 * `/api/plugin-proposals` — agent-authored plugin lifecycle asks (#2323 S5).
 *
 * - `POST /` records a proposal (install a local folder or git URL; update or
 *   remove an installed plugin). It is how station-control's
 *   `propose_plugin_install`, `update_plugin` and `remove_plugin` tools act.
 * - `GET /` lists open proposals; `GET /:id` reads one (the Plugins view
 *   loads it from the attention deep link).
 * - `POST /:id/dismiss` closes one without acting. Person-only: an agent that
 *   could dismiss asks would be able to empty the person's inbox.
 *
 * Completion is not a route here. The install, update and remove routes mark
 * a proposal completed themselves, after the change succeeded
 * ({@link recordProposalCompletion}), so "completed" is derived from the
 * change having happened rather than asserted by a client.
 *
 * The author is DERIVED: `principal` from the request's authenticated
 * principal, never the body. The agent and conversation are the tool call's
 * report, honoured only for Station's internal caller class and only as
 * display provenance (the same rule `PUT /api/skills/:name` applies to
 * `_sourceContext`).
 */
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginLifecycleProposal,
  PluginLifecycleProposalAuthor,
} from '@kontourai/station-contracts/plugin';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { observePluginTreeAsync } from '@kontourai/station-shared/plugin-tree-digest';
import { Hono } from 'hono';
import {
  type PluginLifecycleProposalService,
  type PluginProposalCompletion,
  PluginProposalInvalidError,
  PluginProposalLimitError,
  PluginProposalNotFoundError,
  PluginProposalNotOpenError,
  resolvePluginProposalSource,
} from '../../services/plugins/plugin-lifecycle-proposals.js';
import type { Logger } from '../../utils/logger.js';
import {
  errorMessage,
  getBody,
  param,
  pluginProposalCreateSchema,
  validate,
} from '../schemas/schemas.js';
import {
  isInternalControlCaller,
  personOnly,
} from './plugin-person-approval.js';

interface PluginProposalRouteDeps {
  proposals: PluginLifecycleProposalService;
  pluginsDir: string;
  logger: Pick<Logger, 'warn'>;
}

type ProposalCreateBody =
  | {
      kind: 'install';
      source: string;
      rationale: string;
      _sourceContext?: { agentSlug?: string; conversationId?: string };
    }
  | {
      kind: 'update' | 'remove';
      pluginName: string;
      rationale: string;
      _sourceContext?: { agentSlug?: string; conversationId?: string };
    };

/**
 * The tree digest of a local plugin folder, in the encoding the install
 * preview's `contentDigest` uses (`computePluginTreeDigest`, which is what
 * `derivePluginConsentBasis` runs on the preview's verbatim staging copy).
 * Read in place with the yielding observer, never copied. `undefined` when
 * the folder cannot be digested; the review then says there is nothing to
 * compare against.
 */
async function observeLocalDigest(path: string): Promise<string | undefined> {
  return (await observePluginTreeAsync(path))?.digest;
}

function authorFor(
  request: Request,
  reported: { agentSlug?: string; conversationId?: string } | undefined,
): PluginLifecycleProposalAuthor {
  if (!isInternalControlCaller(request)) return { principal: 'person' };
  return {
    principal: 'agent',
    ...(reported?.agentSlug ? { agentSlug: reported.agentSlug } : {}),
    ...(reported?.conversationId
      ? { conversationId: reported.conversationId }
      : {}),
  };
}

function refusal(
  error: unknown,
): { status: 400 | 404 | 409 | 429; code: string } | null {
  if (error instanceof PluginProposalLimitError)
    return { status: 429, code: error.code };
  if (error instanceof PluginProposalInvalidError)
    return { status: 400, code: error.code };
  if (error instanceof PluginProposalNotFoundError)
    return { status: 404, code: error.code };
  if (error instanceof PluginProposalNotOpenError)
    return { status: 409, code: error.code };
  return null;
}

export function createPluginProposalRoutes(deps: PluginProposalRouteDeps) {
  const app = new Hono();
  const { proposals, pluginsDir } = deps;

  app.get('/', (c) => c.json({ proposals: proposals.listOpen() }));

  app.get('/:id', (c) => {
    const proposal = proposals.get(param(c, 'id'));
    if (!proposal) {
      return c.json(
        { success: false, code: 'proposal-not-found', error: 'Not found' },
        404,
      );
    }
    return c.json({ proposal });
  });

  app.post('/', validate(pluginProposalCreateSchema), async (c) => {
    const body = getBody(c) as ProposalCreateBody;
    const author = authorFor(c.req.raw, body._sourceContext);
    try {
      if (body.kind === 'install') {
        const resolved = resolvePluginProposalSource(body.source);
        let proposedContentDigest: string | undefined;
        if (resolved.kind === 'local') {
          // A folder that is not a plugin is refused here rather than left
          // for the person to discover on the preview.
          let manifest: ReturnType<typeof lstatSync> | undefined;
          try {
            manifest = lstatSync(join(resolved.source, 'plugin.json'));
          } catch {
            manifest = undefined;
          }
          if (!manifest?.isFile()) {
            throw new PluginProposalInvalidError(
              'manifest-missing',
              'Not a plugin folder: plugin.json is missing or is not a regular file. Check it with validate_plugin first.',
            );
          }
          proposedContentDigest = await observeLocalDigest(resolved.source);
        }
        const { proposal, deduplicated } = await proposals.propose({
          kind: 'install',
          source: resolved.source,
          rationale: body.rationale,
          author,
          ...(proposedContentDigest ? { proposedContentDigest } : {}),
        });
        return c.json(
          { success: true, deduplicated, proposal },
          deduplicated ? 200 : 201,
        );
      }
      const pluginName = body.pluginName.trim();
      if (
        !isCanonicalPluginId(pluginName) ||
        !existsSync(join(pluginsDir, pluginName))
      ) {
        return c.json(
          {
            success: false,
            code: 'plugin-not-installed',
            error: `No installed plugin is named '${pluginName}'. list_plugins shows the installed names.`,
          },
          404,
        );
      }
      const { proposal, deduplicated } = await proposals.propose({
        kind: body.kind,
        pluginName,
        rationale: body.rationale,
        author,
      });
      return c.json(
        { success: true, deduplicated, proposal },
        deduplicated ? 200 : 201,
      );
    } catch (error) {
      const refused = refusal(error);
      if (refused) {
        return c.json(
          { success: false, code: refused.code, error: errorMessage(error) },
          refused.status,
        );
      }
      throw error;
    }
  });

  app.post(
    '/:id/dismiss',
    personOnly('dismiss a plugin proposal'),
    async (c) => {
      try {
        const proposal = await proposals.dismiss(param(c, 'id'));
        return c.json({ success: true, proposal });
      } catch (error) {
        const refused = refusal(error);
        if (refused) {
          return c.json(
            { success: false, code: refused.code, error: errorMessage(error) },
            refused.status,
          );
        }
        throw error;
      }
    },
  );

  return app;
}

/**
 * What the install, update and remove routes add to their response when the
 * request named a proposal. The proposal is closed only when the change
 * `succeeded` and the proposal asked for exactly what was done; a store
 * failure never fails the change it follows, and is reported as
 * `unrecorded` rather than silently as completed.
 */
export async function recordProposalCompletion(
  proposals: PluginLifecycleProposalService | undefined,
  proposalId: string | undefined,
  succeeded: boolean,
  completion: PluginProposalCompletion,
  logger: Pick<Logger, 'warn'>,
): Promise<{
  proposal?: {
    id: string;
    status:
      | PluginLifecycleProposal['status']
      | 'not-found'
      | 'mismatch'
      | 'unrecorded';
  };
}> {
  if (!proposalId) return {};
  if (!proposals || !succeeded) {
    return { proposal: { id: proposalId, status: 'open' } };
  }
  try {
    const outcome = await proposals.complete(proposalId, completion);
    switch (outcome.status) {
      case 'completed':
        return { proposal: { id: proposalId, status: 'completed' } };
      case 'not-open':
        return {
          proposal: { id: proposalId, status: outcome.proposal.status },
        };
      default:
        return { proposal: { id: proposalId, status: outcome.status } };
    }
  } catch (error) {
    logger.warn('Plugin proposal completion was not recorded', {
      proposalId,
      error: errorMessage(error),
    });
    return { proposal: { id: proposalId, status: 'unrecorded' } };
  }
}
