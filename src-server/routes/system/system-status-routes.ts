import { execFile } from 'node:child_process';
import type {
  EngineConnectionId,
  EngineId,
} from '@kontourai/station-contracts/agent-identity';
import {
  ENGINE_CAPABILITY_MATRICES,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { ExternalEngineReadinessProjection } from '@kontourai/station-contracts/system-status';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import {
  describeTerminalPtyLoadFailure,
  type TerminalCapability,
  terminalPtyUnavailableReason,
} from '@kontourai/station-shared/terminal-capability';
import { Hono } from 'hono';
import { resolveDeploymentCapabilities } from '../../capabilities/deployment-capabilities.js';
import {
  connectionIdForAdapter,
  engineIdForAdapter,
} from '../../providers/adapter-identity.js';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import { checkBedrockCredentials } from '../../providers/llm/bedrock.js';
import {
  getAllPrerequisites,
  getProviderAdapters,
} from '../../providers/registries/registry.js';
import { resolveRuntimeAdapterReadiness } from '../../runtime/frameworks/runtime-adapter-readiness.js';
import type { ManagedChatBinding } from '../../runtime/plugins/runtime-provider-resolution.js';
import {
  onboardingRecommendations,
  systemOps,
} from '../../telemetry/metrics.js';
import { raceWithSignal } from '../../utils/bounded-async.js';
import { detectCliOnPath } from '../../utils/cli-detection.js';
import { readBuildProvenance } from './build-provenance.js';
import { resolveDevicePresentation } from './device-presentation.js';
import type {
  CapabilityState,
  ConfiguredProvider,
  SystemBuildProvenance,
  SystemRecommendation,
  SystemStatusDeps,
} from './system-route-types.js';

export { readBuildProvenance } from './build-provenance.js';

export const STATUS_PREREQUISITES_CACHE_TTL_MS = 60_000;
export const STATUS_PREREQUISITES_REFRESH_BUDGET_MS = 2_000;
const E2E_BUILD_PROVENANCE: SystemBuildProvenance = {
  fullSha: '0123456789abcdef0123456789abcdef01234567',
  shortSha: '0123456',
  branch: 'e2e',
  builtAt: '2026-01-01T00:00:00.000Z',
  ageSeconds: 0,
  instanceId: 'e2e',
  bootId: '00000000-0000-4000-8000-000000000000',
};

/**
 * The literal every producer writes when it could not determine a value —
 * `packages/cli/src/commands/lifecycle.ts` sets all three build fields to it
 * when no build manifest exists. It is an absence marker, not a value, so it
 * is stripped here rather than displayed as if it were a branch name.
 */
function normalizeConfiguredProviders(
  providers: ConfiguredProvider[],
): Array<ConfiguredProvider & { capabilities: string[] }> {
  return providers.map((provider) => ({
    ...provider,
    capabilities: provider.capabilities ?? [],
  }));
}

// archive#1193 (epic archive#1191, slice A): "chat ready" must be engine-agnostic —
// a ready EXTERNAL engine (Claude Code, Codex, or any future command-backed
// engine) is exactly as chat-capable as a connected ACP engine, symmetric
// with `acpConnected` below. This is derived GENERICALLY from the registered
// provider-adapter set + the shared engine-capability matrix, never by
// naming an engine id:
//   1. `engineIdForAdapter(adapter) !== 'station'` selects adapters that
//      back an external engine rather than Station's own managed engine
//      (Bedrock/Ollama resolve to 'station' and are excluded — they are
//      Model connections, handled separately via `credentialsFound`/
//      `managedChatReady`).
//   2. `engineCanDeliverChat` consults `ENGINE_CAPABILITY_MATRICES` (falling
//      back to `UNKNOWN_EXTERNAL_ENGINE_MATRIX` for an unlisted engine) —
//      today every external engine's `modelSelection` is `session`/`native`,
//      so this is a real (not vacuous) guard against a hypothetical future
//      engine that cannot run a chat turn at all.
//   3. Readiness itself reuses `resolveRuntimeAdapterReadiness` — the exact
//      resolver the Connections hub already uses — fed by that adapter's
//      OWN `getPrerequisites()` (CLI resolvable AND authenticated; see
//      `buildCliRuntimePrerequisites`/`detectClaudeAuthState`), never a bare
//      `which` check.
// ACP is deliberately excluded from this generic scan: its adapter's
// `getPrerequisites()` reports "ready" for zero configured connections (no
// required prerequisite is missing when there's nothing to check), while
// `deps.getACPStatus().connected` already reflects genuine live session
// availability — a strictly stronger, pre-existing signal for that one
// engine. Any other external engine (present or future) participates here
// automatically; no per-engine branch is added.
function engineCanDeliverChat(provider: string): boolean {
  const matrix =
    ENGINE_CAPABILITY_MATRICES[provider] ?? UNKNOWN_EXTERNAL_ENGINE_MATRIX;
  return matrix.modelSelection.state !== 'unsupported';
}

export interface ExternalEngineReadiness {
  ready: boolean;
  source: string | null;
  engines: ExternalEngineReadinessProjection[];
}

interface StatusDiscoverySnapshot {
  credentialsFound: boolean;
  kiroCliInstalled: boolean;
  ollamaReachable: boolean;
  codexInstalled: boolean;
  claudeInstalled: boolean;
  externalEngineReadiness: ExternalEngineReadiness;
  prerequisites: Awaited<ReturnType<typeof getAllPrerequisites>>;
  developerServices: DeveloperServiceStatus[];
}

interface DeveloperServiceStatus {
  id: 'git' | 'github' | 'gitlab';
  name: string;
  state: 'ready' | 'not_installed' | 'sign_in_required' | 'error';
  detail: string;
  command?: string;
}

const PENDING_DISCOVERY_SNAPSHOT: StatusDiscoverySnapshot = {
  credentialsFound: false,
  kiroCliInstalled: false,
  ollamaReachable: false,
  codexInstalled: false,
  claudeInstalled: false,
  externalEngineReadiness: { ready: false, source: null, engines: [] },
  prerequisites: [],
  developerServices: [],
};

type CommandProbeState =
  | 'ready'
  | 'not_installed'
  | 'sign_in_required'
  | 'error';

export function classifyCommandProbe(
  error:
    | (Error & {
        code?: string | number | null;
        killed?: boolean;
        signal?: string | null;
      })
    | null,
  authenticationCheck: boolean,
): CommandProbeState {
  if (!error) return 'ready';
  if (error.code === 'ENOENT' || error.code === 127) return 'not_installed';
  if (
    authenticationCheck &&
    typeof error.code === 'number' &&
    !error.killed &&
    !error.signal
  ) {
    return 'sign_in_required';
  }
  return 'error';
}

function execStatus(
  command: string,
  args: string[],
  authenticationCheck = false,
): Promise<CommandProbeState> {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 1_500 }, (error) => {
      resolve(classifyCommandProbe(error, authenticationCheck));
    });
  });
}

async function discoverDeveloperServices(): Promise<DeveloperServiceStatus[]> {
  const [git, github, gitlab] = await Promise.all([
    execStatus('git', ['--version']),
    execStatus('gh', ['auth', 'status'], true),
    execStatus('glab', ['auth', 'status'], true),
  ]);
  const authenticatedService = (
    id: 'github' | 'gitlab',
    name: string,
    result: CommandProbeState,
    installCommand: string,
    signInCommand: string,
  ): DeveloperServiceStatus => {
    if (result === 'not_installed') {
      return {
        id,
        name,
        state: 'not_installed',
        detail: `${name} needs its command-line tool on this Station host.`,
        command: installCommand,
      };
    }
    if (result === 'sign_in_required') {
      return {
        id,
        name,
        state: 'sign_in_required',
        detail: `The command-line tool is installed, but ${name} is not signed in.`,
        command: signInCommand,
      };
    }
    if (result === 'error') {
      return {
        id,
        name,
        state: 'error',
        detail: `${name} is installed, but Station could not check it.`,
        command: `${name === 'GitHub' ? 'gh' : 'glab'} auth status`,
      };
    }
    return {
      id,
      name,
      state: 'ready',
      detail: 'Installed and signed in on this Station host.',
    };
  };
  return [
    git === 'ready'
      ? {
          id: 'git',
          name: 'Git',
          state: 'ready',
          detail: 'Installed on this Station host.',
        }
      : {
          id: 'git',
          name: 'Git',
          state: git === 'error' ? 'error' : 'not_installed',
          detail:
            git === 'error'
              ? 'Git is installed but could not be checked.'
              : 'Git is needed for local repositories and source control.',
          command: 'Install Git with your operating system package manager.',
        },
    authenticatedService(
      'github',
      'GitHub',
      github,
      'Install GitHub CLI: https://cli.github.com',
      'gh auth login',
    ),
    authenticatedService(
      'gitlab',
      'GitLab',
      gitlab,
      'Install GitLab CLI: https://gitlab.com/gitlab-org/cli',
      'glab auth login',
    ),
  ];
}

/**
 * Build the enabled-predicate for chat readiness from LIVE connection state.
 *
 * Three outcomes, kept distinct on purpose — this is the "a default that
 * decides" smell (docs/guides/code-quality.md), and the previous attempt at
 * this fix was itself an instance of it:
 *
 *   dep absent   -> permissive. Test fixtures and older callers supply no
 *                   `listEngineConnectionStates`; behaviour is unchanged for them
 *                   and matches the pre-#1194 default.
 *   call throws  -> RESTRICTIVE. "Couldn't look" is not "not disabled". An
 *                   engine we cannot verify must not count toward a chat
 *                   readiness claim, mirroring the `getPrerequisites` guard
 *                   below. Chat readiness then rests on the managed model or
 *                   ACP, both of which are checked independently.
 *   call succeeds-> the connection's own `enabled`, defaulting to true only
 *                   for an id the live list does not mention at all.
 */
async function resolveRuntimeConnectionState(deps: SystemStatusDeps): Promise<{
  isEnabled: (engineId: EngineId) => boolean;
  connectionIdFor: (engineId: EngineId) => EngineConnectionId | undefined;
}> {
  if (typeof deps.listEngineConnectionStates !== 'function') {
    return {
      isEnabled: () => true,
      connectionIdFor: () => undefined,
    };
  }
  try {
    const connections = await deps.listEngineConnectionStates();
    const disabled = new Set(
      connections.filter((c) => !c.enabled).map((c) => c.engineId),
    );
    const connectionIds = new Map(
      connections.map((connection) => [
        connection.engineId,
        connection.engineConnectionId,
      ]),
    );
    return {
      isEnabled: (engineId) => !disabled.has(engineId),
      connectionIdFor: (engineId) => connectionIds.get(engineId),
    };
  } catch {
    return { isEnabled: () => false, connectionIdFor: () => undefined };
  }
}

/**
 * archive#1194 review (HIGH): this previously hardcoded `enabled: true`, so it
 * was STRUCTURALLY unable to see a connection the user had disabled in the
 * Connections hub — it had no `appConfig` to consult. `enriched-agents.ts`
 * reads the real setting (`conn.enabled && conn.status === 'ready'`) and
 * correctly withholds the agent, so a disabled-but-otherwise-ready engine
 * produced `chat.ready: true` with nothing selectable behind it: the exact
 * one-payload-two-answers defect this slice exists to remove, one layer down.
 *
 * `isRuntimeEnabled` mirrors `runtimeSettingsFor`'s rule
 * (`appConfig.agentConnections?.[id]?.enabled ?? true`) rather than importing
 * it — that helper is not exported, and duplicating one boolean lookup is
 * cheaper than widening a cross-service surface for it. The default keeps a
 * never-configured first run reading as enabled, which is the same answer the
 * old hardcode gave for that case.
 */
export async function resolveExternalEngineReadiness(
  adapters: ProviderAdapterShape[] = getProviderAdapters(),
  signal?: AbortSignal,
  isRuntimeEnabled: (engineId: EngineId) => boolean = () => true,
  resolveEngineConnectionId: (
    adapter: ProviderAdapterShape,
  ) => EngineConnectionId | undefined = connectionIdForAdapter,
): Promise<ExternalEngineReadiness> {
  const candidates = adapters.filter(
    (adapter) =>
      adapter.provider !== 'acp' &&
      engineIdForAdapter(adapter) !== 'station' &&
      adapter.metadata.capabilities.includes('agent-runtime') &&
      engineCanDeliverChat(adapter.provider),
  );
  const readiness = await Promise.all(
    candidates.map(
      async (adapter): Promise<ExternalEngineReadinessProjection> => {
        const engineId = engineIdForAdapter(adapter);
        const name = adapter.metadata.displayName;
        const publicEngineConnectionId = resolveEngineConnectionId(adapter);
        const navigationIdentity = publicEngineConnectionId
          ? { engineConnectionId: publicEngineConnectionId }
          : {};
        // Fail-closed (archive#1193 review finding 1): `getPrerequisites` is
        // OPTIONAL on `ProviderAdapterShape`. Treating an adapter that doesn't
        // implement it as `prerequisites: []` would let
        // `resolveRuntimeAdapterReadiness` find nothing required-missing and
        // report `ready: true` with ZERO verification — vacuously "ready" for
        // any plugin external-engine adapter that never wired up an auth probe.
        // Not exploitable in-tree today (claude/codex both implement it), but a
        // candidate we cannot actually verify must never count as ready.
        if (typeof adapter.getPrerequisites !== 'function') {
          return {
            engineId,
            name,
            ...navigationIdentity,
            detected: false,
            ready: false,
            source: null,
            reason: 'cannot_verify',
          };
        }
        // Must match `engineIdForAdapter`, which is the key used for the
        // engine's enabled setting.
        try {
          const prerequisites =
            (await raceWithSignal(
              adapter.getPrerequisites({ signal }),
              signal,
            )) ?? [];
          const adapterReadiness = resolveRuntimeAdapterReadiness({
            adapter,
            engineId,
            enabled: true,
            prerequisites,
          });
          const detected = adapterReadiness.prerequisites.some(
            (prerequisite) =>
              prerequisite.id.endsWith('-cli') &&
              prerequisite.status === 'installed',
          );
          // A connection the user disabled is not a chat-readiness candidate:
          // the agent-manufacture path withholds it. We still probe first so
          // `detected` remains an observation, not an assertion about an
          // executable that might not exist.
          if (!isRuntimeEnabled(engineId)) {
            return {
              engineId,
              name,
              ...navigationIdentity,
              detected,
              ready: false,
              source: null,
              reason: 'disabled',
            };
          }
          if (adapterReadiness.ready) {
            return {
              engineId,
              name,
              ...navigationIdentity,
              detected,
              ready: true,
              source: `${adapter.provider}-cli`,
            };
          }
          // An errored probe is not evidence of an authentication problem. In
          // particular, CLI auth probes deliberately return `error` when they
          // cannot safely establish auth state.
          const cannotVerify = adapterReadiness.prerequisites.some(
            (prerequisite) =>
              prerequisite.status === 'error' &&
              !prerequisite.id.endsWith('-cli'),
          );
          const completedCliError = adapterReadiness.prerequisites.some(
            (prerequisite) =>
              prerequisite.status === 'error' &&
              prerequisite.id.endsWith('-cli'),
          );
          const needsSignIn = adapterReadiness.missingPrerequisites.some(
            (prerequisite) =>
              prerequisite.id.endsWith('-auth') &&
              prerequisite.status === 'missing',
          );
          return {
            engineId,
            name,
            ...navigationIdentity,
            detected,
            ready: false,
            source: null,
            reason: cannotVerify
              ? 'cannot_verify'
              : completedCliError
                ? 'missing_prerequisites'
                : needsSignIn
                  ? 'sign_in_required'
                  : 'missing_prerequisites',
          };
        } catch {
          return {
            engineId,
            name,
            ...navigationIdentity,
            detected: false,
            ready: false,
            source: null,
            reason: 'cannot_verify',
          };
        }
      },
    ),
  );
  const ready = readiness.find((candidate) => candidate.ready);
  return { ready: !!ready, source: ready?.source ?? null, engines: readiness };
}

/**
 * The stronger evidence wins (#765 B2). `reason: 'cannot_verify'` is not an
 * observation — it is the shape produced when the probe ABORTED at this
 * route's 2 s discovery budget (`STATUS_PREREQUISITES_REFRESH_BUDGET_MS`),
 * threw, or returned an errored prerequisite whose own contract is "cannot
 * safely establish auth state". Letting that zero-information result
 * overwrite a previously VERIFIED `ready: true` projection is what produced
 * the audit's contradiction: the Engines list (whose inspector probe runs
 * with no such budget) said READY while this route's flap re-armed the
 * first-run "Station cannot verify…" launcher minutes into a session, on a
 * host that was busy precisely because the engine was working.
 *
 * So: a `cannot_verify` refresh result keeps the last GENUINE projection for
 * that engine — not only `ready` (#851 extends #765 B2's ready-only hold):
 * `sign_in_required`, `missing_prerequisites`, and `disabled` are equally
 * completed observations, and downgrading them to "cannot verify" on a
 * zero-information flap erases an actionable reason without inventing or
 * removing readiness (they are all `ready: false`). Every genuine
 * observation still replaces the held projection immediately, so a real
 * change (CLI uninstalled, signed out, signed in, connection disabled)
 * surfaces on the first probe that actually completes. The disclosed
 * residual: an engine whose probe never completes again keeps its last
 * genuine projection for this process's lifetime — indistinguishable here
 * from the load-induced timeout this exists to absorb, and strictly less
 * wrong than downgrading a completed observation on no evidence.
 */
export function reconcileExternalEngineReadiness(
  previous: ExternalEngineReadiness | undefined,
  next: ExternalEngineReadiness,
): ExternalEngineReadiness {
  if (!previous) return next;
  const previousByEngineId = new Map(
    previous.engines.map((engine) => [engine.engineId, engine]),
  );
  const engines = next.engines.map((engine) => {
    if (engine.reason !== 'cannot_verify') return engine;
    return previousByEngineId.get(engine.engineId) ?? engine;
  });
  const ready = engines.find((candidate) => candidate.ready);
  return { ready: !!ready, source: ready?.source ?? null, engines };
}

/**
 * The model connection a managed-chat claim is ABOUT: the one the engine
 * would actually select when the resolver can name it, and otherwise the
 * first that carries no refusal. Delta review H2 — naming a healthy sibling
 * that is not the binding is what made "already configured" a claim about the
 * wrong connection.
 */
function chatCapableLlmProviders(
  configuredProviders: Array<ConfiguredProvider & { capabilities: string[] }>,
  binding: ManagedChatBinding | undefined,
): Array<ConfiguredProvider & { capabilities: string[] }> {
  const enabled = configuredProviders.filter(
    (provider) =>
      provider.enabled &&
      provider.capabilities.includes('llm') &&
      !provider.checkGated,
  );
  // Delta2 review H2: an ambiguous or invalid binding names NO connection.
  // Returning the enabled list here is what let the recommendation attribute
  // readiness to whichever unrefused sibling sorted first.
  if (binding?.kind === 'ambiguous' || binding?.kind === 'invalid') return [];
  if (binding?.kind !== 'resolved') return enabled;
  return enabled.filter((provider) => provider.id === binding.connectionId);
}

function buildCapabilityStates(input: {
  credentialsFound: boolean;
  ollamaReachable: boolean;
  externalEngineReady: boolean;
  externalEngineSource: string | null;
  acpConnected: boolean;
  managedChatReady: boolean;
  configuredProviders: Array<ConfiguredProvider & { capabilities: string[] }>;
  binding?: ManagedChatBinding;
  terminalCapability?: TerminalCapability;
}): Record<string, CapabilityState> {
  // Review H1: a connection whose latest bound check was refused is not a
  // chat-capable model connection, however many prerequisites it satisfies.
  // Delta review H2: and the claim is about the BOUND connection.
  const configuredLlmProviders = chatCapableLlmProviders(
    input.configuredProviders,
    input.binding,
  );
  const knowledgeProviders = input.configuredProviders.filter(
    (provider) =>
      provider.enabled && provider.capabilities.includes('vectordb'),
  );

  return {
    // archive#1194: chat readiness is engine-agnostic, symmetric with
    // `runtime` below and resolved from the same signals. A ready engine
    // connection is already manufactured into a selectable agent
    // (`__agent:<connectionId>`, see enriched-agents.ts's
    // `conn.enabled && conn.status === 'ready'` branch), so a machine with
    // Claude Code or Codex ready can start a chat with no model connection
    // and no default agent — which is exactly what `runtime.ready` already
    // reported while this said `false`, the contradiction archive#1191 opens with.
    //
    // Deliberately NOT gated on a registered default agent. That agent is a
    // convenience — the assistant that can set up projects, agents and
    // skills — so its absence degrades onboarding, not capability. Coupling
    // the two would block the user who just wants to point Station at a
    // directory and drive Claude Code.
    chat: {
      ready:
        input.managedChatReady ||
        input.externalEngineReady ||
        input.acpConnected,
      source: input.managedChatReady
        ? (configuredLlmProviders[0]?.type ?? null)
        : input.externalEngineReady
          ? input.externalEngineSource
          : input.acpConnected
            ? 'acp'
            : null,
    },
    runtime: {
      ready:
        input.credentialsFound ||
        input.externalEngineReady ||
        input.acpConnected,
      source: input.acpConnected
        ? 'acp'
        : input.externalEngineReady
          ? input.externalEngineSource
          : input.credentialsFound
            ? 'bedrock-detected'
            : null,
    },
    knowledge: {
      ready: knowledgeProviders.length > 0,
      source: knowledgeProviders[0]?.type ?? null,
    },
    acp: {
      ready: input.acpConnected,
      source: input.acpConnected ? 'acp' : null,
    },
    // #1244: the degraded-terminal capability. Present only when the route
    // host supplied a live probe — a host that observed nothing makes no
    // terminal claim. `reason` carries the specific, actionable cause so the
    // UI's readiness surface never renders a silently dead terminal pane.
    ...(input.terminalCapability
      ? {
          terminal:
            input.terminalCapability.state === 'available'
              ? { ready: true, source: 'node-pty' }
              : {
                  ready: false,
                  source: null,
                  reason: input.terminalCapability.reason,
                },
        }
      : {}),
  };
}

function buildSystemRecommendation(input: {
  configuredProviders: Array<ConfiguredProvider & { capabilities: string[] }>;
  credentialsFound: boolean;
  ollamaReachable: boolean;
  externalEngineReady: boolean;
  acpConnected: boolean;
  managedChatReady: boolean;
  binding?: ManagedChatBinding;
}): SystemRecommendation {
  const detectedProvider = input.ollamaReachable
    ? { type: 'ollama', label: 'Ollama' }
    : input.credentialsFound
      ? { type: 'bedrock', label: 'Amazon Bedrock' }
      : null;
  // Review H1: the same predicate the capability states use. A refused
  // connection still matches `configuredLlmProvider` below, so it lands on
  // "The default model connection needs attention" — which is what it is —
  // instead of being recommended as already chat-capable above its own
  // failed card.
  // Delta review H2: and it is the BOUND connection this names, not whichever
  // unrefused sibling happens to sort first.
  const enabledLlmProvider = chatCapableLlmProviders(
    input.configuredProviders,
    input.binding,
  )[0];
  if (enabledLlmProvider && input.managedChatReady) {
    return {
      code: 'configured-chat-ready',
      type: 'providers',
      actionLabel: 'Review model connections',
      title: 'A chat-capable model connection is already configured',
      detail: `Station can already route chat through ${enabledLlmProvider.type}. Review connections if you want to change the default.`,
    };
  }
  // archive#1194: a ready engine outranks an inactive model connection.
  // `runtime-only` below already carries the correct copy ("Ready engines can
  // start a chat without a separate model connection") — it was simply
  // unreachable, because ANY configured-but-inactive LLM provider (a detected
  // Ollama server is enough) matched `configured-no-chat` first and sent the
  // user to Connections to fix a model they do not need. On a machine with
  // Claude Code and Codex both ready and authenticated, that read as
  // "No chat-capable connection is enabled" while chat was in fact available.
  if (input.externalEngineReady || input.acpConnected) {
    return {
      code: 'runtime-only',
      type: 'runtimes',
      actionLabel: 'Review engines',
      title: 'An engine is available',
      detail: 'Station found a ready engine that can start a chat.',
    };
  }
  const configuredLlmProvider = input.configuredProviders.find((provider) =>
    provider.capabilities.includes('llm'),
  );
  if (configuredLlmProvider) {
    // Delta2 review H2: when the binding itself is what is missing, say that
    // and name the action that fixes it — the generic "choose or repair"
    // sends the user looking for a broken connection that does not exist.
    if (input.binding?.kind === 'ambiguous') {
      return {
        code: 'configured-no-chat',
        type: 'providers',
        actionLabel: 'Choose a default model connection',
        title: 'Choose which model connection Station uses',
        detail:
          'More than one model connection is enabled and none is set as the default, so Station cannot tell which one to use for chat.',
      };
    }
    if (input.binding?.kind === 'invalid') {
      return {
        code: 'configured-no-chat',
        type: 'providers',
        actionLabel: 'Choose a default model connection',
        title: 'The default model connection is unavailable',
        detail:
          'The model connection Station is set to use is not enabled or no longer exists. Choose an available one as the default.',
      };
    }
    return {
      code: 'configured-no-chat',
      type: 'providers',
      actionLabel: 'Review model connections',
      title: 'No model connection is ready for chat',
      detail: 'Enable or repair a model connection in Connections.',
    };
  }
  if (detectedProvider) {
    return {
      code: 'detected-provider',
      type: 'providers',
      actionLabel: `Add ${detectedProvider.label} connection`,
      title: `${detectedProvider.label} is available`,
      detail:
        detectedProvider.type === 'ollama'
          ? 'Add the detected local Ollama server if you want Station to use it for chat.'
          : 'Use the detected credentials to add Bedrock if you want Station to use it for chat.',
      detectedProviderType: detectedProvider.type,
      detectedProviderLabel: detectedProvider.label,
    };
  }
  return {
    code: 'unconfigured',
    type: 'connections',
    actionLabel: 'Open Connections',
    title: 'Choose what powers Station',
    detail: 'Add a model connection or engine for chat, agents, or both.',
  };
}

// Coarse CLI-presence probe kept only for the diagnostic `clis` field below
// and the `prerequisites` install-guide list — NOT the readiness signal. Real
// chat-readiness for an external engine comes from
// `resolveExternalEngineReadiness` (CLI resolvable AND authenticated), never
// from this alone. Shared with native-engine adoption (archive#1575) so both agree
// on what "installed" means.
const whichCmd = detectCliOnPath;

function createStatusDiscoveryCache(deps: SystemStatusDeps) {
  let snapshot: StatusDiscoverySnapshot | undefined;
  let freshUntil = 0;
  let refreshPromise: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (refreshPromise) return refreshPromise;
    const controller = new AbortController();
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error('System status prerequisite discovery timed out.'),
        ),
      STATUS_PREREQUISITES_REFRESH_BUDGET_MS,
    );
    const booleanProbe = async (operation: Promise<boolean>) => {
      try {
        return await raceWithSignal(operation, controller.signal);
      } catch {
        return false;
      }
    };

    refreshPromise = (async () => {
      const runtimeConnectionState = await raceWithSignal(
        resolveRuntimeConnectionState(deps),
        controller.signal,
      ).catch(() => ({
        isEnabled: () => false,
        connectionIdFor: () => undefined,
      }));
      const [
        credentialsFound,
        kiroCliInstalled,
        ollamaReachable,
        codexInstalled,
        claudeInstalled,
        externalEngineReadiness,
        prerequisites,
        developerServices,
      ] = await Promise.all([
        booleanProbe(checkBedrockCredentials()),
        booleanProbe(whichCmd('kiro-cli')),
        booleanProbe(
          deps.checkOllamaAvailability?.() ?? Promise.resolve(false),
        ),
        booleanProbe(whichCmd('codex')),
        booleanProbe(whichCmd('claude')),
        resolveExternalEngineReadiness(
          undefined,
          controller.signal,
          runtimeConnectionState.isEnabled,
          (adapter) =>
            typeof deps.listEngineConnectionStates === 'function'
              ? runtimeConnectionState.connectionIdFor(
                  engineIdForAdapter(adapter),
                )
              : connectionIdForAdapter(adapter),
        ),
        getAllPrerequisites({ signal: controller.signal }),
        discoverDeveloperServices(),
      ]);
      snapshot = {
        credentialsFound,
        kiroCliInstalled,
        ollamaReachable,
        codexInstalled,
        claudeInstalled,
        // See `reconcileExternalEngineReadiness`: an aborted/errored probe
        // (`cannot_verify`) must not overwrite an engine this cache has
        // already genuinely observed — that flap is what re-armed the
        // first-run launcher against a working engine (#765 B2, #851).
        externalEngineReadiness: reconcileExternalEngineReadiness(
          snapshot?.externalEngineReadiness,
          externalEngineReadiness,
        ),
        prerequisites,
        developerServices,
      };
      freshUntil = Date.now() + STATUS_PREREQUISITES_CACHE_TTL_MS;
    })()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timeout);
        refreshPromise = undefined;
      });
    return refreshPromise;
  };

  return {
    read(): {
      snapshot: StatusDiscoverySnapshot;
      state: 'pending' | 'ready' | 'stale';
    } {
      const state = !snapshot
        ? 'pending'
        : Date.now() >= freshUntil
          ? 'stale'
          : 'ready';
      if (state !== 'ready') void refresh();
      return {
        snapshot: snapshot ?? PENDING_DISCOVERY_SNAPSHOT,
        state,
      };
    },
  };
}

function recommendationOutcome(
  recommendation: Pick<SystemRecommendation, 'code'>,
): 'ready' | 'action_required' {
  // 'runtime-only' now only fires once `resolveExternalEngineReadiness`
  // confirms an authed, chat-capable engine — so it genuinely is a ready
  // outcome, not a contradiction with its own recommendation `detail` text.
  return recommendation.code === 'configured-chat-ready' ||
    recommendation.code === 'runtime-only'
    ? 'ready'
    : 'action_required';
}

function recordOnboardingRecommendation(input: {
  recommendation: SystemRecommendation;
  source: 'system-status' | 'system-status-e2e';
}) {
  onboardingRecommendations.add(1, {
    source: input.source,
    code: input.recommendation.code,
    outcome: recommendationOutcome(input.recommendation),
    missing_kind: input.recommendation.type,
  });
}

export function createSystemStatusRoutes(deps: SystemStatusDeps) {
  const app = new Hono();
  const discoveryCache = createStatusDiscoveryCache(deps);
  app.get('/boot-history', async (c) =>
    c.json(
      (await deps.getBootHistory?.()) ?? {
        records: [],
        currentUptimeSeconds: 0,
      },
    ),
  );

  // archive#1985: an authenticated, additive self-report of this Station
  // instance's build/port identity. Fail-OPEN (unlike `/identity`'s
  // fail-closed triple below): every field is independently omitted when
  // unavailable, mirroring `readBuildProvenance`'s own "absence degrades;
  // it does not fabricate" doctrine — always returns 200 with at least
  // `component`, never a 503 or a thrown error.
  app.get('/instance', (c) => {
    const build = readBuildProvenance();
    systemOps.add(1, { op: 'get_instance' });
    return c.json({
      component: 'command-station' as const,
      // Deliberately no home path here. A desktop host proves same-home
      // ownership structurally: it reads `<STATION_HOME>/instances.json` from
      // the home it resolved, so every candidate it finds is already scoped to
      // that home. What the probe must still establish is that the process
      // answering this port is the entry it read — which `instance` below
      // provides. Publishing the resolved home on this fail-open, unauthenticated
      // route would leak the OS username and directory layout to anything that
      // can reach loopback, and a raw string compare of it would also diverge
      // on a trailing separator or symlink.
      ...(build?.instanceId ? { instance: build.instanceId } : {}),
      ...(deps.port !== undefined ? { port: deps.port } : {}),
      ...(build?.fullSha ? { buildSha: build.fullSha } : {}),
      ...(build?.shaSource ? { shaSource: build.shaSource } : {}),
      ...(build?.builtAt ? { builtAt: build.builtAt } : {}),
      ...(build?.channel ? { channel: build.channel } : {}),
      ...(typeof build?.dirty === 'boolean' ? { dirty: build.dirty } : {}),
      // archive#3677 review MED 4: the runtime's own consent-listener
      // availability — what the CLI start report must derive its consent
      // line from, instead of a TCP probe an unrelated process can satisfy.
      ...(deps.getConsentAvailability
        ? { consent: deps.getConsentAvailability() }
        : {}),
    });
  });

  app.get('/identity', (c) => {
    const build = readBuildProvenance();
    systemOps.add(1, { op: 'get_identity' });
    // Identity stays fail-closed even though `readBuildProvenance` is now
    // partial (archive#1085): remote probes (openssh-worker-probe) treat this
    // triple as proof of *which* Station answered, so a partial answer is not
    // an identity and must not be served as one.
    if (!build?.fullSha || !build.instanceId || !build.bootId) {
      return c.json({ ready: false, status: 'identity_unavailable' }, 503);
    }
    return c.json({
      instanceId: build.instanceId,
      sha: build.fullSha,
      // Names what computed `sha`: a checkout-derived value must not read
      // as the build's identity on the probe surface either.
      ...(build.shaSource ? { shaSource: build.shaSource } : {}),
      bootId: build.bootId,
    });
  });

  app.get('/status', async (c) => {
    // archive#3843 §1: derived once, from the locality the auth boundary
    // bound for THIS request, and spread into every branch below so the
    // deterministic E2E payload cannot answer a different device class from
    // the real one.
    const devicePresentation = resolveDevicePresentation(c.req.raw);
    const e2eReady = process.env.STATION_E2E_SYSTEM_STATUS_READY === '1';
    const e2eFirstRun = process.env.STATION_E2E_FIRST_RUN === '1';
    const build = e2eReady ? E2E_BUILD_PROVENANCE : readBuildProvenance();
    if (e2eReady) {
      systemOps.add(1, { op: 'get_status' });
      recordOnboardingRecommendation({
        source: 'system-status-e2e',
        recommendation: {
          code: 'configured-chat-ready',
          type: 'providers',
          actionLabel: 'Review model connections',
          title: 'A chat-capable model connection is already configured',
          detail:
            'E2E runs use a deterministic chat-ready status so browser coverage is independent of local CLI discovery.',
        },
      });
      return c.json({
        prerequisites: [],
        prerequisitesState: 'ready',
        acp: {
          connected: false,
          connections: [],
        },
        providers: {
          configuredChatReady: true,
          configured: [
            {
              id: 'e2e-model',
              type: 'codex',
              enabled: true,
              capabilities: ['llm'],
            },
          ],
          detected: {
            ollama: false,
            bedrock: false,
          },
        },
        clis: {
          'kiro-cli': false,
          codex: false,
          claude: false,
        },
        developerServices: [],
        capabilities: {
          chat: {
            ready: true,
            source: 'codex',
          },
          runtime: {
            ready: true,
            source: 'codex',
          },
          knowledge: {
            ready: false,
            source: null,
          },
          acp: {
            ready: false,
            source: null,
          },
        },
        recommendation: {
          code: 'configured-chat-ready',
          type: 'providers',
          actionLabel: 'Review model connections',
          title: 'A chat-capable model connection is already configured',
          detail:
            'E2E runs use a deterministic chat-ready status so browser coverage is independent of local CLI discovery.',
        },
        ...(build ? { build } : {}),
        devicePresentation,
        ready: true,
      });
    }

    // A dedicated first-run browser proof uses the real status route and real
    // persisted connections, but discovery must not vary with whatever CLIs,
    // AWS credentials, or Ollama daemon happen to exist on the test host.
    // Unlike STATION_E2E_SYSTEM_STATUS_READY, this starts honestly empty and
    // becomes ready only after the test creates a real model connection.
    const discovery = e2eFirstRun
      ? {
          snapshot: PENDING_DISCOVERY_SNAPSHOT,
          state: 'ready' as const,
        }
      : discoveryCache.read();
    const {
      credentialsFound,
      kiroCliInstalled,
      ollamaReachable,
      codexInstalled,
      claudeInstalled,
      externalEngineReadiness,
      prerequisites,
      developerServices,
    } = discovery.snapshot;
    systemOps.add(1, { op: 'get_status' });
    systemOps.add(1, {
      op: `get_status_prerequisites_${discovery.state}`,
    });

    const acpStatus = deps.getACPStatus();
    const configuredProviders = normalizeConfiguredProviders(
      deps.listProviderConnections?.() ?? [],
    );
    const configuredLlmProviders = configuredProviders.filter(
      (provider) => provider.enabled && provider.capabilities.includes('llm'),
    );
    // Review H1: `isManagedChatReady` answers "is the default agent
    // registered", which is an optimistic proxy that no provider refusal can
    // reach. A recorded refusal is a live observation of the connection
    // Station's managed engine would actually use, so it outranks the proxy
    // for the connections it names. With no LLM connection configured at all
    // there is nothing to refute, and the proxy stands unchanged.
    //
    // Delta review H2: WHICH connection is the point. Selection honours the
    // agent's explicit binding and then `defaultLLMProvider`, so "some other
    // enabled connection is fine" is not an answer about the binding.
    //
    // Delta2 review H2: and a resolver that answers `ambiguous` or `invalid`
    // is not a resolver with no opinion. In those states the default agent
    // resolves to NOTHING — `resolveManagedProviderConnection` throws — so
    // reporting managed chat ready "through" an unrefused sibling described a
    // connection the agent could never reach. Only an ABSENT resolver (an
    // older route host) falls back to the existential question.
    const binding = deps.resolveManagedChatBinding?.();
    const boundConnectionId =
      binding?.kind === 'resolved' ? binding.connectionId : null;
    const boundLlmProvider = boundConnectionId
      ? configuredLlmProviders.find(
          (provider) => provider.id === boundConnectionId,
        )
      : undefined;
    const usableLlmProviders = configuredLlmProviders.filter(
      (provider) => !provider.checkGated,
    );
    const anyUsableLlmProvider =
      configuredLlmProviders.length === 0 || usableLlmProviders.length > 0;
    const managedChatBindingUsable =
      binding === undefined
        ? anyUsableLlmProvider
        : binding.kind === 'resolved'
          ? boundLlmProvider !== undefined && !boundLlmProvider.checkGated
          : binding.kind === 'none'
            ? anyUsableLlmProvider
            : false;
    const managedChatReady =
      (deps.isManagedChatReady?.() ?? configuredLlmProviders.length > 0) &&
      managedChatBindingUsable;
    // #1244: a probe that itself throws is a degraded terminal with the
    // throw as its reason, never a fabricated "ready".
    const terminalCapability = deps.probeTerminalCapability
      ? await deps.probeTerminalCapability().catch(
          (error): TerminalCapability => ({
            state: 'unavailable',
            reason: terminalPtyUnavailableReason(
              describeTerminalPtyLoadFailure(error),
            ),
          }),
        )
      : undefined;
    const capabilities = buildCapabilityStates({
      credentialsFound,
      ollamaReachable,
      externalEngineReady: externalEngineReadiness.ready,
      externalEngineSource: externalEngineReadiness.source,
      acpConnected: acpStatus.connected,
      configuredProviders,
      managedChatReady,
      binding,
      terminalCapability,
    });
    const recommendation = buildSystemRecommendation({
      configuredProviders,
      credentialsFound,
      ollamaReachable,
      externalEngineReady: externalEngineReadiness.ready,
      acpConnected: acpStatus.connected,
      managedChatReady,
      binding,
    });
    recordOnboardingRecommendation({
      recommendation,
      source: 'system-status',
    });
    return c.json({
      prerequisites,
      prerequisitesState: discovery.state,
      acp: {
        connected: acpStatus.connected,
        connections: acpStatus.connections,
      },
      providers: {
        configuredChatReady: managedChatReady,
        configured: configuredProviders.map((provider) => ({
          id: provider.id,
          type: provider.type,
          enabled: provider.enabled,
          capabilities: provider.capabilities ?? [],
        })),
        detected: {
          ollama: ollamaReachable,
          bedrock: credentialsFound,
        },
      },
      clis: {
        'kiro-cli': kiroCliInstalled,
        codex: codexInstalled,
        claude: claudeInstalled,
      },
      developerServices,
      externalEngines: externalEngineReadiness.engines,
      capabilities,
      recommendation,
      // The instance's own endpoint identity (archive#2551): operators and deploy
      // tooling matching a build to an endpoint need it in-band, not from
      // launchd args. Included only as far as the route host supplies it.
      ...(deps.host !== undefined ||
      deps.port !== undefined ||
      deps.publicOrigins?.length
        ? {
            server: {
              ...(deps.host !== undefined ? { host: deps.host } : {}),
              ...(deps.port !== undefined ? { port: deps.port } : {}),
              ...(deps.publicOrigins?.length
                ? { publicOrigins: deps.publicOrigins }
                : {}),
            },
          }
        : {}),
      ...(build ? { build } : {}),
      devicePresentation,
      ready:
        credentialsFound ||
        ollamaReachable ||
        managedChatReady ||
        acpStatus.connected ||
        externalEngineReadiness.ready,
    });
  });

  app.get('/capabilities', (c) => {
    systemOps.add(1, { op: 'get_capabilities' });
    const appConfig = deps.getAppConfig();
    return c.json({
      runtime: appConfig.runtime || 'voltagent',
      voice: {
        stt: [
          {
            id: 'webspeech',
            name: 'WebSpeech (Browser)',
            clientOnly: true,
            visibleOn: ['all'],
            configured: true,
          },
        ],
        tts: [
          {
            id: 'webspeech',
            name: 'WebSpeech (Browser)',
            clientOnly: true,
            visibleOn: ['all'],
            configured: true,
          },
        ],
      },
      context: {
        providers: [
          {
            id: 'geolocation',
            name: 'Geolocation',
            visibleOn: ['mobile'],
          },
          {
            id: 'timezone',
            name: 'Timezone',
            visibleOn: ['all'],
          },
        ],
      },
      scheduler: true,
      // Newer clients may consume these per-deployment facts. Keeping the
      // namespace optional on the SDK contract lets older servers and clients
      // coexist without treating an absent field as support.
      deployment:
        deps.getDeploymentCapabilities?.() ?? resolveDeploymentCapabilities(),
    });
  });

  app.use('/discover', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    return next();
  });

  app.get('/discover', (c) => {
    const reqUrl = new URL(c.req.url);
    return c.json({
      station: true,
      name: 'Project Station',
      port: Number(reqUrl.port) || DEFAULT_SERVER_PORT,
    });
  });

  app.get('/runtime', (c) => {
    const cfg = deps.appConfig ?? deps.getAppConfig();
    return c.json({ runtime: cfg.runtime || 'voltagent' });
  });

  app.get('/skills', (c) => {
    return c.json({
      success: true,
      data: deps.skillService?.listSkills() ?? [],
    });
  });

  app.get('/terminal-port', (c) => {
    const port = deps.port ?? 0;
    return c.json({ success: true, port: port + 1 });
  });

  // Mirrors `/terminal-port` exactly: the Voice WebSocket server binds at
  // `serverPort + 2` (`src-server/runtime/bootstrap/runtime-initialize.ts`), a
  // dedicated raw `ws` port distinct from `deps.port` (the main API port,
  // whose value can differ from the *client's* resolved `apiBase` port —
  // e.g. the UI's own same-origin default). Same-origin `apiBase` clients
  // (see `voiceWsUrl.ts`/`useVoiceSession.ts`) query this route instead of
  // deriving the voice port by arithmetic on `apiBase`, exactly like
  // `TerminalPanel.tsx` already does via `fetchTerminalPort`.
  app.get('/voice-port', (c) => {
    const port = deps.port ?? 0;
    return c.json({ success: true, port: port + 2 });
  });

  return app;
}
