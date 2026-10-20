/**
 * #3276: the Agent audience gate — the Agent catalog, Agent-addressed and
 * Agent-targeted turn routes, answered in one place for a Project member's
 * request. Paths it does not decide yet are listed in
 * docs/design/project-membership.md ("Not yet covered by the gate").
 *
 * A member caller is a request acting for a deployment account: one that
 * carries a current account session (on a credential that is not
 * account-bound — account-bound Devices never reach these paths, see
 * `account-bound-device-gate.ts`), or a station-control tool call whose
 * session is owned by an account (#2377 slice B). The runtime composition
 * decides that (`caller`) from the resolved `PrincipalRef.id` and that
 * principal's current Project membership; this gate only applies it. A
 * request that resolves to no principal (a caller-less station-control call)
 * is `none` and admitted to no Agent. The operator's own requests, and
 * personal-device and peer requests that keep the operator's rules today,
 * pass through untouched.
 *
 * For a member caller the gate answers these surfaces itself and never hands
 * the request to their handlers:
 *
 * - `GET /agents`, `GET /api/agents`: only Agents whose audience admits the
 *   caller, each as a `MemberAgentView` (no prompt, tools or engine
 *   configuration).
 * - `GET /agents/:slug`, `GET /api/agents/:slug`: that view, or the uniform
 *   not-found.
 * - Any other `/agents/:slug/...` or `/api/agents/:slug/...` leaf (running
 *   an MCP prompt, `POST .../mcp-prompts/run`, counts as a turn), and the
 *   orchestration routes that start a turn on a named Agent: the uniform
 *   not-found when the audience does not admit the caller. An Agent it does
 *   admit is still refused with `member_agent_turns_unavailable`: a member's
 *   turn must run with the intersection of the Agent's scope and the
 *   member's access (R2), and that turn path lands with #3277. Until then no
 *   member turn runs with the operator's authority.
 * - Every Agent catalog mutation — create (`POST /agents`), engine
 *   materialization (`POST /agents/materialize-engine`), and any non-read
 *   `/agents/:slug` leaf that is not a turn (update, delete, tools and
 *   workflows edits): `member_agent_catalog_read_only` (403). An addressed
 *   Agent the audience does not admit is still the uniform not-found, so a
 *   mutation never reveals whether a hidden slug exists. The collection
 *   operations address no Agent and are answered before the body is read:
 *   the member can already list the collection, so a 404 would misstate it
 *   and a 403 reveals nothing.
 * - Continuing an existing orchestration conversation or task: refused with
 *   the same code, because it is also a new member turn.
 * - Answering a pending approval, which steers the turn that asked:
 *   `POST /tool-approval/:id` and a `respondToRequest` sent to
 *   `POST /api/orchestration/commands` are refused with the same code for a
 *   `member` caller. Outside hosted mode the approval registry lets any
 *   caller settle an entry, so without this a member could approve or deny
 *   the operator's pending tool call. The approval inbox's notification
 *   action and dismissals are decided per row where the notification route
 *   loads it ({@link memberApprovalGuard}), so a member keeps acting on and
 *   dismissing ordinary notifications. A caller-less (`none`) request keeps
 *   those routes' own rules: they name no Agent, and internal callers may
 *   use them. Not decided here:
 *   `POST /api/orchestration/delegations/:id/respond`, which already admits
 *   only the task's owner holding the Project's `approve` action (#2377).
 *
 * Not decided here: `/agents/:slug/conversations/...`, the caller's own
 * conversation history, which those routes already scope to its owner.
 *
 * The not-found answer is byte-identical for an unknown slug and a slug the
 * audience does not admit, as the shared-Task routes answer.
 */
import {
  type AgentAudience,
  MEMBER_AGENT_VIEW_VERSION,
  type MemberAgentView,
} from '@kontourai/station-contracts/agent';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import {
  type AgentAudienceCaller,
  agentAudienceAdmits,
} from '../../services/agents/agent-audience.js';

/** Structural Hono context — the gate reads and answers, never dispatches. */
export interface AgentAudienceGateContext {
  env: unknown;
  req: {
    raw: Request;
    path: string;
    method: string;
    header(name: string): string | undefined;
  };
}
type GateContext = AgentAudienceGateContext;

/** The authoritative per-Agent facts the decision reads. */
export interface AgentAudienceRecord {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly project?: string;
  readonly audience?: AgentAudience;
}

export interface AgentAudienceGateDeps {
  /** Who the request acts for. Never throws: an undecidable caller is `none`. */
  caller(c: GateContext): Promise<AgentAudienceCaller>;
  /** The persisted Agent set, read for each decision. */
  listAgents(): Promise<readonly AgentAudienceRecord[]>;
}

const MEMBER_AGENT_TURNS_UNAVAILABLE =
  'member_agent_turns_unavailable' as const;
const MEMBER_AGENT_CATALOG_READ_ONLY =
  'member_agent_catalog_read_only' as const;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const notFound = () =>
  Response.json(
    { success: false, error: 'Agent not found' },
    { status: 404, headers: NO_STORE },
  );

const turnsUnavailable = () =>
  Response.json(
    {
      success: false,
      code: MEMBER_AGENT_TURNS_UNAVAILABLE,
      error:
        'A Project member cannot start a turn with this Agent yet; member conversations are not available on this Station.',
    },
    { status: 403, headers: NO_STORE },
  );

const catalogReadOnly = () =>
  Response.json(
    {
      success: false,
      code: MEMBER_AGENT_CATALOG_READ_ONLY,
      error:
        'A Project member cannot change Agent definitions on this Station.',
    },
    { status: 403, headers: NO_STORE },
  );

const unavailable = () =>
  Response.json(
    { success: false, error: 'Agent catalog unavailable' },
    { status: 503, headers: NO_STORE },
  );

const LIST_PATHS = new Set(['/agents', '/api/agents']);
/** Collection operations that write the catalog without addressing an Agent. */
const COLLECTION_MUTATIONS = new Set(['/agents/materialize-engine']);
/** Agent-addressed leaves that start a turn, not edit the Agent. */
const ADDRESSED_TURN = /^\/(?:invoke|invoke\/stream|chat)$/;
/** `POST /agents/:slug/tools/:toolName` runs a tool; other `/tools` writes edit. */
const ADDRESSED_TOOL_RUN = /^\/tools\/(?!allowed$)[^/]+$/;
/**
 * #3284: `POST /agents/:slug/mcp-prompts/run` reads a prompt through the
 * Agent's MCP connection to become a turn's input: a turn, not an edit.
 */
const ADDRESSED_PROMPT_RUN = '/mcp-prompts/run';

function addressedTurn(method: string, leaf: string): boolean {
  return (
    ADDRESSED_TURN.test(leaf) ||
    (method === 'POST' &&
      (ADDRESSED_TOOL_RUN.test(leaf) || leaf === ADDRESSED_PROMPT_RUN))
  );
}
const ADDRESSED = /^\/(?:api\/)?agents\/([^/]+)(\/.*)?$/;
/** Orchestration routes whose body names the Agent a new turn runs on. */
const TURN_WITH_TARGET = new Set([
  '/api/orchestration/chat',
  '/api/orchestration/chat/delegated',
  '/api/orchestration/chat/background',
  '/api/orchestration/delegations',
]);
/** Orchestration routes that start a further turn on an existing session. */
const TURN_CONTINUE = [
  /^\/api\/orchestration\/chat\/[^/]+\/continue$/,
  /^\/api\/orchestration\/delegations\/[^/]+\/continue$/,
];

/** Routes that answer a pending approval whatever their body says. */
const APPROVAL_ANSWERS: readonly [string, RegExp][] = [
  ['POST', /^\/tool-approval\/[^/]+$/],
];
/** The command route answers an approval only for this command type. */
const COMMANDS_PATH = '/api/orchestration/commands';

type Surface =
  | { kind: 'list' }
  | { kind: 'approval-answer'; command: boolean }
  | { kind: 'catalog-mutation' }
  | { kind: 'detail'; slug: string }
  | { kind: 'addressed'; slug: string; mutation: boolean }
  | { kind: 'turn-with-target' }
  | { kind: 'turn-continue' };

function decodeSlug(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

function classify(method: string, rawPath: string): Surface | undefined {
  const path = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
  const read = method === 'GET' || method === 'HEAD';
  if (
    APPROVAL_ANSWERS.some(([m, pattern]) => m === method && pattern.test(path))
  )
    return { kind: 'approval-answer', command: false };
  if (method === 'POST' && path === COMMANDS_PATH)
    return { kind: 'approval-answer', command: true };
  if (LIST_PATHS.has(path))
    return read ? { kind: 'list' } : { kind: 'catalog-mutation' };
  if (!read && COLLECTION_MUTATIONS.has(path))
    return { kind: 'catalog-mutation' };
  const addressed = ADDRESSED.exec(path);
  if (addressed) {
    // A caller's own conversation history lives under the Agent's path but
    // is the caller's record, authorized per conversation owner by those
    // routes (#2377 slice B). Member callers keep reading their own history
    // there whatever the Agent's audience.
    if (
      addressed[1] !== undefined &&
      /^\/conversations(?:\/|$)/.test(addressed[2] ?? '')
    )
      return undefined;
    // An undecodable slug names no Agent: still an Agent surface, so it
    // gets the same not-found as any other slug.
    const slug = decodeSlug(addressed[1]!) ?? '';
    if (read && addressed[2] === undefined) return { kind: 'detail', slug };
    return {
      kind: 'addressed',
      slug,
      mutation: !read && !addressedTurn(method, addressed[2] ?? ''),
    };
  }
  if (method !== 'POST') return undefined;
  if (TURN_WITH_TARGET.has(path)) return { kind: 'turn-with-target' };
  if (TURN_CONTINUE.some((pattern) => pattern.test(path)))
    return { kind: 'turn-continue' };
  return undefined;
}

function memberView(
  record: AgentAudienceRecord & { project: string },
): MemberAgentView {
  return {
    version: MEMBER_AGENT_VIEW_VERSION,
    kind: 'member-agent',
    slug: agentId(record.slug),
    name: record.name,
    ...(record.description ? { description: record.description } : {}),
    project: record.project,
  };
}

/**
 * The Agent catalog a request may receive, decided once for every surface
 * that returns one (the Agent lists here and `/api/boot`'s `agents` section):
 * `operator` keeps the caller's own full catalog; anyone else gets only the
 * admitted Agents as member views (none for a caller that acts for nobody).
 */
export async function agentCatalogForCaller(
  deps: AgentAudienceGateDeps,
  c: GateContext,
): Promise<
  | { readonly kind: 'operator' }
  | { readonly kind: 'member'; readonly data: MemberAgentView[] }
> {
  const caller = await deps.caller(c);
  if (caller.kind === 'operator') return { kind: 'operator' };
  // An empty catalog would read as "no Agents for you"; an undecided caller
  // is an error. The gate's own list keeps answering it with an empty list.
  if (caller.kind === 'none' && caller.unresolved)
    throw new Error('Agent catalog caller could not be resolved');
  return {
    kind: 'member',
    data: memberCatalog(await deps.listAgents(), caller),
  };
}

function memberCatalog(
  agents: readonly AgentAudienceRecord[],
  caller: AgentAudienceCaller,
): MemberAgentView[] {
  return agents.flatMap((record) =>
    agentAudienceAdmits(record, caller)
      ? [memberView(record as AgentAudienceRecord & { project: string })]
      : [],
  );
}

/**
 * For the notification routes: when the request acts for a Project member,
 * which loaded rows it may not action or dismiss (`isLiveApproval`, the
 * approval inbox's one predicate) and the refusal it gets. `undefined` for
 * every other caller, whose rows keep the route's own read rule.
 */
export async function memberApprovalGuard<Row>(
  deps: Pick<AgentAudienceGateDeps, 'caller'>,
  c: GateContext,
  isLiveApproval: (row: Row) => boolean,
): Promise<{ withholds(row: Row): boolean; refusal(): Response } | undefined> {
  const caller = await deps.caller(c);
  if (caller.kind !== 'member') return undefined;
  return { withholds: isLiveApproval, refusal: turnsUnavailable };
}

/** Whether a command body is an approval answer, read from a copy. */
async function isRespondCommand(request: Request): Promise<boolean> {
  try {
    const body = (await request.clone().json()) as unknown;
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { type?: unknown }).type === 'respondToRequest'
    );
  } catch {
    return false;
  }
}

/** The Agent a turn-starting body names, read from a copy of the request. */
async function targetAgent(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.clone().json()) as unknown;
    const target =
      typeof body === 'object' && body !== null
        ? (body as { target?: unknown }).target
        : undefined;
    const agent =
      typeof target === 'object' && target !== null
        ? (target as { agent?: unknown }).agent
        : undefined;
    return typeof agent === 'string' ? agent : undefined;
  } catch {
    return undefined;
  }
}

export function installAgentAudienceGate(
  app: {
    use(
      path: '*',
      handler: (
        c: GateContext,
        next: () => Promise<void>,
      ) => Promise<Response | undefined>,
    ): unknown;
  },
  deps: AgentAudienceGateDeps,
): void {
  app.use('*', async (c, next) => {
    const surface = classify(c.req.method, c.req.path);
    if (
      !surface ||
      // Only an approval answer is decided on the command route; read the
      // body before resolving the caller, so other commands pay nothing.
      (surface.kind === 'approval-answer' &&
        surface.command &&
        !(await isRespondCommand(c.req.raw)))
    ) {
      await next();
      return undefined;
    }
    const caller = await deps.caller(c);
    if (
      caller.kind === 'operator' ||
      (surface.kind === 'approval-answer' && caller.kind !== 'member')
    ) {
      await next();
      return undefined;
    }
    if (surface.kind === 'approval-answer') return turnsUnavailable();
    if (surface.kind === 'turn-continue') return turnsUnavailable();
    if (surface.kind === 'catalog-mutation') return catalogReadOnly();
    let agents: readonly AgentAudienceRecord[];
    try {
      agents = await deps.listAgents();
    } catch {
      return unavailable();
    }
    const admitted = (record: AgentAudienceRecord | undefined) =>
      record !== undefined && agentAudienceAdmits(record, caller)
        ? (record as AgentAudienceRecord & { project: string })
        : undefined;
    if (surface.kind === 'list')
      return Response.json(
        { success: true, data: memberCatalog(agents, caller) },
        { headers: NO_STORE },
      );
    const slug =
      surface.kind === 'turn-with-target'
        ? await targetAgent(c.req.raw)
        : surface.slug;
    if (surface.kind === 'turn-with-target' && slug === undefined)
      // A body naming no Agent starts no Agent turn the gate can admit.
      return turnsUnavailable();
    const visible = admitted(agents.find((record) => record.slug === slug));
    if (!visible) return notFound();
    if (surface.kind === 'detail')
      return Response.json(
        { success: true, data: memberView(visible) },
        { headers: NO_STORE },
      );
    if (surface.kind === 'addressed' && surface.mutation)
      return catalogReadOnly();
    return turnsUnavailable();
  });
}
