/**
 * MCP Service - handles MCP tool management and connection status
 */

type Tool<_T = any> = any;

import { type SpawnOptions, spawn } from 'node:child_process';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ToolDef, ToolMetadata } from '@kontourai/station-contracts/tool';
import {
  type MCPConnection,
  type MCPLocalClaim,
  type MCPLocalCleanup,
  MCPLocalConnectionCustody,
  MCPLocalCustodyError,
} from '@kontourai/station-shared/mcp';
import { DEFAULT_SERVER_PORT } from '@kontourai/station-shared/ports';
import type { Transport } from '@modelcontextprotocol/client';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ConfigLoader } from '../../domain/config-loader.js';
import { markIntegrationEnabledExplicit } from '../../domain/config-loader-storage.js';
import { isBuiltinStationControl } from '../../runtime/bootstrap/station-control-runtime-env.js';
import {
  extractMCPAppsResourceMetadata,
  extractMCPAppsToolMetadata,
  isMCPAppsToolVisibleTo,
  MCPAppsToolAccessError,
  type MCPAppsUiMetadata,
} from '../../runtime/mcp/mcp-apps-metadata.js';
import { sameMCPConnectionDefinition } from '../../runtime/mcp/mcp-definition-currentness.js';
import {
  toolServerLifecycle,
  toolServerOAuth,
  toolServerProbes,
} from '../../telemetry/metrics.js';
import { establishMcpSecretChild } from '../secrets/mcp-secret-child-env.js';
import type {
  IntegrationSecretBindingGranter,
  IntegrationSecretResolver,
} from '../secrets/secret-binding-administration.js';
import { ToolServerCredentialStore } from './tool-server-credential-store.js';
import {
  captureToolServerOperationFailure,
  classifyOAuthFailure,
  classifyToolServerProbeFailure,
  formatToolServerFailure,
  removeToolServerOAuthCredentials,
  requireHttpAuthorizationUrl,
  requireToolServerResult,
  StationOwnedToolServerError,
  StationToolServerOAuthProvider,
  toolServerOAuthResourceIdentity,
  validateOAuthCallbackUrl,
} from './tool-server-oauth.js';

/** Bound on the names a probe records, so one chatty server cannot bloat its
 *  persisted config file (CI-R15). */
const PROBE_TOOL_NAME_LIMIT = 200;

export interface MCPConnectionStatus {
  connected: boolean;
  error?: string;
}

export interface IntegrationMetadata {
  type: string;
  transport?: string;
  toolCount?: number;
}

export interface ToolInfo {
  id: string;
  name: string;
  originalName: string;
  server: string | null;
  serverId?: string;
  toolName: string;
  description?: string;
  parameters?: any;
  _meta?: Record<string, unknown>;
  ui?: { resourceUri: string };
  resource?: { uri: string };
}

export class MCPServerDisabledError extends StationOwnedToolServerError {}
export class MCPToolDisabledError extends StationOwnedToolServerError {}

/** The raw legacy credential remains authoritative until a fresh bound child
 * has connected; callers can render this outcome without exposing a cause. */
export class StoredEnvMigrationError extends StationOwnedToolServerError {
  constructor() {
    super(
      'Stored environment migration did not complete; retry the migration before removing its bindings.',
    );
  }
}

export type MCPUIToolCatalogResult =
  | { available: true; tools: unknown[] }
  | { available: false };

export class MCPService {
  private readonly oauthFlows = new Map<
    string,
    {
      provider: StationToolServerOAuthProvider;
      resourceIdentity: string;
      claim: MCPLocalClaim;
    }
  >();
  constructor(
    private configLoader: ConfigLoader,
    private mcpConfigs: Map<string, MCPConnection>,
    private mcpConnectionStatus: Map<string, MCPConnectionStatus>,
    private integrationMetadata: Map<string, IntegrationMetadata>,
    private agentTools: Map<string, Tool<any>[]>,
    private toolNameMapping: Map<
      string,
      {
        original: string;
        normalized: string;
        server: string | null;
        tool: string;
      }
    >,
    private logger: any,
    private resetAllRuntimeProjections?: (reset: () => void) => Promise<void>,
    private readonly serverPort: number = DEFAULT_SERVER_PORT,
    private readonly integrationSecretResolver?: IntegrationSecretResolver,
    private readonly integrationSecretBindingGranter?: IntegrationSecretBindingGranter,
    private readonly mcpCustody = new MCPLocalConnectionCustody(),
  ) {}

  private async establishChild<T>(
    def: ToolDef,
    establish: (child: ToolDef) => Promise<T>,
  ): Promise<T> {
    return establishMcpSecretChild(
      {
        integrationId: def.id,
        def,
        resolver: this.integrationSecretResolver,
        isBuiltinStationControl: isBuiltinStationControl(def.id, def),
      },
      async (secrets) => {
        // The shared transport normalizer is also the portability projector
        // and deliberately strips binding-backed env. This short-lived child
        // definition never escapes the establishment callback.
        if (!secrets) return establish(def);
        const child = { ...def, env: { ...def.env, ...secrets } };
        delete child.secretEnvRefs;
        return establish(child);
      },
    );
  }

  private async requireCurrentDefinition(
    claim: MCPLocalClaim,
    expected: ToolDef,
  ): Promise<void> {
    const current = await this.getIntegration(expected.id);
    if (!claim.isCurrent() || !sameMCPConnectionDefinition(expected, current))
      throw new MCPLocalCustodyError('stale');
  }

  inspectLocalConnections() {
    return this.mcpCustody.inspect();
  }

  private async releaseAfterOperation(
    claim: MCPLocalClaim,
    operationFailed: boolean,
  ): Promise<void> {
    const cleanup = await this.mcpCustody.release(claim);
    if (!operationFailed && cleanup.state !== 'settled')
      throw new MCPLocalCustodyError(cleanup.state);
  }

  private async writeMigrationProjection(
    id: string,
    def: ToolDef,
  ): Promise<void> {
    await this.mcpCustody.mutate(id, () =>
      this.configLoader.saveIntegration(id, def),
    );
    this.mcpConfigs.delete(id);
  }

  /**
   * Migrate named legacy credential-store entries only after their already
   * created Datum bindings are granted and a fresh probe has used them. The
   * irreversible step (removing legacy material) is last; any earlier failure
   * leaves the old credential references intact.
   */
  async migrateStoredEnv(input: {
    integrationId: string;
    bindings: Record<string, { bindingId: string; expectedRevision: number }>;
  }): Promise<{ outcome: 'migrated'; migratedEnvNames: string[] }> {
    let current = await this.getIntegration(input.integrationId);
    const names = Object.keys(input.bindings).sort();
    if (
      current.kind !== 'mcp' ||
      (current.transport ?? (current.command ? 'stdio' : undefined)) !==
        'stdio' ||
      !names.length ||
      !this.integrationSecretBindingGranter
    ) {
      throw new StoredEnvMigrationError();
    }
    const legacy = new Set(current.storedEnvNames ?? []);
    if (names.some((name) => !legacy.has(name))) {
      // A failed cleanup can publish the binding-backed projection before its
      // credential-store batch fails. If the compensating publish also fails,
      // the exact binding map is the durable repair authority: restore only
      // those original markers, then re-run the normal all-or-nothing path.
      // Never infer a binding id or accept a mismatched map as recovery.
      if (
        names.every(
          (name) =>
            current.secretEnvRefs?.[name] === input.bindings[name]?.bindingId,
        )
      ) {
        await this.writeMigrationProjection(input.integrationId, {
          ...current,
          storedEnvNames: [
            ...new Set([...(current.storedEnvNames ?? []), ...names]),
          ].sort(),
        });
        current = await this.getIntegration(input.integrationId);
      } else {
        throw new StoredEnvMigrationError();
      }
    }

    const refs = { ...current.secretEnvRefs };
    try {
      for (const envName of names) {
        const binding = input.bindings[envName]!;
        if (
          current.secretEnvRefs?.[envName] !== undefined &&
          current.secretEnvRefs[envName] !== binding.bindingId
        ) {
          throw new StoredEnvMigrationError();
        }
        const existing = await this.integrationSecretBindingGranter.get(
          binding.bindingId,
        );
        if (
          !existing ||
          existing.revokedAt ||
          !existing.grants.some(
            (grant) =>
              grant.integrationId === input.integrationId &&
              grant.envName === envName,
          )
        ) {
          await this.integrationSecretBindingGranter.grant({
            id: binding.bindingId,
            expectedRevision: binding.expectedRevision,
            grant: {
              kind: 'mcp-integration-env',
              integrationId: input.integrationId,
              envName,
            },
          });
        }
        refs[envName] = binding.bindingId;
      }

      // First durable switch: preserve legacy material while the freshly
      // established child proves the new binding is usable.
      await this.writeMigrationProjection(input.integrationId, {
        ...current,
        secretEnvRefs: refs,
      });
      const probe = await this.probeIntegration(input.integrationId);
      // `probeIntegration` records failures as a ToolDef instead of throwing.
      // Migration cleanup is irreversible, so a returned failed probe is just
      // as terminal here as a thrown connection error.
      if (probe.probe?.ok !== true) throw new StoredEnvMigrationError();

      // Only a successful fresh child permits deleting legacy credentials.
      const afterProbe = await this.getIntegration(input.integrationId);
      try {
        await this.writeMigrationProjection(input.integrationId, {
          ...afterProbe,
          secretEnvRefs: refs,
          removeSecretEnvKeys: names,
        });
      } catch {
        // `saveIntegration` publishes the reference projection before it
        // removes legacy credential entries. Re-create the complete original
        // set if any removal fails so a multi-name cleanup is never partially
        // migrated: the old values remain readable and a retry can start from
        // the same storedEnvNames marker. This is deliberately a local
        // compensation rather than silently claiming migration succeeded.
        const legacyValues = Object.fromEntries(
          names
            .map((name) => [name, afterProbe.env?.[name]])
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
        );
        await this.writeMigrationProjection(input.integrationId, {
          ...afterProbe,
          secretEnvRefs: refs,
          secretEnv: legacyValues,
        });
        throw new StoredEnvMigrationError();
      }
      return { outcome: 'migrated', migratedEnvNames: names };
    } catch (error) {
      if (error instanceof StoredEnvMigrationError) throw error;
      throw new StoredEnvMigrationError();
    }
  }

  async listIntegrations(): Promise<ToolMetadata[]> {
    return this.configLoader.listIntegrations();
  }

  async getToolAgentMap(): Promise<Record<string, string[]>> {
    return this.configLoader.getToolAgentMap();
  }

  async saveIntegration(def: ToolDef): Promise<void> {
    let existing: ToolDef | undefined;
    try {
      existing = await this.configLoader.loadIntegration(def.id);
    } catch (error) {
      if (!isMissingIntegrationError(error)) throw error;
    }
    if (
      Object.hasOwn(def, 'secretEnvRefs') &&
      !sameSecretEnvRefs(def.secretEnvRefs, existing?.secretEnvRefs)
    ) {
      throw new Error(
        'Secret bindings can be changed only through the operator binding API.',
      );
    }
    if (
      existing?.secretEnvRefs &&
      Object.keys(existing.secretEnvRefs).length > 0 &&
      changesBoundChildExecutionIdentity(existing, def)
    ) {
      throw new Error(
        'Unbind secret bindings before changing an integration execution configuration.',
      );
    }
    const identityChanged =
      existing !== undefined &&
      toolServerOAuthResourceIdentity(existing) !==
        toolServerOAuthResourceIdentity(def);
    const withPreservedBindings = existing?.secretEnvRefs
      ? { ...def, secretEnvRefs: { ...existing.secretEnvRefs } }
      : def;
    const persisted = identityChanged
      ? withAuthorizationRequired(
          withPreservedBindings,
          'Tool server endpoint changed',
        )
      : withPreservedBindings;
    const write = async () => {
      await this.configLoader.saveIntegration(def.id, persisted);
      if (identityChanged || def.enabled === false) {
        await removeToolServerOAuthCredentials(this.credentialStore(), def.id);
        this.oauthFlows.delete(def.id);
      }
    };
    // Every explicit write to this integration is fenced, even if its first
    // read looked unchanged: another local writer may have committed meanwhile.
    // Other integration identities remain usable; probe health uses its own
    // compare-and-update projection and does not retire the connection.
    await this.mcpCustody.mutate(def.id, write);
    this.mcpConfigs.delete(def.id);
  }

  async getIntegration(id: string): Promise<ToolDef> {
    return this.configLoader.loadIntegration(id);
  }

  async deleteIntegration(id: string): Promise<void> {
    await this.mcpCustody.mutate(id, async () => {
      await this.configLoader.deleteIntegration(id);
      this.oauthFlows.delete(id);
      this.mcpConfigs.delete(id);
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<ToolDef> {
    const existing = await this.getIntegration(id);
    const updated =
      !enabled && toolServerOAuthResourceIdentity(existing)
        ? withAuthorizationRequired(
            { ...existing, enabled },
            'OAuth credentials were cleared when the integration was disabled',
          )
        : { ...existing, enabled };
    markIntegrationEnabledExplicit(updated);
    await this.saveIntegration(updated);
    toolServerLifecycle.add(1, { action: enabled ? 'enable' : 'disable' });
    return updated;
  }

  async startOAuth(
    id: string,
    mode: 'local' | 'remote',
  ): Promise<{
    authorizationUrl: string;
    mode: 'local-browser-opened' | 'remote-manual-open';
    completionInstructions: string;
  }> {
    const claim = this.mcpCustody.acquire(id, 'oauth');
    let retained = false;
    try {
      const def = await this.getIntegration(id);
      if (def.transport !== 'sse' && def.transport !== 'streamable-http')
        throw new Error(
          'OAuth is available only for SSE and streamable HTTP tool servers',
        );
      const provider = this.createOAuthProvider(def);
      let transport: Transport | undefined;
      try {
        const connection = await this.establishChild(def, (child) =>
          claim.connect(child, {
            authProvider: provider,
            onTransport: (value) => {
              transport = value;
            },
          }),
        );
        void connection; // Retired in the outer finally, including partial failure.
        throw new StationOwnedToolServerError(
          'Tool server is already authorized',
        );
      } catch (error) {
        const publicError = captureToolServerOperationFailure(
          error,
          'authorize',
          id,
          this.logger,
        );
        const authorizationUrl = provider.takeAuthorizationUrl();
        await this.requireCurrentDefinition(claim, def);
        if (!authorizationUrl || !transport || !('finishAuth' in transport))
          throw publicError;
        try {
          requireHttpAuthorizationUrl(authorizationUrl);
        } catch (unsafeUrlError) {
          await claim.run(() => provider.clearCredentials());
          throw unsafeUrlError;
        }
        const resourceIdentity = toolServerOAuthResourceIdentity(def);
        if (!resourceIdentity)
          throw new Error('OAuth tool server endpoint is missing or invalid');
        claim.retainForOAuth();
        const previous = this.oauthFlows.get(id);
        if (previous) {
          const cleanup = await this.mcpCustody.release(previous.claim);
          if (cleanup.state !== 'settled')
            throw new MCPLocalCustodyError(cleanup.state);
        }
        this.oauthFlows.set(id, {
          provider,
          resourceIdentity,
          claim,
        });
        await this.saveAuthorizationHealth(
          id,
          resourceIdentity,
          'awaiting-operator-consent',
          undefined,
          claim,
        );
        if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
        retained = true;
        toolServerOAuth.add(1, { outcome: 'authorize-started' });
        if (mode === 'local') openSystemBrowser(authorizationUrl.toString());
        return {
          authorizationUrl: authorizationUrl.toString(),
          mode:
            mode === 'local' ? 'local-browser-opened' : 'remote-manual-open',
          completionInstructions:
            'Complete consent in the browser, copy the full redirected loopback URL from the address bar, and paste it into Station. Station completes OAuth only through the authenticated paste-back action.',
        };
      }
    } finally {
      if (!retained) {
        if (this.oauthFlows.get(id)?.claim === claim)
          this.oauthFlows.delete(id);
        await this.mcpCustody.release(claim);
      }
    }
  }

  async finishOAuth(id: string, callbackUrl: string): Promise<ToolDef> {
    const flow = this.oauthFlows.get(id);
    if (!flow) {
      throw new Error('No OAuth consent flow is awaiting completion');
    }
    let claimed = false;
    let failed = false;
    try {
      return await flow.claim.run(async () => {
        const expectedState = await flow.provider.expectedState();
        if (!expectedState) {
          throw new Error('OAuth flow state is missing or expired');
        }
        const validated = validateOAuthCallbackUrl(
          callbackUrl,
          expectedState,
          String(flow.provider.redirectUrl),
        );
        if (!validated.ok) {
          throw new Error(validated.reason);
        }

        // Validation above proves the state matches. Claim the exact map entry
        // synchronously, before any await, so no second callback can capture this
        // flow and race a health write against the winner.
        if (this.oauthFlows.get(id) !== flow || !this.oauthFlows.delete(id)) {
          throw new Error('No OAuth consent flow is awaiting completion');
        }
        claimed = true;
        if (!flow.claim.isCurrent()) throw new MCPLocalCustodyError('stale');
        await flow.provider.consumeState();
        if (!flow.claim.isCurrent()) throw new MCPLocalCustodyError('stale');

        const beforeExchange = await this.getIntegration(id);
        if (
          toolServerOAuthResourceIdentity(beforeExchange) !==
          flow.resourceIdentity
        ) {
          throw new Error('OAuth tool server endpoint changed during consent');
        }

        let exchangeFailed = false;
        let exchangeFailure: unknown;
        try {
          await flow.claim.finishAuth(validated.params);
        } catch (error) {
          exchangeFailed = true;
          exchangeFailure = error;
          captureToolServerOperationFailure(
            error,
            'oauth-exchange',
            id,
            this.logger,
          );
        }

        if (exchangeFailed) {
          const reason = formatToolServerFailure(
            classifyOAuthFailure(exchangeFailure),
          );
          await this.saveAuthorizationHealth(
            id,
            flow.resourceIdentity,
            'authorization-failed',
            reason,
            flow.claim,
          );
          throw new Error('OAuth authorization failed');
        }

        toolServerOAuth.add(1, { outcome: 'consent-completed' });
        const health = await this.saveAuthorizationHealth(
          id,
          flow.resourceIdentity,
          'authorized',
          undefined,
          flow.claim,
        );
        if (!flow.claim.isCurrent()) throw new MCPLocalCustodyError('stale');
        return health;
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (claimed) await this.releaseAfterOperation(flow.claim, failed);
    }
  }

  private async saveAuthorizationHealth(
    id: string,
    expectedResourceIdentity: string,
    state:
      | 'awaiting-operator-consent'
      | 'authorized'
      | 'authorization-failed'
      | 'token-expired-refresh-failed',
    reason?: string,
    claim?: MCPLocalClaim,
  ): Promise<ToolDef> {
    const authorization = reason ? { state, reason } : { state };
    return this.configLoader.updateIntegration(id, (current) => {
      if (claim && !claim.isCurrent()) throw new MCPLocalCustodyError('stale');
      if (
        toolServerOAuthResourceIdentity(current) !== expectedResourceIdentity
      ) {
        throw new Error(
          'OAuth tool server endpoint changed during authorization exchange',
        );
      }
      return {
        ...current,
        probe: {
          ok: state === 'authorized',
          toolCount:
            state === 'authorized' ? (current.probe?.toolCount ?? 0) : 0,
          checkedAt: new Date().toISOString(),
          ...(reason ? { error: reason } : {}),
          authorization: authorization as NonNullable<
            ToolDef['probe']
          >['authorization'],
        },
      };
    });
  }

  private createOAuthProvider(def: ToolDef): StationToolServerOAuthProvider {
    const resourceIdentity = toolServerOAuthResourceIdentity(def);
    if (!resourceIdentity)
      throw new Error('OAuth tool server endpoint is missing or invalid');
    return new StationToolServerOAuthProvider(
      this.credentialStore(),
      def.id,
      resourceIdentity,
      toolServerOAuthRedirectUrl(this.serverPort, def.id),
      {
        tokensSaved: (refresh) => {
          if (refresh) toolServerOAuth.add(1, { outcome: 'refresh-succeeded' });
        },
        authorizationRedirect: (afterRefresh) => {
          if (afterRefresh)
            toolServerOAuth.add(1, { outcome: 'refresh-failed' });
        },
      },
    );
  }

  private credentialStore(): ToolServerCredentialStore {
    return new ToolServerCredentialStore(this.configLoader.getProjectHomeDir());
  }

  async applyDisabledTools(
    id: string,
    disabledTools: string[],
  ): Promise<ToolDef> {
    const existing = await this.getIntegration(id);
    const updated = { ...existing, disabledTools: [...new Set(disabledTools)] };
    await this.saveIntegration(updated);
    return updated;
  }

  async resetRuntimeState(): Promise<{
    rebuilt: boolean;
    scope: 'integration' | 'runtime';
    localCleanup: MCPLocalCleanup;
  }> {
    const resetIntegrationState = () => {
      this.mcpConfigs.clear();
      this.mcpConnectionStatus.clear();
      this.integrationMetadata.clear();
      this.agentTools.clear();
      this.toolNameMapping.clear();
      this.oauthFlows.clear();
    };
    const localCleanup = await this.mcpCustody.reset(resetIntegrationState);
    if (localCleanup.state !== 'settled')
      return { rebuilt: false, scope: 'runtime', localCleanup };
    if (!this.resetAllRuntimeProjections) {
      return { rebuilt: false, scope: 'integration', localCleanup };
    }
    try {
      await this.resetAllRuntimeProjections(() => {});
      return { rebuilt: true, scope: 'integration', localCleanup };
    } catch {
      return { rebuilt: false, scope: 'runtime', localCleanup };
    }
  }

  async probeIntegration(id: string): Promise<ToolDef> {
    const claim = this.mcpCustody.acquire(id, 'probe');
    let retained = false;
    let failed = false;
    try {
      const existing = await this.getIntegration(id);
      const oauthProvider =
        existing.transport === 'sse' || existing.transport === 'streamable-http'
          ? this.createOAuthProvider(existing)
          : undefined;
      let oauthTransport: Transport | undefined;
      try {
        const connection = await this.establishChild(existing, (child) =>
          claim.connect(child, {
            authProvider: oauthProvider,
            onTransport: (value) => {
              oauthTransport = value;
            },
          }),
        );
        const checkedAt = new Date().toISOString();
        const probe = {
          ok: true,
          toolCount: connection.tools.length,
          // CI-R15: keep the names this probe observed, bounded. The live tool
          // catalogue only fills once a session opens a client, so without this
          // the detail page can count tools it can never name.
          toolNames: connection.tools
            .slice(0, PROBE_TOOL_NAME_LIMIT)
            .map((tool) => tool.name),
          checkedAt,
        };
        await this.requireCurrentDefinition(claim, existing);
        const updated = { ...existing, probe };
        // Probe state is an internal projection write. It must retain an
        // operator-authored binding reference without reopening the public
        // integration authoring boundary.
        await this.configLoader.updateIntegration(id, (current) => {
          if (
            !claim.isCurrent() ||
            !sameMCPConnectionDefinition(existing, current)
          )
            throw new MCPLocalCustodyError('stale');
          return { ...current, probe };
        });
        toolServerProbes.add(1, { outcome: 'success' });
        if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
        return updated;
      } catch (error) {
        captureToolServerOperationFailure(error, 'probe', id, this.logger);
        await this.requireCurrentDefinition(claim, existing);
        const authorizationUrl = oauthProvider?.takeAuthorizationUrl();
        if (
          oauthProvider &&
          authorizationUrl &&
          oauthTransport &&
          'finishAuth' in oauthTransport
        ) {
          requireHttpAuthorizationUrl(authorizationUrl);
          claim.retainForOAuth();
          const previous = this.oauthFlows.get(id);
          if (previous) {
            const cleanup = await this.mcpCustody.release(previous.claim);
            if (cleanup.state !== 'settled')
              throw new MCPLocalCustodyError(cleanup.state);
          }
          this.oauthFlows.set(id, {
            provider: oauthProvider,
            resourceIdentity:
              toolServerOAuthResourceIdentity(existing) ??
              (() => {
                throw new Error(
                  'OAuth tool server endpoint is missing or invalid',
                );
              })(),
            claim,
          });
          const tokens = await claim.run(() => oauthProvider.tokens());
          const health = await this.saveAuthorizationHealth(
            id,
            toolServerOAuthResourceIdentity(existing) as string,
            tokens?.refresh_token
              ? 'token-expired-refresh-failed'
              : 'awaiting-operator-consent',
            tokens?.refresh_token
              ? 'Stored refresh token was rejected; operator consent is required'
              : undefined,
            claim,
          );
          if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
          retained = true;
          return health;
        }
        const checkedAt = new Date().toISOString();
        const message = formatToolServerFailure(
          classifyToolServerProbeFailure(error, existing.transport),
        );
        const probe = { ok: false, error: message, toolCount: 0, checkedAt };
        const updated = { ...existing, probe };
        await this.configLoader.updateIntegration(id, (current) => {
          if (
            !claim.isCurrent() ||
            !sameMCPConnectionDefinition(existing, current)
          )
            throw new MCPLocalCustodyError('stale');
          return { ...current, probe };
        });
        toolServerProbes.add(1, { outcome: 'failure' });
        if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
        this.logger.warn('Tool server probe failed', {
          toolId: id,
          error: message,
        });
        return updated;
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (!retained) {
        if (this.oauthFlows.get(id)?.claim === claim)
          this.oauthFlows.delete(id);
        await this.releaseAfterOperation(claim, failed);
      }
    }
  }

  getAgentTools(slug: string): ToolInfo[] {
    const tools = this.agentTools.get(slug) || [];
    return tools.map((tool: Tool<any> & { description?: string }) =>
      this.toToolInfo(tool),
    );
  }

  getMCPToolCatalog(): ToolInfo[] {
    const catalog = new Map<string, ToolInfo>();

    for (const tools of this.agentTools.values()) {
      for (const tool of tools) {
        const info = this.toToolInfo(
          tool as Tool<any> & { description?: string },
        );
        catalog.set(`${info.server ?? 'local'}:${info.toolName}`, info);
      }
    }

    return Array.from(catalog.values());
  }

  async addToolToAgent(slug: string, toolId: string): Promise<string[]> {
    const agent = await this.configLoader.loadAgent(slug);
    const tools = agent.tools || { mcpServers: [], available: ['*'] };

    if (!tools.mcpServers.some((e) => e === toolId)) {
      tools.mcpServers.push(toolId);
    }

    await this.configLoader.updateAgent(slug, { tools });
    return tools.mcpServers;
  }

  async removeToolFromAgent(slug: string, toolId: string): Promise<void> {
    const agent = await this.configLoader.loadAgent(slug);
    const tools = agent.tools || { mcpServers: [] };

    tools.mcpServers = tools.mcpServers.filter((e) => e !== toolId);

    await this.configLoader.updateAgent(slug, { tools });
  }

  async updateAllowedTools(
    slug: string,
    allowed: string[],
  ): Promise<AgentSpec['tools']> {
    const agent = await this.configLoader.loadAgent(slug);
    const tools = agent.tools || { mcpServers: [] };

    tools.available = allowed;

    await this.configLoader.updateAgent(slug, { tools });
    return tools;
  }

  /**
   * Run an MCP Apps operation through Station's protocol-owning connection.
   * Agent-attached integrations reuse their live connection so tools and Apps
   * observe the same negotiated server. Installed integrations that are not
   * attached to a live agent use a short-lived connection that is always
   * closed after the operation.
   */
  private async withMcpUiConnection<T>(
    serverId: string,
    operation: 'connect' | 'resource-read' | 'tool-call',
    fn: (conn: MCPConnection) => Promise<T>,
  ): Promise<T> {
    const claim = this.mcpCustody.acquire(serverId, 'app');
    let failed = false;
    try {
      const def = await this.configLoader.loadIntegration(serverId);
      if (!claim.isCurrent()) throw new MCPLocalCustodyError('stale');
      if (def.enabled === false) {
        throw new MCPServerDisabledError(
          `MCP server '${serverId}' is disabled`,
        );
      }

      const active = this.mcpConfigs.get(serverId);
      if (active) {
        try {
          if (active.isUsable?.() === false)
            throw new MCPLocalCustodyError('stale');
          const result = await fn(active);
          if (!claim.isCurrent() || active.isUsable?.() === false)
            throw new MCPLocalCustodyError('stale');
          return result;
        } catch (error) {
          if (error instanceof MCPAppsToolAccessError) throw error;
          throw captureToolServerOperationFailure(
            error,
            operation,
            serverId,
            this.logger,
          );
        }
      }

      let conn: MCPConnection;
      try {
        conn = await this.establishChild(def, (child) =>
          claim.connect(child, {
            authProvider:
              def.transport === 'sse' || def.transport === 'streamable-http'
                ? this.createOAuthProvider(def)
                : undefined,
          }),
        );
        await this.requireCurrentDefinition(claim, def);
      } catch (error) {
        throw captureToolServerOperationFailure(
          error,
          'connect',
          serverId,
          this.logger,
        );
      }
      try {
        const result = await fn(conn);
        if (!claim.isCurrent() || conn.isUsable?.() === false)
          throw new MCPLocalCustodyError('stale');
        return result;
      } catch (error) {
        if (error instanceof MCPAppsToolAccessError) throw error;
        throw captureToolServerOperationFailure(
          error,
          operation,
          serverId,
          this.logger,
        );
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      await this.releaseAfterOperation(claim, failed);
    }
  }

  /**
   * The MCP-UI tool catalog for one server. Each tool carries its raw name
   * (`originalName`), raw `_meta`, and `ui.resourceUri` — the fields the
   * resolver needs that the engine-facing catalog drops. An available result
   * is authoritative even when every tool is disabled and `tools` is empty;
   * only an unavailable result permits compatibility-catalog fallback.
   */
  async getMCPUIToolCatalog(serverId: string): Promise<MCPUIToolCatalogResult> {
    try {
      const tools = await this.withMcpUiConnection(
        serverId,
        'connect',
        async (conn) => {
          const def = await this.configLoader.loadIntegration(serverId);
          const disabled = new Set(def.disabledTools ?? []);
          return conn.tools.filter(
            (tool) =>
              !disabled.has(tool.originalName) && !disabled.has(tool.name),
          );
        },
      );
      return { available: true, tools };
    } catch (error) {
      if (error instanceof MCPServerDisabledError) {
        return { available: true, tools: [] };
      }
      return { available: false };
    }
  }

  /**
   * Read the content of a declared UI resource (SEP-1865) over Station's MCP
   * connection. Caller MUST pass a `uri` already
   * pinned to the resolved tool's declared `_meta.ui.resourceUri` — this method
   * does not accept arbitrary client URIs. Text content is byte-capped to guard
   * against oversized/hostile resources.
   */
  async readMCPUIResource(
    serverId: string,
    uri: string,
  ): Promise<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    truncated?: boolean;
    _meta?: Record<string, unknown>;
    ui?: MCPAppsUiMetadata;
  }> {
    return this.withMcpUiConnection(serverId, 'resource-read', async (conn) => {
      const raw = await conn.client.readResource({ uri });
      const content = firstResourceContent(raw);
      if (!content) {
        throw new StationOwnedToolServerError(
          'MCP resource returned no content',
        );
      }

      let text = stringField(content, 'text');
      let truncated = false;
      if (typeof text === 'string' && text.length > MCP_UI_RESOURCE_TEXT_CAP) {
        text = text.slice(0, MCP_UI_RESOURCE_TEXT_CAP);
        truncated = true;
      }
      const meta = recordField(content, '_meta');
      const ui = extractMCPAppsResourceMetadata(content);
      const hasUiPolicy = Boolean(ui.csp || ui.permissions);

      return {
        uri,
        mimeType: stringField(content, 'mimeType'),
        text,
        blob: stringField(content, 'blob'),
        truncated: truncated || undefined,
        ...(meta ? { _meta: meta } : {}),
        ...(hasUiPolicy ? { ui } : {}),
      };
    });
  }

  /**
   * Read a UI resource the **mcp-ui.dev** way: call the tool over Station's MCP
   * connection and extract the `ui://…` resource embedded in its result
   * content. Unlike SEP-1865 (`readMCPUIResource`), the mcp-ui.dev convention
   * only returns the UI as part of a tool result — so this CALLS the tool. (The
   * voltagent client strips `resource` blocks from tool results, which is why
   * all MCP-UI reads use the raw Station client.) The host gates this to
   * read-only-pinned components; args are fixed to `{}` (no client input); text
   * is byte-capped like the declared read.
   */
  async readMCPUIResourceFromTool(
    serverId: string,
    toolName: string,
  ): Promise<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    truncated?: boolean;
  }> {
    await this.assertMcpUiToolEnabled(serverId, toolName);
    return this.withMcpUiConnection(serverId, 'tool-call', async (conn) => {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: {},
      });
      const content = firstEmbeddedUiResource(
        (result as { content?: unknown })?.content,
      );
      if (!content) {
        throw new StationOwnedToolServerError(
          'MCP tool returned no embedded UI resource',
        );
      }

      let text = stringField(content, 'text');
      let truncated = false;
      if (typeof text === 'string' && text.length > MCP_UI_RESOURCE_TEXT_CAP) {
        text = text.slice(0, MCP_UI_RESOURCE_TEXT_CAP);
        truncated = true;
      }

      return {
        uri: stringField(content, 'uri') ?? `ui://${serverId}/${toolName}`,
        mimeType: stringField(content, 'mimeType'),
        text,
        blob: stringField(content, 'blob'),
        truncated: truncated || undefined,
      };
    });
  }

  /**
   * Proxy a View-initiated MCP tool call (the host bridge `tools/call`) over
   * Station's raw client. The full `CallToolResult` is preserved, including
   * resource blocks and structured content. The connection is pinned to
   * `serverId`, and approval policy is enforced host-side before invocation.
   */
  async callMCPUITool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    await this.assertMcpUiToolEnabled(serverId, toolName);
    return this.withMcpUiConnection(serverId, 'tool-call', async (conn) => {
      const tool = conn.tools.find(
        (candidate) => candidate.originalName === toolName,
      );
      if (!tool || !isMCPAppsToolVisibleTo(tool, 'app')) {
        throw new MCPAppsToolAccessError(serverId, toolName);
      }
      const result = await conn.client.callTool({
        name: tool.originalName,
        arguments: args ?? {},
      });
      return requireToolServerResult(
        result,
        'tool-call',
        serverId,
        this.logger,
      );
    });
  }

  private async assertMcpUiToolEnabled(
    serverId: string,
    toolName: string,
  ): Promise<void> {
    const def = await this.configLoader.loadIntegration(serverId);
    if (
      (def.disabledTools ?? []).some(
        (disabled) =>
          disabled === toolName || disabled === `${serverId}_${toolName}`,
      )
    ) {
      throw new MCPToolDisabledError(
        `MCP tool '${toolName}' is disabled for server '${serverId}'`,
      );
    }
  }

  getConnectionStatus(
    _agentSlug: string,
    toolId: string,
  ): MCPConnectionStatus | undefined {
    return this.mcpConnectionStatus.get(toolId);
  }

  getIntegrationMetadata(
    _agentSlug: string,
    toolId: string,
  ): IntegrationMetadata | undefined {
    return this.integrationMetadata.get(toolId);
  }

  private toToolInfo(tool: Tool<any> & { description?: string }): ToolInfo {
    const mapping = this.toolNameMapping.get(tool.name);

    // Convert Zod schema to JSON schema if parameters is a Zod object
    let parameters = tool.parameters;
    if (parameters && typeof parameters === 'object' && '_def' in parameters) {
      try {
        parameters = zodToJsonSchema(parameters);
      } catch (error) {
        this.logger.warn('Failed to convert Zod schema to JSON schema', {
          tool: tool.name,
          error,
        });
      }
    }

    const server = mapping?.server || null;
    const metadata = extractMCPAppsToolMetadata(tool);
    const ui = metadata.resourceUri
      ? { resourceUri: metadata.resourceUri }
      : undefined;

    return {
      id: tool.id || tool.name,
      name: tool.name,
      originalName: mapping?.original || tool.name,
      server,
      serverId: server ?? undefined,
      toolName: mapping?.tool || tool.name,
      description: tool.description,
      parameters,
      _meta: recordField(tool, '_meta'),
      ui,
      resource: ui ? { uri: ui.resourceUri } : undefined,
    };
  }
}

function sameSecretEnvRefs(
  received: Record<string, string> | undefined,
  existing: Record<string, string> | undefined,
): boolean {
  const receivedEntries = Object.entries(received ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const existingEntries = Object.entries(existing ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    receivedEntries.length === existingEntries.length &&
    receivedEntries.every(
      ([key, value], index) =>
        existingEntries[index]?.[0] === key &&
        existingEntries[index]?.[1] === value,
    )
  );
}

function changesBoundChildExecutionIdentity(
  existing: ToolDef,
  incoming: ToolDef,
): boolean {
  const executionFields: Array<keyof ToolDef> = [
    'kind',
    'transport',
    'command',
    'args',
    'endpoint',
    'env',
    'permissions',
    'timeouts',
    'healthCheck',
    'exposedTools',
    'builtinPolicy',
  ];
  return executionFields.some(
    (field) =>
      JSON.stringify(existing[field]) !== JSON.stringify(incoming[field]),
  );
}

export function openSystemBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: typeof spawn = spawn,
): void {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  const options: SpawnOptions = {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  };
  const child = spawnProcess(command, args, options);
  child.unref();
}

export function toolServerOAuthRedirectUrl(port: number, id: string): string {
  return `http://127.0.0.1:${port}/integrations/${encodeURIComponent(id)}/oauth/callback`;
}

function withAuthorizationRequired(def: ToolDef, reason: string): ToolDef {
  return {
    ...def,
    probe: {
      ok: false,
      error: reason,
      toolCount: 0,
      checkedAt: new Date().toISOString(),
      authorization: { state: 'never-authorized' },
    },
  };
}

function isMissingIntegrationError(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT') ||
    (error instanceof Error && /^Tool '.+' not found at /.test(error.message))
  );
}

// Cap UI resource text to guard against oversized/hostile resources rendering
// in the host. ~512KB of HTML is far beyond any reasonable panel.
const MCP_UI_RESOURCE_TEXT_CAP = 512 * 1024;

// MCP `resources/read` returns `{ contents: [{ uri, mimeType?, text?, blob? }] }`.
// Pick the first usable content entry; tolerate a single bare content object.
function firstResourceContent(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const contents = (raw as { contents?: unknown }).contents;
  if (Array.isArray(contents)) {
    return contents.find(
      (entry) => entry && typeof entry === 'object' && !Array.isArray(entry),
    ) as Record<string, unknown> | undefined;
  }
  return raw as Record<string, unknown>;
}

// mcp-ui.dev tools embed the UI as `{ type: 'resource', resource: { uri,
// mimeType, text } }` in the tool-call result `content[]`. Pick the first entry
// that looks like a renderable UI resource (a `ui://` uri or an HTML/mcp-app
// mimeType) carrying inline text.
function firstEmbeddedUiResource(
  content: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const entry of content) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if ((entry as Record<string, unknown>).type !== 'resource') continue;
    const resource = recordField(entry as Record<string, unknown>, 'resource');
    if (!resource || typeof resource.text !== 'string') continue;
    const uri = stringField(resource, 'uri') ?? '';
    const mimeType = stringField(resource, 'mimeType') ?? '';
    if (
      uri.startsWith('ui://') ||
      /text\/html/i.test(mimeType) ||
      /mcp-app/i.test(mimeType)
    ) {
      return resource;
    }
  }
  return undefined;
}

function recordField(
  record: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = record?.[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}
