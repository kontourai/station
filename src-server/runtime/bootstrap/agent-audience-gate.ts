/**
 * #3276: the Agent audience gate — every Agent surface a Project member's
 * request can reach, answered in one place.
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
 * For a member caller the gate answers every Agent surface itself and never
 * hands the request to an Agent handler:
 *
 * - `GET /agents`, `GET /api/agents`: only Agents whose audience admits the
 *   caller, each as a `MemberAgentView` (no prompt, tools or engine
 *   configuration).
 * - `GET /agents/:slug`, `GET /api/agents/:slug`: that view, or the uniform
 *   not-found.
 * - Any other `/agents/:slug/...` or `/api/agents/:slug/...` leaf, and the
 *   orchestration routes that start a turn on a named Agent: the uniform
 *   not-found when the audience does not admit the caller. An Agent it does
 *   admit is still refused with `member_agent_turns_unavailable`: a member's
 *   turn must run with the intersection of the Agent's scope and the
 *   member's access (R2), and that turn path lands with #3277. Until then no
 *   member turn runs with the operator's authority.
 * - Continuing an existing orchestration conversation or task: refused with
 *   the same code, because it is also a new member turn.
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

export const MEMBER_AGENT_TURNS_UNAVAILABLE =
  'member_agent_turns_unavailable' as const;

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

const unavailable = () =>
  Response.json(
    { success: false, error: 'Agent catalog unavailable' },
    { status: 503, headers: NO_STORE },
  );

const LIST_PATHS = new Set(['/agents', '/api/agents']);
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

type Surface =
  | { kind: 'list' }
  | { kind: 'detail'; slug: string }
  | { kind: 'addressed'; slug: string }
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
  if (LIST_PATHS.has(path)) return read ? { kind: 'list' } : undefined;
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
    return read && addressed[2] === undefined
      ? { kind: 'detail', slug }
      : { kind: 'addressed', slug };
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
    if (!surface) {
      await next();
      return undefined;
    }
    const caller = await deps.caller(c);
    if (caller.kind === 'operator') {
      await next();
      return undefined;
    }
    if (surface.kind === 'turn-continue') return turnsUnavailable();
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
    if (surface.kind === 'list') {
      const data = agents.flatMap((record) => {
        const visible = admitted(record);
        return visible ? [memberView(visible)] : [];
      });
      return Response.json({ success: true, data }, { headers: NO_STORE });
    }
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
    return turnsUnavailable();
  });
}
