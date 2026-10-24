import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type {
  ProviderSessionStartInput,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { refreshAuthorization } from '@modelcontextprotocol/client';
import { sameMCPConnectionDefinition } from '../../runtime/mcp/mcp-definition-currentness.js';
import {
  StationOwnedToolServerError,
  StationToolServerOAuthProvider,
  toolServerCredentialCandidates,
  toolServerCredentialStoreFor,
  toolServerOAuthResourceIdentity,
} from './tool-server-oauth.js';

const launchOwner = new AsyncLocalStorage<{ accountId: string | undefined }>();

/** The command service supplies this scope from its authenticated dispatch context. */
export function withEngineMcpAccountOwner<T>(
  accountId: string | undefined,
  run: () => T,
): T {
  return launchOwner.run({ accountId }, run);
}

export function currentEngineMcpAccountOwner(): string | undefined {
  return launchOwner.getStore()?.accountId;
}

/** Server-owned launch input, never part of persisted agent/session metadata. */
export type EngineMcpOAuthResolver = (
  input: ProviderSessionStartInput,
) => Promise<ReadonlyMap<string, string>>;

export function engineMcpTokenEnvName(id: string): string {
  return `STATION_MCP_OAUTH_${createHash('sha256').update(id).digest('hex').toUpperCase()}`;
}

export class EngineMcpNeedsSignInError extends StationOwnedToolServerError {
  constructor(id: string) {
    super(
      `Integration '${id}' needs sign-in. Open Connections → Tools, connect your account, then start the session again.`,
    );
  }
}

/** Select credentials only from the recorded session owner and admitted Project. */
export function createEngineMcpOAuthResolver(options: {
  homeDir: () => string;
  port: () => number;
  getIntegration: (id: string) => Promise<ToolDef>;
}) {
  const refreshes = new Map<string, Promise<string>>();
  return async (
    servers: readonly ResolvedAgentToolServer[],
    principalId?: string,
    projectSlug?: string,
  ): Promise<ReadonlyMap<string, string>> => {
    const result = new Map<string, string>();
    for (const server of servers) {
      if (server.transport !== 'sse' && server.transport !== 'streamable-http')
        continue;
      const def = await options.getIntegration(server.id);
      const resource = toolServerOAuthResourceIdentity(def);
      if (
        !resource ||
        def.enabled === false ||
        def.transport !== server.transport ||
        resource !==
          toolServerOAuthResourceIdentity({ ...def, endpoint: server.endpoint })
      )
        throw new StationOwnedToolServerError(
          `Integration '${server.id}' changed; start the session again.`,
        );
      const needsSignIn = () => new EngineMcpNeedsSignInError(server.id);
      let selected: StationToolServerOAuthProvider | undefined;
      let knownOAuth = Boolean(
        def.credentialOwnership || def.probe?.authorization,
      );
      for (const owner of toolServerCredentialCandidates(
        def,
        principalId,
        projectSlug,
      )) {
        const provider = new StationToolServerOAuthProvider(
          toolServerCredentialStoreFor(options.homeDir(), owner),
          def.id,
          resource,
          `http://127.0.0.1:${options.port()}/integrations/${encodeURIComponent(def.id)}/oauth/callback`,
          undefined,
          owner,
        );
        const tokens = await provider.tokens();
        knownOAuth ||= Boolean(tokens || (await provider.clientInformation()));
        if (tokens) {
          selected = provider;
          break;
        }
      }
      if (!selected) {
        if (knownOAuth) throw needsSignIn();
        continue;
      }
      const provider = selected;
      const key = `${provider.bucket}:${resource}`;
      let pending = refreshes.get(key);
      if (!pending) {
        pending = (async () => {
          let tokens = await provider.tokens();
          const expiresAt = await provider.accessTokenExpiresAt();
          // Older envelopes with expires_in have no reliable issue time.
          const expired =
            tokens?.expires_in !== undefined &&
            (expiresAt === undefined || expiresAt <= Date.now() + 60_000);
          if (expired) {
            const discovery = await provider.discoveryState();
            const issuer =
              discovery?.authorizationServerMetadata?.issuer ??
              discovery?.authorizationServerUrl;
            const client = issuer
              ? await provider.clientInformation({ issuer })
              : undefined;
            tokens = issuer ? await provider.tokens({ issuer }) : undefined;
            if (!tokens?.refresh_token || !discovery || !client || !issuer)
              throw needsSignIn();
            try {
              const refreshed = await refreshAuthorization(
                discovery.authorizationServerUrl,
                {
                  metadata: discovery.authorizationServerMetadata,
                  clientInformation: client,
                  refreshToken: tokens.refresh_token,
                  resource: discovery.resourceMetadata?.resource ?? resource,
                  fetchFn: (url, init) =>
                    fetch(url, {
                      ...init,
                      signal: AbortSignal.timeout(15_000),
                    }),
                },
              );
              const current = await options.getIntegration(server.id);
              if (
                !sameMCPConnectionDefinition(def, current) ||
                current.enabled === false ||
                (await provider.tokens())?.access_token !== tokens.access_token
              )
                throw needsSignIn();
              await provider.saveTokens({ ...refreshed, issuer }, { issuer });
              tokens = await provider.tokens({ issuer });
            } catch {
              // OAuth response bodies can echo credentials; never expose the cause.
              throw needsSignIn();
            }
          }
          if (
            !tokens?.access_token ||
            tokens.token_type.toLowerCase() !== 'bearer'
          )
            throw needsSignIn();
          return tokens.access_token;
        })();
        refreshes.set(key, pending);
      }
      let token: string;
      try {
        token = await pending;
      } finally {
        if (refreshes.get(key) === pending) refreshes.delete(key);
      }
      const current = await options.getIntegration(server.id);
      if (
        !sameMCPConnectionDefinition(def, current) ||
        current.enabled === false
      )
        throw new StationOwnedToolServerError(
          `Integration '${server.id}' changed; start the session again.`,
        );
      // A disconnect during refresh/preparation must not export the old credential.
      if ((await provider.tokens())?.access_token !== token)
        throw needsSignIn();
      result.set(server.id, token);
    }
    return result;
  };
}
