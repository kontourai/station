import type { AgentCapabilities, ProviderInfo } from '@agentclientprotocol/sdk';
import {
  type ACPConnectionConfig,
  type ACPLlmProtocol,
  type ACPProviderInfo,
  ACPStatus,
  type ACPStatusValue,
} from '@kontourai/station-contracts/acp';

/** archive#895 wave B: per-connection session-surface evidence projected from a
 * live ACP `initialize` handshake.
 *
 * archive#1549 AMENDS archive#895's "evidence only, never gates" note
 * (agent-engine-unification.md §4.1b). It stays literally true of the
 * SESSION-DELIVERY map, which is still static per matrix
 * (`sessionDeliveryChannels`). It is no longer true of the BINDING/PICKER
 * layer: `mcpCapabilities.http` is now the evidence half of
 * `engineControlPlaneCapability`'s derivation for any cell whose mechanism
 * declares `basis: 'runtime_observation'`. Naming the reversal here rather
 * than letting a half-reversal go unwritten — that is exactly how
 * "intentionally stdio-only" became a wording artifact (archive#1379). */
export interface ACPConnectionCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  promptCapabilities?: {
    image?: boolean;
    audio?: boolean;
    embeddedContext?: boolean;
  };
  sessionCapabilities?: { resume?: unknown };
  /** True only when initialize explicitly advertised the unstable capability. */
  providers?: boolean;
}

function projectAgentCapabilities(
  capabilities: AgentCapabilities | null | undefined,
): ACPConnectionCapabilities | undefined {
  if (!capabilities) return undefined;
  return {
    loadSession: capabilities.loadSession,
    mcpCapabilities: capabilities.mcpCapabilities
      ? {
          http: capabilities.mcpCapabilities.http,
          sse: capabilities.mcpCapabilities.sse,
        }
      : undefined,
    promptCapabilities: capabilities.promptCapabilities
      ? {
          image: capabilities.promptCapabilities.image,
          audio: capabilities.promptCapabilities.audio,
          embeddedContext: capabilities.promptCapabilities.embeddedContext,
        }
      : undefined,
    sessionCapabilities: capabilities.sessionCapabilities
      ? { resume: (capabilities.sessionCapabilities as any).resume }
      : undefined,
    providers: capabilities.providers != null,
  };
}

function projectProviderInfo(providers: ProviderInfo[]): ACPProviderInfo[] {
  const protocol = (value: string): ACPLlmProtocol =>
    value === 'anthropic' ||
    value === 'openai' ||
    value === 'azure' ||
    value === 'vertex' ||
    value === 'bedrock'
      ? value
      : 'other';
  return providers.map((provider) => ({
    providerId: provider.providerId,
    supported: provider.supported.map(protocol),
    required: provider.required,
    current: provider.current
      ? {
          apiType: protocol(provider.current.apiType),
          baseUrl: provider.current.baseUrl,
        }
      : null,
  }));
}

interface ACPModeLike {
  id: string;
  name?: string;
  description?: string;
}

interface ACPProbeLike {
  getModes(): ACPModeLike[];
  getConfigOptions(): Array<{
    category?: string;
    currentValue?: string;
    options?: Array<{ name?: string; value?: string }>;
  }>;
  getCapabilities(): { image?: boolean } | undefined;
  /** archive#895 wave B: the full initialize agentCapabilities handshake — evidence only. */
  getAgentCapabilities?(): AgentCapabilities | null | undefined;
  getProviderRouting?(): ProviderInfo[] | null;
  /** archive#1549: epoch ms of the last SUCCESSFUL initialize handshake; `0`/absent when none ever succeeded. */
  getHandshakeObservedAt?(): number;
  isAvailable(): boolean;
  /**
   * archive#3404: whether a probe run is currently in flight. Used so a
   * connection whose first handshake is still outstanding reports PROBING,
   * not UNAVAILABLE — see the status derivation below.
   */
  isProbeInFlight?(): boolean;
  lastProbeAt: number;
  /** Why the most recent probe failed; `null`/absent when the last probe succeeded or never ran. */
  lastError?: { message: string; phase: string } | null;
}

export function getACPManagerStatus(
  probes: Map<string, ACPProbeLike>,
  configs: Map<string, ACPConnectionConfig>,
  activeSessions: number,
): {
  connections: Array<{
    id: string;
    name: string;
    icon?: string;
    status: ACPStatusValue;
    modes: string[];
    sessionId: null;
    mcpServers: string[];
    configOptions: any[];
    currentModel: string | null;
    capabilities?: ACPConnectionCapabilities;
    /** Present only when providers/list actually ran; [] is observed negative evidence. */
    providerRouting?: ACPProviderInfo[];
    /**
     * archive#1549: ISO-8601 instant of the last SUCCESSFUL `initialize`
     * handshake. Emitted whenever one has happened — INCLUDING a handshake
     * that carried no `agentCapabilities` at all, which is a real observation
     * whose answer is "this agent advertised nothing", not an absence of
     * evidence. Deliberately not `lastProbeAt`: a failed probe retains the
     * previous cache and would otherwise re-date it.
     */
    handshakeObservedAt?: string;
    /**
     * Why the connection is unavailable, from the probe's most recent
     * failure. Absent whenever the connection is available or no probe has
     * failed.
     */
    lastError?: { message: string; phase: string };
  }>;
  activeSessions: number;
} {
  return {
    connections: Array.from(probes.entries()).map(([id, probe]) => {
      const config = configs.get(id);
      const configOptions = probe.getConfigOptions();
      const modelConfig = configOptions.find(
        (option) => option.category === 'model',
      );

      const capabilities = projectAgentCapabilities(
        probe.getAgentCapabilities?.(),
      );
      const observedAt = probe.getHandshakeObservedAt?.() ?? 0;
      const providerRouting = probe.getProviderRouting?.() ?? null;

      // archive#3404: a connection that has NEVER completed a successful
      // handshake while a probe is in flight is still being met for the
      // first time — report PROBING, not UNAVAILABLE. This is what makes a
      // slow-starting engine (cold initialize can legitimately take 40s+)
      // distinguishable from a broken one: without it, the first cold probe
      // times out, stamps `lastProbeAt`, and every later in-flight re-probe
      // reads UNAVAILABLE until one happens to succeed. A connection that
      // HAS handshaked before keeps its previous classification while a
      // warm re-probe runs — and keeps it however many times it fails
      // afterwards, because `lastHandshakeObservedAt` is monotonic
      // (acp-probe.ts). It used to be reset after two consecutive failures,
      // which put a permanently-broken-but-once-known engine back on
      // PROBING for the duration of every sweep.
      const firstHandshakeStillOutstanding =
        observedAt === 0 && (probe.isProbeInFlight?.() ?? false);

      return {
        id,
        name: config?.name || id,
        icon: config?.icon,
        status: probe.isAvailable()
          ? ACPStatus.AVAILABLE
          : firstHandshakeStillOutstanding
            ? ACPStatus.PROBING
            : probe.lastProbeAt > 0
              ? ACPStatus.UNAVAILABLE
              : ACPStatus.PROBING,
        modes: probe.getModes().map((mode) => mode.id),
        sessionId: null,
        mcpServers: [],
        configOptions,
        currentModel: modelConfig?.currentValue || null,
        capabilities,
        providerRouting:
          providerRouting === null
            ? undefined
            : projectProviderInfo(providerRouting),
        handshakeObservedAt:
          observedAt > 0 ? new Date(observedAt).toISOString() : undefined,
        lastError: probe.lastError ?? undefined,
      };
    }),
    activeSessions,
  };
}
