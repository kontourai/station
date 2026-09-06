import type {
  EngineConnectionId,
  EngineId,
} from '@kontourai/station-contracts/agent-identity';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import type { TerminalCapability } from '@kontourai/station-shared/terminal-capability';
import type { DeploymentCapabilities } from '../../capabilities/deployment-capabilities.js';
import type { ManagedChatBinding } from '../../runtime/plugins/runtime-provider-resolution.js';
import type { SkillService } from '../../services/agents/skill-service.js';
import type { RuntimeResourcePostureProbe } from '../../services/infra/resource-posture.js';
import type { BootHistoryRecord } from './boot-history.js';

export interface SystemStatusDeps {
  getBootHistory?: () => Promise<{
    records: BootHistoryRecord[];
    currentUptimeSeconds: number;
  }>;
  getACPStatus: () => {
    connected: boolean;
    connections: Array<{ id: string; status: string }>;
  };
  listProviderConnections?: () => Array<{
    id: string;
    type: string;
    enabled: boolean;
    capabilities?: string[];
    /** See `ConfiguredProvider.checkGated`. */
    checkGated?: boolean;
  }>;
  isManagedChatReady?: () => boolean;
  /**
   * What Station's managed engine would actually select for the default agent
   * — its explicit `modelConnectionId`, else `defaultLLMProvider`, else the
   * sole enabled one — or which kind of unanswerable this configuration is.
   *
   * Delta review H2: readiness must be bound to THAT connection. Asking
   * whether any enabled connection lacks a refusal let a refused binding be
   * reported ready "through" a healthy sibling that is not the binding.
   *
   * Delta2 review H2: `ambiguous` and `invalid` are NOT "no opinion". The
   * agent resolves to nothing in those states, so they must read as not
   * ready — treating them like an absent resolver is what produced a
   * recommendation naming a connection the agent could never reach. Absent
   * (an older route host that supplies no resolver) is the only case that
   * legitimately falls back to the existential question.
   */
  resolveManagedChatBinding?: () => ManagedChatBinding;
  checkOllamaAvailability?: () => Promise<boolean>;
  getAppConfig: () => {
    region?: string;
    defaultModel: string;
    runtime?: string;
  };
  /**
   * Deployment/distribution facts, distinct from Station's static handshake
   * capability registry. Optional so older route hosts continue to work.
   */
  getDeploymentCapabilities?: () => DeploymentCapabilities;
  /**
   * Live engine-connection state, for chat-readiness (archive#1194).
   *
   * Deliberately NOT derived from `getAppConfig`. That returns a boot-time
   * snapshot — `runtime-route-support.ts` binds `() => context.appConfig`, a
   * plain field assigned once at startup, while connection saves reassign
   * `this.appConfig` on the runtime, a different reference. Nothing ever
   * writes `context.appConfig`, so a connection disabled through the running
   * Connections hub is invisible to it (review of archive#1263, round 2).
   *
   * This is wired to `ConnectionService.listEngineConnectionStates()`, which
   * derives from the same runtime inventory `enriched-agents.ts` uses while
   * retaining both its Adapter-private selector and public registry identity.
   * The explicit join makes enabled-state comparisons type-safe instead of
   * depending on two unrelated IDs having the same text.
   */
  listEngineConnectionStates?: () => Promise<
    Array<{
      engineId: EngineId;
      engineConnectionId: EngineConnectionId;
      enabled: boolean;
    }>
  >;
  /** Detected local-command Engine registry entries not yet connected. */
  listDetectedACPRegistryEntries?: () => Promise<
    Array<{ id: string; name: string }>
  >;
  eventBus?: {
    emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
  };
  appConfig?: { runtime?: string };
  port?: number;
  /**
   * archive#3677 review MED 4: the runtime's OWN consent-listener
   * availability, from `ConsentChannelService.state()`. The CLI's start
   * report derives its consent line from this — a TCP probe of the consent
   * port says only that SOMETHING accepted a socket, which reads green while
   * Station has actually failed closed behind an unrelated process. The
   * unavailable `reason` is deliberately not exposed here: `/instance` is a
   * fail-open, unauthenticated self-report.
   */
  getConsentAvailability?: () =>
    | { status: 'listening'; port: number }
    | { status: 'unavailable' };
  /** Bound listen host, so status readers can identify the endpoint (archive#2551). */
  host?: string;
  /** Configured public origins (ALLOWED_ORIGINS), when the host wires them. */
  publicOrigins?: string[];
  skillService?: SkillService;
  /**
   * Product-owned CPU diagnostics probe. Optional so older/partial route
   * composition degrades to a
   * 503 on the read route instead of a fabricated healthy reading.
   */
  resourcePosture?: RuntimeResourcePostureProbe;
  /**
   * The terminal surface's live PTY capability (#1244), wired to
   * `TerminalService.probeCapability()`. Optional so older route hosts keep
   * their existing capability record; when absent, status makes NO terminal
   * claim rather than fabricating readiness.
   */
  probeTerminalCapability?: () => Promise<TerminalCapability>;
}

/**
 * Build provenance as far as the process can establish it. Every field is
 * independently optional (archive#1085) because the packaged desktop shell and
 * a CLI instance started without a build manifest each supply a different
 * subset — reporting nothing at all whenever one input was missing hid the
 * commit sha, which is the field support actually needs. `shortSha` and
 * `ageSeconds` are derived, so they are present exactly when `fullSha` and
 * `builtAt` respectively are.
 */
export type SystemBuildProvenance = {
  fullSha?: string;
  shortSha?: string;
  /** Whether `fullSha` identifies the served bundle or only its checkout. */
  shaSource?: 'build-stamp' | 'checkout';
  branch?: string;
  builtAt?: string;
  ageSeconds?: number;
  instanceId?: string;
  bootId?: string;
  /**
   * `channel` and `dirty` (archive#1985) are ALSO independently optional,
   * same doctrine as every field above. `channel` can come from either the
   * the esbuild-baked stamp or `STATION_CHANNEL` (only when no stamped channel
   * exists). `dirty` has no env
   * var equivalent — it is sourced from the baked fallback only (a
   * `git status --porcelain` snapshot taken at build time).
   */
  channel?: string;
  dirty?: boolean;
};

export type ConfiguredProvider = {
  id: string;
  type: string;
  enabled: boolean;
  capabilities?: string[];
  /**
   * The latest check bound to this connection's current configuration is a
   * readiness-gating fault — the provider refused these settings, or Station
   * could not reach the endpoint and has stopped calling that transient
   * (`ConnectionService.checkGatedModelConnectionIds`).
   *
   * Review H1: without this, chat readiness and the setup recommendation were
   * derived from "an enabled LLM connection exists" / "the default agent is
   * registered", so the hub could recommend a connection as chat-capable
   * directly above its own "Check failed" card. Absent means no fault is
   * on record — which is not the same as a pass, and only the connection's
   * `readinessEvidence.check` distinguishes those.
   */
  checkGated?: boolean;
};

export type CapabilityState = {
  ready: boolean;
  source: string | null;
  /**
   * Present only when `ready` is false and the producer observed a specific,
   * actionable cause — e.g. the terminal capability's node-pty load failure
   * (#1244). Absence means "not ready" with no recorded reason, never "ready".
   */
  reason?: string;
};

export type SystemRecommendation = {
  code:
    | 'configured-chat-ready'
    | 'configured-no-chat'
    | 'detected-provider'
    | 'runtime-only'
    | 'unconfigured';
  type: 'providers' | 'runtimes' | 'connections';
  actionLabel: string;
  title: string;
  detail: string;
  detectedProviderType?: string;
  detectedProviderLabel?: string;
};
