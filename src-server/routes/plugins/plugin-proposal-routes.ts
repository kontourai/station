/**
 * `/api/plugin-proposals` — agent-authored plugin lifecycle asks (#2323 S5).
 *
 * - `POST /` records a proposal (install a local folder or git URL; update or
 *   remove an installed plugin). It is how station-control's
 *   `propose_plugin_install`, `update_plugin` and `remove_plugin` tools act.
 * - `GET /` lists open proposals; `GET /:id` reads one (the Plugins view
 *   loads it from the attention deep link). Operator-only: proposals are
 *   addressed to the operator, and a non-operator gets 404 (review M6).
 *   Station's own agents and delegated Stations get 404 too, though the
 *   internal caller resolves as the operator (delta review).
 * - `POST /:id/dismiss` closes one without acting. Person-only: an agent that
 *   could dismiss asks would be able to empty the person's inbox.
 *
 * Completion is not a route here. The install, update and remove routes mark
 * a proposal completed themselves, after the change succeeded
 * ({@link recordProposalCompletion}), so "completed" is derived from the
 * change having happened rather than asserted by a client.
 *
 * The author is DERIVED: `principal` and a person's `principalId` from the
 * request's authenticated principal, never the body. The agent and
 * conversation are the tool call's report, honoured only for Station's
 * internal caller class and only as display provenance; `reportedBy` says
 * whether Station's own runtime vouched for them (review M3).
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginLifecycleProposal,
  PluginLifecycleProposalAuthor,
  PluginProposalDigestUnavailableReason,
} from '@kontourai/station-contracts/plugin';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import { observePluginTreeAsync } from '@kontourai/station-shared/plugin-tree-digest';
import { type Context, Hono } from 'hono';
import type { PrincipalRef } from '../../services/identity/principal-resolver.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../services/identity/principal-resolver.js';
import {
  type PluginLifecycleProposalService,
  type PluginProposalCompletion,
  PluginProposalInvalidError,
  PluginProposalLimitError,
  PluginProposalNotFoundError,
  PluginProposalNotOpenError,
  resolvePluginProposalSource,
} from '../../services/plugins/plugin-lifecycle-proposals.js';
import {
  type AttestedProposalSubject,
  verifyProposalSourceContext,
} from '../../services/plugins/plugin-proposal-provenance.js';
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
  isNonPersonCaller,
  personOnly,
} from './plugin-person-approval.js';

interface PluginProposalRouteDeps {
  proposals: PluginLifecycleProposalService;
  pluginsDir: string;
  logger: Pick<Logger, 'warn'>;
  /**
   * The request's own principal, from the same memoized resolver every
   * identity-bearing route reads. REQUIRED: it decides who may read
   * proposals and keys a person's proposals by who they are.
   */
  resolvePrincipal(c: Context): PrincipalRef;
}

type ReportedContext = {
  agentSlug?: string;
  conversationId?: string;
  attestation?: string;
};

type ProposalCreateBody =
  | {
      kind: 'install';
      source: string;
      rationale: string;
      _sourceContext?: ReportedContext;
    }
  | {
      kind: 'update' | 'remove';
      pluginName: string;
      rationale: string;
      _sourceContext?: ReportedContext;
    };

/** The bounds of the proposal-time digest walk (review M4). */
export const PROPOSAL_DIGEST_MAX_ENTRIES = 5000;
const PROPOSAL_DIGEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Counts a folder's entries and file bytes WITHOUT reading file contents or
 * following links, stopping at the first bound crossed. Mirrors the digest's
 * own walk (root `.git` excluded), so a tree inside the bounds is one the
 * digest will read in full. Returns `null` when the tree could not be read.
 */
function withinDigestBounds(root: string): boolean | null {
  let entries = 0;
  let bytes = 0;
  const walk = (dir: string, top: boolean): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (top && entry.name === '.git') continue;
      entries += 1;
      if (entries > PROPOSAL_DIGEST_MAX_ENTRIES) return false;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(path, false)) return false;
      } else if (entry.isFile()) {
        bytes += lstatSync(path).size;
        if (bytes > PROPOSAL_DIGEST_MAX_BYTES) return false;
      }
    }
    return true;
  };
  try {
    return walk(root, true);
  } catch {
    return null;
  }
}

/**
 * The tree digest of a local plugin folder, in the encoding the install
 * preview's `contentDigest` uses (`computePluginTreeDigest`, which is what
 * `derivePluginConsentBasis` runs on the preview's verbatim staging copy).
 * Read in place with the yielding observer, never copied, and only inside
 * the bounds above; otherwise the proposal records why there is no digest.
 * The bounds are checked, then the digest reads the tree: a tree that grows
 * in between is read in full (the bound is a cost guard, not a guarantee).
 */
async function observeLocalDigest(
  path: string,
): Promise<
  | { proposedContentDigest: string }
  | { proposedContentDigestUnavailable: PluginProposalDigestUnavailableReason }
> {
  const bounded = withinDigestBounds(path);
  if (bounded === null)
    return { proposedContentDigestUnavailable: 'unreadable' };
  if (!bounded) return { proposedContentDigestUnavailable: 'too-large' };
  const digest = (await observePluginTreeAsync(path))?.digest;
  return digest
    ? { proposedContentDigest: digest }
    : { proposedContentDigestUnavailable: 'unreadable' };
}

/**
 * The manifest check `POST /api/plugins/validate` makes, with its codes and
 * words, so a proposal reveals nothing about a host path that validate does
 * not already reveal at the same tier (review M4).
 */
function refuseMissingManifest(folder: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(join(folder, 'plugin.json'));
  } catch {
    throw new PluginProposalInvalidError(
      'manifest-missing',
      'Not a valid plugin: plugin.json not found in the folder.',
    );
  }
  if (info.isSymbolicLink()) {
    throw new PluginProposalInvalidError(
      'manifest-not-regular-file',
      'plugin.json is a symlink. Station reads the manifest from the plugin folder itself; replace the link with the file.',
    );
  }
  if (!info.isFile()) {
    throw new PluginProposalInvalidError(
      'manifest-not-regular-file',
      'plugin.json is not a regular file.',
    );
  }
}

function resolveCaller(
  deps: PluginProposalRouteDeps,
  c: Context,
): PrincipalRef | null {
  try {
    return deps.resolvePrincipal(c);
  } catch {
    return null;
  }
}

function isOperator(deps: PluginProposalRouteDeps, c: Context): boolean {
  return resolveCaller(deps, c)?.id === LOCAL_OPERATOR_PRINCIPAL_ID;
}

/**
 * Who may read proposals: the operator, as a person. Station's internal
 * caller also resolves as the operator (home possession), so it is excluded
 * by name: an agent needs only the answer to its own create request, never
 * other conversations' rationales or people's principal ids (#2323 S5 delta
 * review).
 */
function isOperatorPerson(deps: PluginProposalRouteDeps, c: Context): boolean {
  return !isNonPersonCaller(c.req.raw) && isOperator(deps, c);
}

function authorFor(
  deps: PluginProposalRouteDeps,
  c: Context,
  reported: ReportedContext | undefined,
  subject: AttestedProposalSubject,
): PluginLifecycleProposalAuthor {
  if (!isInternalControlCaller(c.req.raw)) {
    const principalId = resolveCaller(deps, c)?.id;
    return { principal: 'person', ...(principalId ? { principalId } : {}) };
  }
  const hasReport = !!(reported?.agentSlug || reported?.conversationId);
  return {
    principal: 'agent',
    ...(reported?.agentSlug ? { agentSlug: reported.agentSlug } : {}),
    ...(reported?.conversationId
      ? { conversationId: reported.conversationId }
      : {}),
    ...(hasReport
      ? {
          reportedBy: verifyProposalSourceContext(reported ?? {}, subject)
            ? ('runtime' as const)
            : ('caller' as const),
        }
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

const NOT_FOUND = {
  success: false,
  code: 'proposal-not-found',
  error: 'Not found',
} as const;

/**
 * The one answer a non-operator gets for an update or remove proposal,
 * whether or not the plugin is installed: proposals are addressed to the
 * operator, and a differing answer would let any paired device probe the
 * installed inventory (review M6).
 */
const UPDATE_REMOVE_OPERATOR_ONLY = {
  success: false,
  code: 'plugin-not-installed',
  error:
    'Only the Station operator or Station’s own agents can propose updating or removing a plugin here. list_plugins shows the installed names.',
} as const;

export function createPluginProposalRoutes(deps: PluginProposalRouteDeps) {
  const app = new Hono();
  const { proposals, pluginsDir } = deps;

  app.get('/', (c) =>
    isOperatorPerson(deps, c)
      ? c.json({ proposals: proposals.listOpen() })
      : c.json(NOT_FOUND, 404),
  );

  app.get('/:id', (c) => {
    const proposal = isOperatorPerson(deps, c)
      ? proposals.get(param(c, 'id'))
      : null;
    if (!proposal) return c.json(NOT_FOUND, 404);
    return c.json({ proposal });
  });

  app.post('/', validate(pluginProposalCreateSchema), async (c) => {
    const body = getBody(c) as ProposalCreateBody;
    // The attestation is bound to what this request asks for, as the body
    // states it (the schema has trimmed both), so it vouches for this
    // proposal and no other (#2323 S5 delta review).
    const author = authorFor(
      deps,
      c,
      body._sourceContext,
      body.kind === 'install'
        ? { kind: 'install', target: body.source }
        : { kind: body.kind, target: body.pluginName },
    );
    try {
      if (body.kind === 'install') {
        const resolved = resolvePluginProposalSource(body.source);
        const input = {
          kind: 'install' as const,
          source: resolved.source,
          rationale: body.rationale,
          author,
        };
        // Dedupe and caps first: a refused or duplicate ask costs no walk.
        const admission = proposals.precheck(input);
        if ('existing' in admission) {
          return c.json({
            success: true,
            deduplicated: true,
            proposal: admission.existing,
          });
        }
        let digest:
          | { proposedContentDigest: string }
          | {
              proposedContentDigestUnavailable: PluginProposalDigestUnavailableReason;
            } = { proposedContentDigestUnavailable: 'remote-source' };
        if (resolved.kind === 'local') {
          refuseMissingManifest(resolved.source);
          digest = await observeLocalDigest(resolved.source);
        }
        const { proposal, deduplicated } = await proposals.propose({
          ...input,
          ...digest,
        });
        return c.json(
          { success: true, deduplicated, proposal },
          deduplicated ? 200 : 201,
        );
      }
      const pluginName = body.pluginName.trim();
      const mayProbeInventory =
        isInternalControlCaller(c.req.raw) || isOperator(deps, c);
      if (!mayProbeInventory) return c.json(UPDATE_REMOVE_OPERATOR_ONLY, 404);
      if (
        !isCanonicalPluginId(pluginName) ||
        !existsInstalled(pluginsDir, pluginName)
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
      if (!isOperator(deps, c)) return c.json(NOT_FOUND, 404);
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

function existsInstalled(pluginsDir: string, pluginName: string): boolean {
  try {
    lstatSync(join(pluginsDir, pluginName));
    return true;
  } catch {
    return false;
  }
}

const PROPOSAL_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The proposal an update or remove request completes (review L3): the JSON
 * body's `proposalId`, as `POST /install` takes it, or the `?proposalId=`
 * query the first version of this slice used. Anything that is not a UUID
 * is ignored, which reports no proposal rather than a wrong one.
 */
export async function readLifecycleProposalId(
  c: Context,
): Promise<string | undefined> {
  const pick = (value: unknown) =>
    typeof value === 'string' && PROPOSAL_ID.test(value) ? value : undefined;
  const fromQuery = pick(c.req.query('proposalId'));
  if (fromQuery) return fromQuery;
  if (!c.req.header('content-type')?.includes('application/json'))
    return undefined;
  try {
    const body = (await c.req.json()) as { proposalId?: unknown } | null;
    return pick(body?.proposalId);
  } catch {
    return undefined;
  }
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
