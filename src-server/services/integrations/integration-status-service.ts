import type { InboundWebhookConfiguration } from '@kontourai/station-contracts/inbound-webhook';
import type {
  GitHubCliAuthentication,
  IntegrationAction,
  IntegrationActionState,
  IntegrationActionStatus,
  IntegrationConnectionStatus,
  IntegrationStatus,
} from '@kontourai/station-contracts/integration-status';
import {
  INTEGRATION_STATUS_LIMITS,
  parseGitHubCliAuthentication,
} from '@kontourai/station-contracts/integration-status';
import { z } from 'zod/v3';
import {
  managedCapabilityDenial,
  webhookAutomationsAllowedByManagedPolicy,
} from '../../security/managed-capability-limits.js';
import { execGitContextCommand } from '../../utils/git-exec.js';
import type { DiscordGatewayStatus } from '../discord/discord-gateway-service.js';

const GH_TIMEOUT_MS = 5_000;
const GH_CACHE_MS = 10_000;

export interface IntegrationStatusProbe {
  run(options?: {
    includeGithubAuthentication?: boolean;
  }): Promise<IntegrationConnectionStatus>;
}

export function createIntegrationStatusReader(
  probes: readonly IntegrationStatusProbe[],
) {
  return async (options?: {
    includeGithubAuthentication?: boolean;
  }): Promise<IntegrationStatus> => ({
    connections: await Promise.all(probes.map((probe) => probe.run(options))),
  });
}

function actions(
  names: readonly IntegrationAction[],
  computedBy: string,
  state: IntegrationActionState,
  reason: string,
): IntegrationActionStatus[] {
  return names.map((action) => ({ action, computedBy, state, reason }));
}

type GitHubResult = {
  state: 'signed-in' | 'failed';
  reason: string;
  authentication?: GitHubCliAuthentication;
};

const githubHosts = z.object({
  hosts: z.object({
    'github.com': z
      .array(
        z.object({
          state: z.string(),
          active: z.boolean(),
          login: z.string().optional(),
          scopes: z.string().optional(),
        }),
      )
      .max(20),
  }),
});

function githubAuthentication(
  stdout: string,
  observedAt: number,
): GitHubCliAuthentication {
  const unknown: GitHubCliAuthentication = { state: 'unknown', observedAt };
  try {
    const parsed = githubHosts.safeParse(JSON.parse(stdout));
    if (!parsed.success) return unknown;
    const active = parsed.data.hosts['github.com'].filter(
      (account) => account.active,
    );
    if (active.length !== 1)
      return active.length === 0 ? { state: 'failed', observedAt } : unknown;
    const account = active[0];
    if (account.state !== 'success') return { state: 'failed', observedAt };
    return (
      parseGitHubCliAuthentication({
        state: 'signed-in',
        observedAt,
        ...(account.login !== undefined ? { account: account.login } : {}),
        ...(account.scopes !== undefined
          ? {
              scopes: account.scopes
                .split(',')
                .map((scope) => scope.trim())
                .filter(Boolean),
            }
          : {}),
      }) ?? unknown
    );
  } catch {
    return unknown;
  }
}

function githubFailure(error: unknown): string {
  const failure =
    error && typeof error === 'object'
      ? (error as { code?: unknown; killed?: unknown })
      : {};
  if (failure.code === 'ENOENT')
    return 'GitHub CLI (gh) is not installed or not on PATH.';
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
    return 'GitHub authentication check exceeded its output limit.';
  if (failure.killed === true) return 'GitHub authentication check timed out.';
  if (failure.code === 4) return 'GitHub CLI is not signed in to github.com.';
  return 'GitHub authentication check failed; run gh auth status on the Station host for details.';
}

export function createIntegrationStatusProbes(deps: {
  readDiscord: () => DiscordGatewayStatus;
  readWebhook: () => InboundWebhookConfiguration;
  exec?: typeof execGitContextCommand;
  now?: () => number;
  githubTimeoutMs?: number;
  githubCacheMs?: number;
}): IntegrationStatusProbe[] {
  const exec = deps.exec ?? execGitContextCommand;
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.githubTimeoutMs ?? GH_TIMEOUT_MS;
  const cacheMs = deps.githubCacheMs ?? GH_CACHE_MS;
  const cache = new Map<boolean, { expiresAt: number; result: GitHubResult }>();
  const inFlight = new Map<boolean, Promise<GitHubResult>>();

  const checkGithub = (
    includeAuthentication = false,
  ): Promise<GitHubResult> => {
    const cached = cache.get(includeAuthentication);
    if (cached && now() < cached.expiresAt)
      return Promise.resolve(cached.result);
    const existing = inFlight.get(includeAuthentication);
    if (existing) return existing;
    const pending = (async (): Promise<GitHubResult> => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        const output = await Promise.race([
          exec(
            'gh',
            [
              'auth',
              'status',
              '--hostname',
              'github.com',
              ...(includeAuthentication
                ? ['--json', 'hosts', '--no-refresh']
                : []),
            ],
            {
              timeout: timeoutMs,
              maxBuffer: 8_192,
              windowsHide: true,
              signal: controller.signal,
              env: {
                GH_PROMPT_DISABLED: '1',
                GH_NO_UPDATE_NOTIFIER: '1',
                NO_COLOR: '1',
              },
            },
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(Object.assign(new Error('timed out'), { killed: true }));
            }, timeoutMs);
          }),
        ]);
        if (includeAuthentication) {
          const authentication = githubAuthentication(output.stdout, now());
          return {
            authentication,
            state:
              authentication.state === 'signed-in' ? 'signed-in' : 'failed',
            reason:
              authentication.state === 'signed-in'
                ? 'GitHub CLI is signed in to github.com; repository permissions have not been checked.'
                : 'GitHub CLI sign-in could not be confirmed. Check gh auth status on this Station.',
          };
        }
        return {
          state: 'signed-in',
          reason:
            'GitHub CLI is signed in to github.com; repository and issue permissions have not been checked.',
        } as const;
      } catch (error) {
        return {
          state: 'failed',
          ...(includeAuthentication
            ? {
                authentication: {
                  state: 'unknown' as const,
                  observedAt: now(),
                },
              }
            : {}),
          reason: timedOut
            ? 'GitHub authentication check timed out.'
            : githubFailure(error),
        } as const;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().then((result) => {
      cache.set(includeAuthentication, { result, expiresAt: now() + cacheMs });
      inFlight.delete(includeAuthentication);
      return result;
    });
    inFlight.set(includeAuthentication, pending);
    return pending;
  };

  return [
    {
      async run(options) {
        const result = await checkGithub(options?.includeGithubAuthentication);
        const computedBy = 'github.gh-auth-status';
        return {
          connectionId: 'github',
          provider: 'github',
          ...(result.authentication
            ? { authentication: result.authentication }
            : {}),
          actions: [
            ...actions(
              ['read', 'write', 'link-pr'],
              computedBy,
              result.state === 'failed' ? 'failed' : 'unverified',
              result.reason,
            ),
            ...actions(
              ['update-status', 'close-issue'],
              computedBy,
              result.state === 'failed' ? 'failed' : 'waiting-on-provider',
              result.state === 'failed'
                ? result.reason
                : 'Tracker status write-back waits on flow-agents #1507, #1508 and #1509 (Station #3703).',
            ),
          ],
        };
      },
    },
    {
      async run() {
        const computedBy = 'discord.gateway';
        let gateway: DiscordGatewayStatus;
        try {
          gateway = deps.readDiscord();
        } catch {
          gateway = {
            state: 'failed',
            reason: 'Discord gateway state could not be read.',
          };
        }
        const state =
          gateway.state === 'failed'
            ? 'failed'
            : gateway.state === 'connected'
              ? 'unverified'
              : gateway.state === 'not-configured'
                ? 'not-configured'
                : 'unsupported';
        return {
          connectionId: 'discord',
          provider: 'discord',
          actions: [
            ...actions(
              ['notify', 'continue'],
              computedBy,
              state,
              gateway.state === 'connected'
                ? `${gateway.reason} Delivery and conversation access have not been verified.`
                : gateway.reason,
            ),
            ...actions(
              ['start', 'approve'],
              computedBy,
              gateway.state === 'failed' ? 'failed' : 'unsupported',
              gateway.state === 'failed'
                ? gateway.reason
                : 'Starting Tasks and approving from Discord are not available yet (Station #4143 and #4145).',
            ),
          ],
        };
      },
    },
    {
      async run() {
        return {
          connectionId: 'slack',
          provider: 'slack',
          actions: actions(
            ['notify', 'start', 'continue', 'approve'],
            'slack.integration',
            'unsupported',
            'Slack is not configured: the Slack integration is not available yet (Station #4144).',
          ),
        };
      },
    },
    {
      async run() {
        const computedBy = 'webhook.configuration';
        let state: IntegrationActionState;
        let reason: string;
        // #4521: the policy outranks the file's own switch, and is read
        // first. `unsupported` (not a new state) keeps older clients' closed
        // parsers reading it.
        if (!webhookAutomationsAllowedByManagedPolicy())
          return {
            connectionId: 'webhook',
            provider: 'webhook',
            actions: actions(
              ['start'],
              'managed-policy.limits.webhookAutomations',
              'unsupported',
              managedCapabilityDenial(
                'webhook automations',
                INTEGRATION_STATUS_LIMITS.reasonChars,
              ),
            ),
          };
        try {
          const configuration = deps.readWebhook();
          if (configuration.enabled !== true) {
            state = 'not-configured';
            reason = 'Inbound webhooks are not enabled.';
          } else if (
            !configuration.tokens?.some(
              (token) =>
                token.revokedAt === undefined &&
                (token.starts?.length ?? 0) > 0,
            )
          ) {
            state = 'not-configured';
            reason = 'No active webhook token has a start grant.';
          } else {
            state = 'unverified';
            reason =
              'An enabled webhook has an active start grant; delivery and target availability have not been verified.';
          }
        } catch {
          state = 'failed';
          reason = 'Inbound webhook configuration could not be read.';
        }
        return {
          connectionId: 'webhook',
          provider: 'webhook',
          actions: actions(['start'], computedBy, state, reason),
        };
      },
    },
    ...(['linear', 'jira'] as const).map(
      (provider): IntegrationStatusProbe => ({
        async run() {
          return {
            connectionId: provider,
            provider,
            actions: actions(
              ['read', 'write', 'update-status', 'close-issue'],
              `${provider}.upstream-availability`,
              'waiting-on-provider',
              'Not available yet: tracker support waits on flow-agents #1508 and #1510.',
            ),
          };
        },
      }),
    ),
  ];
}
