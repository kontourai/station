/**
 * archive#895 wave A/B: per-agent capability delivery, resolution stage
 * (docs/design/agent-engine-unification.md §3.2/§5/§6.2).
 *
 * Enriches a `startSession` command's input with a `ResolvedAgentDefinition`
 * when the session is starting as a real on-disk agent (a canonical
 * `metadata.agentSlug`) whose
 * provider has at least one session-delivery channel this wave (ACP tool
 * servers; Claude skills and, as of wave B, the authored system prompt;
 * codex and ACP prompts are receipted `engine-unsupported`). An authored
 * field — including an authored empty array — is the source of truth for
 * that capability and overrides the connection-level default the adapter
 * would otherwise apply; an unauthored field stays `undefined` so the
 * adapter's existing connection-default fallback is unchanged. An authored
 * `systemPrompt` is the one exception to the authored-empty-overrides rule:
 * an empty/whitespace prompt is UNAUTHORED for delivery purposes (see
 * `ResolvedAgentDefinition.systemPrompt`'s doc comment).
 *
 * Pure(ish), mirroring `acp-mcp-passthrough.ts`'s style: the only I/O is the
 * three injected callbacks. The resolver itself never throws — resolution is
 * defensive enrichment, matching the same defensive-isolation contract as
 * `acp-adapter.ts`'s passthrough resolution. Its OUTPUT is load-bearing,
 * though (archive#3027): whether a definition was attached feeds
 * `sessionAgentStartUnavailableReason` below, which
 * `resolveSessionAgentForStart` (orchestration-service.ts) enforces as a
 * fail-closed authored-spec gate at session start for every
 * delivery-capable provider.
 */
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  ENGINE_CAPABILITY_MATRICES,
  sessionDeliveryChannels,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type {
  CapabilityDeliveryCapability,
  CapabilityUndelivered,
  CapabilityUndeliveredReason,
  ProviderKind,
  ProviderSessionStartInput,
  ResolvedAgentDefinition,
  ResolvedAgentSkill,
  ResolvedAgentToolServer,
  SessionCapabilityDeliveryMetadata,
} from '@kontourai/station-contracts/provider';
import {
  SESSION_CAPABILITY_DELIVERY_METADATA_KEY,
  SYSTEM_PROMPT_CAPABILITY_ID,
} from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { isBuiltinStationControl } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { agentCapabilityUndelivered } from '../../telemetry/metrics.js';

export interface SessionAgentResolverOptions {
  /** Load an agent's spec by slug; `null` for an unknown/not-on-disk agent. */
  loadAgentSpec: (slug: string) => Promise<AgentSpec | null>;
  /** Resolve a Station tool-server id (`ToolDef.id`, kind 'mcp'); `null` when unknown. */
  resolveToolServer: (id: string) => Promise<ToolDef | null>;
  /** Resolve a Station skill id to its installed on-disk directory; `null` when unknown. */
  resolveSkillDir: (id: string) => Promise<string | null>;
  logger?: { warn?: (message: string, ...args: unknown[]) => void };
}

export type ResolveSessionAgent = (
  input: ProviderSessionStartInput,
) => Promise<ProviderSessionStartInput>;

/**
 * The narrow authored-spec policy boundary enforced before a session reaches
 * an adapter. Catalog callers supply whether their server-side spec
 * resolution found the same Agent definition the session resolver would
 * attach.
 *
 * archive#3027: provider-INDEPENDENT by design. The original claude-only
 * check left every other engine default (codex, kiro, opencode, muse)
 * starting spec-less, and any provider name-list here would silently miss
 * kiro/opencode — they dispatch at runtime with provider 'acp'. So this
 * function never consults the provider at all: a session agent slug that
 * did not resolve to an authored Agent definition refuses, whoever the
 * engine is. Callers whose provider has no session-delivery concept
 * (Station's own engine, managed model runtimes) own that exemption by
 * answering `hasResolvedAgent` truthfully for their layer — see
 * `resolveSessionAgentForStart` in orchestration-service.ts.
 */
export function sessionAgentStartUnavailableReason(input: {
  /**
   * Kept for call-site stability and so the startability contract suite can
   * prove provider-independence; deliberately never read.
   */
  provider: string | undefined;
  agentSlug: unknown;
  hasResolvedAgent: boolean;
  unresolvedReason?: string;
}): string | null {
  if (
    typeof input.agentSlug !== 'string' ||
    input.agentSlug.length === 0 ||
    input.hasResolvedAgent
  ) {
    return null;
  }
  return (
    input.unresolvedReason ??
    // "could not be resolved", not "does not have": the session resolver
    // also reports unresolved after a transient spec-load failure, where an
    // authored definition may well exist on disk (see the resolver's catch).
    `Agent '${input.agentSlug}' could not be resolved to an authored Agent definition, so this session cannot start. Enable this engine by creating an Agent for it — new chats will run as that Agent.`
  );
}

/**
 * The public Station identity is runtime-owned, rather than an authored
 * on-disk agent. When it is bound to Claude or Codex, it still needs the
 * same Station-control capability the local Station engine receives from
 * `bootstrapRuntimeDefaultAgent`. Keep this narrow to `station`: direct
 * provider aliases must never acquire control-plane authority implicitly.
 */
export function builtinStationAgentSpec(slug: string): AgentSpec | null {
  if (slug !== 'station') return null;
  return {
    name: 'Station',
    prompt: '',
    // archive#1547: `station-docs` sits beside `station-control` here, and the
    // pairing is deliberate rather than symmetrical. `station-control` is the
    // control-plane capability the comment above guards — it carries env
    // (`STATION_API_BASE`/`STATION_PORT`) and is delivered only where the
    // engine's matrix names a reviewed substitution mechanism. `station-docs`
    // carries no `env` at all (`createRuntimeDocsIntegration`,
    // runtime-default-agent.ts), so it needs no exemption and no substitution:
    // it passes the blanket secret-boundary filter on every channel, which is
    // the whole reason a credential-free docs server was built.
    //
    // This list is the ONLY path by which either reaches an external engine
    // for the runtime-owned Station identity — the built-in agent has no
    // authored spec on disk, so `loadAgentSpec` returns null and this synthetic
    // spec is what is resolved. `bootstrapRuntimeDefaultAgent` persists the
    // docs integration BEFORE its external-engine early return precisely so
    // `resolveToolServer('station-docs')` can find it here.
    tools: { mcpServers: ['station-control', 'station-docs'] },
  };
}

/**
 * Station#975 (unification) D-2: derived from the single-source
 * `ENGINE_CAPABILITY_MATRICES` (packages/contracts/src/engine-capability-matrix.ts)
 * instead of a locally-owned map, so the editor's capability truth and this
 * resolver's session-delivery truth cannot diverge. A provider absent from
 * the matrix (e.g. 'bedrock', 'ollama') never resolves — the resolver
 * no-ops for it, matching the prior map's behavior exactly. Within a mapped
 * provider, a capability the matrix marks not-`session` means the agent may
 * still author it, but this engine has no channel for it this wave — that
 * is receipted `engine-unsupported`, never silently dropped.
 *
 * archive#895 wave B: codex has NO channels — an authored capability on a
 * codex-bound agent is receipted engine-unsupported (before that wave
 * codex authored fields were dropped with no receipt at all).
 *
 * archive#896 wave 2 evidence gate (docs/design/agent-engine-unification.md
 * §4.1/§6.1): `codex app-server generate-json-schema` against the installed
 * codex-cli 0.145.0 CONFIRMS `developerInstructions` as a wire param on
 * `ThreadStartParams`, `ThreadResumeParams`, and `ThreadForkParams` — the
 * systemPrompt wire channel Ambiguity A names IS real. But Ambiguity B's
 * own ship condition ("ship-blocked on schema evidence either way") also
 * requires a version-skew honesty guard — gating on the `initialize`
 * result's server version — and the schema proves that signal DOES NOT
 * EXIST: `InitializeResponse` carries only
 * `codexHome`/`platformFamily`/`platformOs`/`userAgent` (no version, no
 * server-capabilities field), and `InitializeParams`/`InitializeCapabilities`
 * are CLIENT-declared only — there is no server-side version or feature
 * negotiation anywhere in the app-server protocol to gate on. Sending
 * `developerInstructions` unconditionally would be exactly the "accept and
 * quietly not deliver" behavior §5 forbids for any app-server that
 * predates the field. So this cell stays `unsupported` in the matrix —
 * evidence-gated DROP, not a silent gap: `systemPrompt` delivery ships once
 * a genuine version/capability signal exists to gate on (a CLI-`--version`
 * probe is the likely next mechanism, deliberately not built this wave —
 * it wasn't reviewed and duplicates none of the existing CLI-probe
 * machinery in `cli-auth.ts` without new design work).
 */

function recordUndelivered(
  provider: ProviderKind,
  entries: CapabilityUndelivered[],
): void {
  for (const entry of entries) {
    agentCapabilityUndelivered.add(1, {
      provider,
      capability: entry.capability,
      reason: entry.reason,
    });
  }
}

/**
 * Resolve one capability's authored ids into delivered/undelivered entries.
 * When the engine has no channel for this capability this wave, every
 * authored id is receipted `engine-unsupported` and nothing is attached —
 * matching decided ambiguity resolution #3.
 */
async function resolveCapability<T>(
  capability: CapabilityDeliveryCapability,
  ids: string[],
  channelSupported: boolean,
  resolveOne: (
    id: string,
  ) => Promise<
    { ok: true; value: T } | { ok: false; reason: CapabilityUndeliveredReason }
  >,
): Promise<{ resolved: T[]; undelivered: CapabilityUndelivered[] }> {
  const undelivered: CapabilityUndelivered[] = [];
  if (!channelSupported) {
    for (const id of ids) {
      undelivered.push({ capability, id, reason: 'engine-unsupported' });
    }
    return { resolved: [], undelivered };
  }
  const resolved: T[] = [];
  for (const id of ids) {
    const outcome = await resolveOne(id);
    if (outcome.ok) {
      resolved.push(outcome.value);
    } else {
      undelivered.push({ capability, id, reason: outcome.reason });
    }
  }
  return { resolved, undelivered };
}

export function createSessionAgentResolver(
  options: SessionAgentResolverOptions,
): ResolveSessionAgent {
  const { loadAgentSpec, resolveToolServer, resolveSkillDir, logger } = options;

  return async function resolveSessionAgent(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSessionStartInput> {
    const slug = input.metadata?.agentSlug;
    if (typeof slug !== 'string' || !slug) {
      return input;
    }
    const channels = sessionDeliveryChannels(input.provider);
    if (!channels) {
      return input;
    }

    try {
      const spec = (await loadAgentSpec(slug)) ?? builtinStationAgentSpec(slug);
      if (!spec) {
        return input;
      }

      const definition: ResolvedAgentDefinition = { slug };
      const report: SessionCapabilityDeliveryMetadata = { agentSlug: slug };

      const authoredToolServers = spec.tools?.mcpServers;
      if (authoredToolServers !== undefined) {
        // Station#1157 (extended archive#1195): the canonical built-in
        // station-control server is the ONE exemption from the blanket
        // secret-boundary-env filter below, and ONLY when this engine's
        // matrix names a `builtinStationControlDelivery` substitution
        // mechanism for its toolServers channel — i.e. the delivering
        // adapter has a REVIEWED, non-secret-crossing way to make the
        // built-in server work despite its persisted `toolDef.env`
        // (`STATION_API_BASE`/`STATION_PORT`) never actually reaching this
        // engine: 'env' for Claude's 'subprocess' channel (the Agent SDK
        // spawns the MCP child itself, inside STATION'S OWN PROCESS) and
        // 'url-token' for Codex's 'wire' channel (archive#1195:
        // codex-mcp-passthrough.ts substitutes a per-session, short-lived,
        // station-control-scoped bearer token riding a URL query string —
        // never env — because `codex app-server` independently manages its
        // own outbound MCP connections and can never safely receive env).
        // ACP is ALSO 'wire' and, since archive#1684, names its own
        // 'http-header-token' mechanism — so it too is exempt HERE. What
        // that does NOT mean is that every ACP session gets
        // station-control: ACP's mechanism carries
        // `basis: 'runtime_observation'`, and `acp-adapter.ts`'s live
        // `mcpCapabilities.http` gate is what decides per connection (see
        // the DOC CONTRACT immediately below, which was written for exactly
        // this case). An engine class with no mechanism at all still keeps
        // rejecting station-control here — this keys on the matrix (single
        // source of truth), never a hardcoded per-engine id check.
        //
        // archive#1549 — DOC CONTRACT, read before flagging drift: this
        // exemption and `engineControlPlaneCapability` (the picker/binding
        // predicate) used to be documented as the SAME predicate. They are
        // now intentionally different questions over the same cell:
        //   - HERE: "does a reviewed, non-secret-crossing mechanism exist
        //     for this ENGINE CLASS?" — static, `!== undefined`, unchanged.
        //   - THERE: "does one exist AND is it verified for THIS SUBJECT?"
        //     — which, for a cell whose mechanism carries
        //     `basis: 'runtime_observation'`, additionally requires a live
        //     per-connection observation.
        // They coincide in effect today (every shipped cell is
        // `basis: 'declared'`, and a declared mechanism ignores the
        // observation). For an observation-based cell they diverge in one
        // safe direction only: this resolver may exempt a server that the
        // picker would not yet offer, and the DELIVERING ADAPTER's live
        // capability gate — not this static check — owns the per-subject
        // truth and emits the undelivered receipt when it says no. See
        // `engineControlPlaneCapability`'s doc comment in
        // `engine-capability-matrix.ts`.
        //
        // A real third-party integration
        // authored with a non-empty `env` (e.g. a GITHUB_TOKEN) is NEVER
        // exempt on any channel: `isBuiltinStationControl` is the same
        // exact-command/args identity gate `withStationControlRuntimeEnv`
        // uses. Post-#3063 nuance (review INFO-2): a def authored under a
        // DIFFERENT id keeps its authored command/env and can never pass;
        // a def a user hand-saved under the id `station-control` itself
        // DOES pass here — but only because the ConfigLoader overlay has
        // already replaced its command/args/env wholesale with the genuine
        // built-in identity, so what gets exempted (and delivered, and
        // spawned) is the real built-in with its own non-secret operational
        // env, never the author's binary or the author's env. Fail-toward-
        // genuine; full contract on `isBuiltinStationControl`'s doc comment.
        // `ResolvedAgentToolServer` still cannot carry the exempted
        // `toolDef.env` (see its own doc comment) — each delivering
        // adapter's own passthrough (claude-mcp-passthrough.ts /
        // codex-mcp-passthrough.ts) reconstructs fresh, non-persisted
        // values downstream of this resolution step.
        const toolServersChannel =
          ENGINE_CAPABILITY_MATRICES[input.provider]?.toolServers;
        const builtinStationControlDelivery =
          toolServersChannel?.state === 'session'
            ? toolServersChannel.builtinStationControlDelivery
            : undefined;
        const { resolved, undelivered } =
          await resolveCapability<ResolvedAgentToolServer>(
            'toolServers',
            authoredToolServers,
            channels.toolServers,
            async (id) => {
              const toolDef = await resolveToolServer(id);
              if (!toolDef) return { ok: false, reason: 'not-found' };
              if (toolDef.enabled === false) {
                return { ok: false, reason: 'disabled' };
              }
              if (toolDef.env && Object.keys(toolDef.env).length > 0) {
                const exemptBuiltinStationControl =
                  builtinStationControlDelivery !== undefined &&
                  isBuiltinStationControl(id, toolDef);
                if (!exemptBuiltinStationControl) {
                  return { ok: false, reason: 'secret-boundary-env' };
                }
              }
              return {
                ok: true,
                value: {
                  id: toolDef.id,
                  displayName: toolDef.displayName,
                  transport: toolDef.transport,
                  command: toolDef.command,
                  args: toolDef.args,
                  endpoint: toolDef.endpoint,
                },
              };
            },
          );
        // Unsupported-on-this-engine (channels.toolServers === false):
        // every authored id is already undelivered above, and the field
        // stays unattached on the definition — the connection-default
        // fallback is moot since this engine has no toolServers channel at
        // all, but attaching an empty array here would misreport an
        // authored-empty override that never happened.
        if (channels.toolServers) {
          definition.toolServers = resolved;
        }
        recordUndelivered(input.provider, undelivered);
        report.toolServers = {
          source: 'agent',
          requested: authoredToolServers,
          undelivered,
        };
      }

      const authoredSkills = spec.skills;
      if (authoredSkills !== undefined) {
        const { resolved, undelivered } =
          await resolveCapability<ResolvedAgentSkill>(
            'skills',
            authoredSkills,
            channels.skills,
            async (id) => {
              const dir = await resolveSkillDir(id);
              if (!dir) return { ok: false, reason: 'not-found' };
              return { ok: true, value: { id, dir } };
            },
          );
        if (channels.skills) {
          definition.skills = resolved;
        }
        recordUndelivered(input.provider, undelivered);
        report.skills = {
          source: 'agent',
          requested: authoredSkills,
          undelivered,
        };
      }

      // Auto-approve fix (station tool-approval parity): unlike
      // toolServers/skills/systemPrompt above, this is never gated by
      // `sessionDeliveryChannels` — it isn't delivered to the engine at
      // all, it's consumed entirely Station-side by the adapter's own
      // tool-permission gate (mirrors Station-engine's
      // `isAutoApproved`/`agent-hooks.ts` behavior). Attach it whenever
      // authored, including an authored empty array.
      if (spec.tools?.autoApprove !== undefined) {
        definition.autoApprove = spec.tools.autoApprove;
      }

      // archive#895 wave B: the prompt is on the spec, not a resolved id — no
      // resolveOne I/O, unlike toolServers/skills above. There is no
      // connection-level prompt default anywhere in the codebase, so
      // `source` is always 'agent' (never 'connection-default').
      const authoredPrompt =
        typeof spec.prompt === 'string' && spec.prompt.trim().length > 0
          ? spec.prompt
          : undefined;
      if (authoredPrompt !== undefined) {
        if (channels.systemPrompt) {
          definition.systemPrompt = authoredPrompt;
          report.systemPrompt = {
            source: 'agent',
            requested: [SYSTEM_PROMPT_CAPABILITY_ID],
            undelivered: [],
          };
        } else {
          const undelivered: CapabilityUndelivered[] = [
            {
              capability: 'systemPrompt',
              id: SYSTEM_PROMPT_CAPABILITY_ID,
              reason: 'engine-unsupported',
            },
          ];
          recordUndelivered(input.provider, undelivered);
          report.systemPrompt = {
            source: 'agent',
            requested: [SYSTEM_PROMPT_CAPABILITY_ID],
            undelivered,
          };
        }
      }

      return {
        ...input,
        agent: definition,
        metadata: {
          ...input.metadata,
          [SESSION_CAPABILITY_DELIVERY_METADATA_KEY]: report,
        },
      };
    } catch (error) {
      logger?.warn?.(
        `Session agent resolution failed for agent '${slug}'; continuing without a resolved agent definition.`,
        error,
      );
      return input;
    }
  };
}
