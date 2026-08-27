import { createHash } from 'node:crypto';
import type { AppConfig } from '@kontourai/station-contracts/config';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { DEFAULT_OLLAMA_BASE_URL } from '../../constants.js';
import type { IStorageAdapter } from '../../domain/storage-adapter.js';
import { createLLMProvider } from '../../providers/connection-factories.js';
import { resolveExactModelSelector } from '../../providers/llm/model-catalog.js';
import type { ILLMProvider } from '../../providers/llm/model-provider-types.js';
import { providerOps } from '../../telemetry/metrics.js';
import { LaunchabilityRevision } from './launchability-revision.js';

const INVALID_PROVIDER_FINGERPRINT = 'station:invalid-provider-config';

function providerFingerprint(serialized: string): string {
  return createHash('sha256').update(serialized).digest('hex');
}

export interface ProviderLaunchabilitySnapshot {
  revision: number;
  connections: ProviderConnectionConfig[];
}

/**
 * Types whose "identity" is meaningfully a host:port endpoint rather than an
 * opaque credential blob. Ollama is the only one wired up today (#191 R5) —
 * Bedrock is a plausible future candidate (region + profile identity) but is
 * deliberately not implemented here; the issue scoped this to Ollama only.
 */
const HOST_IDENTIFIED_PROVIDER_TYPES: Record<string, string> = {
  ollama: DEFAULT_OLLAMA_BASE_URL,
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Human-readable label derived generically from a provider `type` string
 * (e.g. `'ollama'` -> `'Ollama'`), used in dedup-conflict messaging (#191
 * code-review M2). Must not hardcode any single provider name: this is what
 * `HOST_IDENTIFIED_PROVIDER_TYPES` above is explicitly designed to grow
 * beyond Ollama, and a hardcoded message would go stale for the next type
 * added there.
 */
export function providerTypeLabel(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export class ProviderService {
  private readonly launchabilityRevision = new LaunchabilityRevision();
  private providerConnectionsFingerprint: string | undefined;

  constructor(
    private storageAdapter: IStorageAdapter,
    private getAppConfig: () => Promise<AppConfig>,
  ) {}

  listProviderConnections(): ProviderConnectionConfig[] {
    return this.storageAdapter.listProviderConnections();
  }

  async saveProviderConnection(
    config: ProviderConnectionConfig,
  ): Promise<void> {
    this.synchronizeProviderConnectionsFingerprint();
    await this.storageAdapter.saveProviderConnection(config);
    this.providerConnectionsFingerprint = this.currentProviderFingerprint();
    this.launchabilityRevision.commit();
    providerOps.add(1, { op: 'register', type: config.type });
  }

  getLaunchabilityRevision(): number {
    this.synchronizeProviderConnectionsFingerprint();
    return this.launchabilityRevision.getLaunchabilityRevision();
  }

  captureLaunchabilitySnapshot(): ProviderLaunchabilitySnapshot {
    let serialized: string;
    try {
      serialized = JSON.stringify(
        this.storageAdapter.listProviderConnections(),
      );
    } catch (error) {
      this.recordInvalidProviderFingerprint();
      throw error;
    }
    this.synchronizeProviderFingerprint(providerFingerprint(serialized));
    return {
      revision: this.launchabilityRevision.getLaunchabilityRevision(),
      connections: JSON.parse(serialized) as ProviderConnectionConfig[],
    };
  }

  private currentProviderFingerprint(): string {
    return providerFingerprint(
      JSON.stringify(this.storageAdapter.listProviderConnections()),
    );
  }

  private synchronizeProviderConnectionsFingerprint(): void {
    let fingerprint: string;
    try {
      fingerprint = this.currentProviderFingerprint();
    } catch (error) {
      this.recordInvalidProviderFingerprint();
      throw error;
    }
    this.synchronizeProviderFingerprint(fingerprint);
  }

  private recordInvalidProviderFingerprint(): void {
    if (this.providerConnectionsFingerprint !== INVALID_PROVIDER_FINGERPRINT) {
      this.providerConnectionsFingerprint = INVALID_PROVIDER_FINGERPRINT;
      this.launchabilityRevision.commit();
    }
  }

  private synchronizeProviderFingerprint(fingerprint: string): void {
    if (this.providerConnectionsFingerprint === undefined) {
      this.providerConnectionsFingerprint = fingerprint;
      return;
    }
    if (this.providerConnectionsFingerprint === fingerprint) return;
    this.providerConnectionsFingerprint = fingerprint;
    this.launchabilityRevision.commit();
  }

  onLaunchabilityChange(listener: (revision: number) => void): () => void {
    return this.launchabilityRevision.onLaunchabilityChange(listener);
  }

  /**
   * Identity-based duplicate check used only on create: for host-identified
   * provider types (Ollama today), a second enabled connection pointing at
   * the same normalized `baseUrl` is considered the same connection. Returns
   * the existing conflicting connection, or `undefined` when there is no
   * conflict. PUT/update is never checked — a connection is allowed to keep
   * its own identity when edited.
   */
  findDuplicateConnection(
    type: string,
    config: Record<string, unknown>,
  ): ProviderConnectionConfig | undefined {
    const defaultBaseUrl = HOST_IDENTIFIED_PROVIDER_TYPES[type];
    if (defaultBaseUrl === undefined) {
      return undefined;
    }

    const rawBaseUrl =
      typeof config.baseUrl === 'string' && config.baseUrl.trim()
        ? config.baseUrl
        : defaultBaseUrl;
    const candidateBaseUrl = normalizeBaseUrl(rawBaseUrl);

    return this.storageAdapter.listProviderConnections().find((connection) => {
      if (connection.type !== type || !connection.enabled) {
        return false;
      }
      const existingRawBaseUrl =
        typeof connection.config?.baseUrl === 'string' &&
        connection.config.baseUrl.trim()
          ? connection.config.baseUrl
          : defaultBaseUrl;
      return normalizeBaseUrl(existingRawBaseUrl) === candidateBaseUrl;
    });
  }

  async deleteProviderConnection(id: string): Promise<void> {
    this.synchronizeProviderConnectionsFingerprint();
    const existing = this.storageAdapter
      .listProviderConnections()
      .find((c) => c.id === id);
    await this.storageAdapter.deleteProviderConnection(id);
    this.providerConnectionsFingerprint = this.currentProviderFingerprint();
    this.launchabilityRevision.commit();
    providerOps.add(1, { op: 'remove', type: existing?.type ?? 'unknown' });
  }

  async checkHealth(
    provider: ILLMProvider,
    _providerType: string,
  ): Promise<boolean> {
    const healthy = (await provider.healthCheck?.()) ?? false;
    providerOps.add(1, {
      op: 'health',
      status: healthy ? 'healthy' : 'unhealthy',
    });
    return healthy;
  }

  async resolveProvider(opts: {
    conversationProviderId?: string;
    conversationModel?: string;
    projectSlug?: string;
    /**
     * station#1288: a lone `conversationModel` (no `conversationProviderId`)
     * is normally a rejected partial override (see the pairing guard just
     * below) — that guard exists for the EXPLICIT-override caller, where a
     * model with no named connection is ambiguous. The managed-chat relay
     * (`chat-request-preparation.ts`'s `providerManagedFallback` branch,
     * itself forwarded by `station-agent-adapter.ts`'s `sendTurn`) has a
     * different shape: it always has a model override (the agent's
     * configured model) but frequently no explicit provider connection to
     * name, because neither `ProviderSessionStartInput` nor
     * `ProviderSendTurnInput` (packages/contracts/src/provider.ts) carries
     * one. Setting this flag lets that ONE caller apply its model override
     * against the same default connection the no-override path below would
     * pick (project default -> app default -> sole enabled LLM connection)
     * instead of hard-failing. Every other caller omits this and keeps the
     * strict pairing contract pinned by `resolveProvider rejects partial
     * conversation overrides`.
     */
    allowModelOnlyFallback?: boolean;
  }): Promise<{ providerId: string; model: string }> {
    const conversationProviderId = opts.conversationProviderId?.trim() ?? '';
    const conversationModel = opts.conversationModel?.trim() ?? '';
    const modelOnlyFallback =
      Boolean(opts.allowModelOnlyFallback) &&
      !conversationProviderId &&
      Boolean(conversationModel);

    if (
      !modelOnlyFallback &&
      Boolean(conversationProviderId) !== Boolean(conversationModel)
    ) {
      throw new Error(
        'Conversation provider and model overrides must be supplied together.',
      );
    }

    if (modelOnlyFallback) {
      const providerId = await this.resolveDefaultProviderId(opts.projectSlug);
      if (!providerId) {
        throw new Error(
          `An application default LLM provider must be configured to apply the model override '${conversationModel}'.`,
        );
      }
      try {
        const model = await this.resolveModelForProvider(
          providerId,
          conversationModel,
        );
        return { providerId, model };
      } catch {
        const connection = this.storageAdapter
          .listProviderConnections()
          .find((c) => c.id === providerId);
        const label = connection?.name?.trim() || providerId;
        throw new Error(
          `Model '${conversationModel}' is not available on provider connection '${label}'. Choose a model available on that connection.`,
        );
      }
    }

    if (conversationProviderId && conversationModel) {
      return {
        providerId: conversationProviderId,
        model: await this.resolveModelForProvider(
          conversationProviderId,
          conversationModel,
        ),
      };
    }

    if (opts.projectSlug) {
      let project: Awaited<ReturnType<IStorageAdapter['getProject']>> | null =
        null;
      try {
        project = await this.storageAdapter.getProject(opts.projectSlug);
      } catch (e) {
        console.debug(
          'Failed to get project provider config:',
          opts.projectSlug,
          e,
        );
      }
      if (project?.defaultProviderId && project.defaultModel) {
        const providerId = project.defaultProviderId.trim();
        return {
          providerId,
          model: await this.resolveModelForProvider(
            providerId,
            project.defaultModel,
          ),
        };
      }
    }

    const appConfig = await this.getAppConfig();
    let fallbackProviderId = appConfig.defaultLLMProvider?.trim() ?? '';
    if (!fallbackProviderId) {
      const enabledProviders = this.storageAdapter
        .listProviderConnections()
        .filter(
          (connection) =>
            connection.enabled && connection.capabilities.includes('llm'),
        );
      if (enabledProviders.length === 1) {
        fallbackProviderId = enabledProviders[0]!.id;
      } else if (enabledProviders.length > 1) {
        throw new Error(
          'Multiple enabled LLM provider connections require an application default.',
        );
      }
    }
    const fallbackConnection = this.storageAdapter
      .listProviderConnections()
      .find((connection) => connection.id === fallbackProviderId);
    const connectionDefaultModel =
      typeof fallbackConnection?.config?.defaultModel === 'string'
        ? fallbackConnection.config.defaultModel.trim()
        : '';
    const fallbackModel =
      appConfig.defaultModel?.trim() || connectionDefaultModel;
    if (!fallbackProviderId || !fallbackModel) {
      throw new Error(
        'An application default LLM provider and model must be configured.',
      );
    }
    return {
      providerId: fallbackProviderId,
      model: await this.resolveModelForProvider(
        fallbackProviderId,
        fallbackModel,
      ),
    };
  }

  /**
   * station#1288: the connection-selection half of the no-override cascade
   * in `resolveProvider` above (project default -> app default -> sole
   * enabled LLM connection). The APP-DEFAULT and SOLE-CONNECTION legs are
   * deliberately decoupled from that cascade's requirement that a default
   * MODEL also be configured there — the `modelOnlyFallback` caller always
   * supplies its own model override and only needs a connection to apply it
   * against. Mirrors the "multiple enabled providers require an
   * application default" ambiguity guard so a model-only fallback fails
   * with the same actionable message as the no-override path would.
   *
   * The PROJECT leg is the one exception: it requires BOTH
   * `project.defaultProviderId` AND `project.defaultModel`, exactly
   * matching the sibling cascade's `if (project?.defaultProviderId &&
   * project.defaultModel)` check above. A project with a provider id but no
   * default model is what today's UI never produces, but is reachable via a
   * hand-edited config — without this parity, that project would resolve a
   * DIFFERENT connection depending on whether a model override happened to
   * be present, which is the exact kind of divergence this helper exists to
   * avoid (round-2 review finding).
   */
  private async resolveDefaultProviderId(
    projectSlug?: string,
  ): Promise<string | undefined> {
    if (projectSlug) {
      let project: Awaited<ReturnType<IStorageAdapter['getProject']>> | null =
        null;
      try {
        project = await this.storageAdapter.getProject(projectSlug);
      } catch (e) {
        console.debug('Failed to get project provider config:', projectSlug, e);
      }
      if (project?.defaultProviderId && project.defaultModel) {
        return project.defaultProviderId.trim();
      }
    }

    const appConfig = await this.getAppConfig();
    const configuredProviderId = appConfig.defaultLLMProvider?.trim() ?? '';
    if (configuredProviderId) {
      return configuredProviderId;
    }

    const enabledProviders = this.storageAdapter
      .listProviderConnections()
      .filter(
        (connection) =>
          connection.enabled && connection.capabilities.includes('llm'),
      );
    if (enabledProviders.length === 1) {
      return enabledProviders[0]!.id;
    }
    if (enabledProviders.length > 1) {
      throw new Error(
        'Multiple enabled LLM provider connections require an application default.',
      );
    }
    return undefined;
  }

  async resolveModelForProvider(
    providerId: string,
    requestedModel: string,
  ): Promise<string> {
    const providerConnection = this.storageAdapter
      .listProviderConnections()
      .find(
        (connection) =>
          connection.id === providerId &&
          connection.enabled &&
          connection.capabilities.includes('llm'),
      );

    if (!providerConnection) {
      throw new Error(
        `LLM provider connection '${providerId}' is unavailable.`,
      );
    }

    const configuredModel =
      typeof providerConnection.config?.defaultModel === 'string'
        ? providerConnection.config.defaultModel.trim()
        : '';

    const provider = createLLMProvider(providerConnection);
    if (!provider) {
      throw new Error(
        `No LLM implementation is registered for provider '${providerConnection.type}'.`,
      );
    }
    return resolveExactModelSelector(
      provider,
      requestedModel,
      configuredModel ? [{ id: configuredModel, name: configuredModel }] : [],
    );
  }
}
