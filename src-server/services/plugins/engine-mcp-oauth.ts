import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  ProviderSessionStartInput,
  ResolvedAgentToolServer,
} from '@kontourai/station-contracts/provider';
import { MCP_SIGN_IN_REQUIRED_CODE } from '@kontourai/station-contracts/provider-failure';
import type { ToolDef } from '@kontourai/station-contracts/tool';
import { SessionStartRefusedError } from '../../providers/adapter-shape.js';
import { sameMCPConnectionDefinition } from '../../runtime/mcp/mcp-definition-currentness.js';
import {
  DEFAULT_TTL_MS,
  mintStationControlMcpToken,
  verifyStationControlMcpToken,
} from '../../runtime/mcp/station-control-mcp-token.js';
import {
  ConnectAccountRequiredError,
  StationOwnedToolServerError,
  StationToolServerOAuthProvider,
  toolServerCredentialCandidates,
  toolServerCredentialStoreFor,
  toolServerOAuthResourceIdentity,
} from './tool-server-oauth.js';

const launchOwner = new AsyncLocalStorage<{ accountId: string | undefined }>();
export function withEngineMcpAccountOwner<T>(
  accountId: string | undefined,
  run: () => T,
): T {
  return launchOwner.run({ accountId }, run);
}
export function currentEngineMcpAccountOwner(): string | undefined {
  return launchOwner.getStore()?.accountId;
}

/** Values are session-scoped Station proxy URLs; remote credentials never cross this seam. */
export type EngineMcpOAuthResolver = (
  input: ProviderSessionStartInput,
) => Promise<ReadonlyMap<string, string>>;
export class EngineMcpNeedsSignInError extends SessionStartRefusedError {
  constructor(id: string) {
    super(
      `Integration '${id}' needs sign-in. Open Connections → Tools, sign in to its account, then start the session again.`,
      MCP_SIGN_IN_REQUIRED_CODE,
    );
  }
}

export const ENGINE_OAUTH_PROXY_PATH = '/mcp/oauth-proxy';
type ProxyBinding = {
  expiresAt: number;
  signal: AbortSignal;
  endpoint: string;
  transport: string;
  current: () => Promise<string>;
  accessToken: (rejected?: string) => Promise<string>;
  needsSignIn: (rejectedToken?: string) => Promise<void>;
  messageEndpoint?: string;
};
const bindings = new Map<string, ProxyBinding>();
const bindingKey = (session: string, server: string) =>
  JSON.stringify([session, server]);

/** The route can only retrieve a binding with the exact session/server credential. */
export function engineMcpProxyBinding(
  candidate: string | undefined,
  sessionId: string,
  serverId: string,
): ProxyBinding | undefined {
  const verified = verifyStationControlMcpToken(candidate, {
    channels: ['url-token'],
    serverId: `oauth-proxy:${serverId}`,
  });
  if (!verified || verified.sessionId !== sessionId) return undefined;
  const key = bindingKey(sessionId, serverId);
  const binding = bindings.get(key);
  if (binding && binding.expiresAt > Date.now()) return binding;
  bindings.delete(key);
  return undefined;
}

export function createEngineMcpOAuthResolver(options: {
  homeDir: () => string;
  port: () => number;
  getIntegration: (id: string) => Promise<ToolDef>;
  needsSignIn?: (id: string, resource: string) => Promise<unknown>;
}) {
  return async (
    servers: readonly ResolvedAgentToolServer[],
    principalId?: string,
    projectSlug?: string,
    sessionId?: string,
  ): Promise<ReadonlyMap<string, string>> => {
    const prepared: {
      server: ResolvedAgentToolServer;
      binding: Omit<ProxyBinding, 'expiresAt' | 'signal'>;
    }[] = [];
    for (const server of servers) {
      if (server.transport !== 'sse' && server.transport !== 'streamable-http')
        continue;
      const def = await options.getIntegration(server.id);
      const resource = toolServerOAuthResourceIdentity(def);
      const current = async () => {
        const latest = await options.getIntegration(server.id);
        if (
          !sameMCPConnectionDefinition(def, latest) ||
          latest.enabled === false
        )
          throw new StationOwnedToolServerError(
            `Integration '${server.id}' changed; start the session again.`,
          );
      };
      const needsSignIn = async () => {
        if (resource) await options.needsSignIn?.(server.id, resource);
      };
      try {
        if (
          !resource ||
          def.enabled === false ||
          def.transport !== server.transport ||
          resource !==
            toolServerOAuthResourceIdentity({
              ...def,
              endpoint: server.endpoint,
            })
        )
          throw new StationOwnedToolServerError(
            `Integration '${server.id}' changed; start the session again.`,
          );
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
          knownOAuth ||= Boolean(
            tokens || (await provider.clientInformation()),
          );
          if (tokens) {
            selected = provider;
            break;
          }
        }
        if (!selected) {
          if (knownOAuth) throw new EngineMcpNeedsSignInError(server.id);
          continue;
        }
        const provider = selected;
        await provider.accessToken();
        await current();
        if (!(await provider.tokens()))
          throw new EngineMcpNeedsSignInError(server.id);
        prepared.push({
          server,
          binding: {
            endpoint: resource,
            transport: server.transport,
            current: async () => {
              await current();
              const tokens = await provider.tokens();
              if (
                !tokens?.access_token ||
                tokens.token_type.toLowerCase() !== 'bearer'
              )
                throw new EngineMcpNeedsSignInError(server.id);
              return tokens.access_token;
            },
            needsSignIn: async (rejectedToken) => {
              if (rejectedToken)
                await provider.rejectAccessToken(rejectedToken);
              await needsSignIn();
            },
            accessToken: (rejected) => provider.accessToken(rejected),
          },
        });
      } catch (error) {
        if (
          error instanceof StationOwnedToolServerError &&
          !(error instanceof ConnectAccountRequiredError)
        )
          throw error;
        await needsSignIn();
        throw new EngineMcpNeedsSignInError(server.id);
      }
    }
    const result = new Map<string, string>();
    if (prepared.length && !sessionId)
      throw new Error('OAuth MCP delivery requires a session');
    // Mint only after every integration passed admission: partial refusal grants nothing.
    for (const { server, binding } of prepared) {
      const lifetime = new AbortController();
      const key = bindingKey(sessionId!, server.id);
      const { token, expiresAt } = mintStationControlMcpToken(
        sessionId!,
        'url-token',
        DEFAULT_TTL_MS,
        undefined,
        undefined,
        `oauth-proxy:${server.id}`,
        () => {
          lifetime.abort();
          bindings.delete(key);
        },
      );
      bindings.set(bindingKey(sessionId!, server.id), {
        ...binding,
        expiresAt,
        signal: lifetime.signal,
      });
      result.set(
        server.id,
        `http://127.0.0.1:${options.port()}${ENGINE_OAUTH_PROXY_PATH}/${encodeURIComponent(server.id)}/${encodeURIComponent(sessionId!)}?token=${encodeURIComponent(token)}`,
      );
    }
    return result;
  };
}
