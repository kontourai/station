import type { InboundWebhookConfiguration } from '@kontourai/station-contracts/inbound-webhook';
import type {
  IntegrationAction,
  IntegrationActionState,
  IntegrationActionStatus,
  IntegrationConnectionStatus,
  IntegrationStatus,
} from '@kontourai/station-contracts/integration-status';
import { execGitContextCommand } from '../../utils/git-exec.js';
import type { DiscordGatewayStatus } from '../discord/discord-gateway-service.js';

const GH_TIMEOUT_MS = 5_000;
const GH_CACHE_MS = 10_000;

export interface IntegrationStatusProbe {
  run(): Promise<IntegrationConnectionStatus>;
}

export function createIntegrationStatusReader(
  probes: readonly IntegrationStatusProbe[],
) {
  return async (): Promise<IntegrationStatus> => ({
    connections: await Promise.all(probes.map((probe) => probe.run())),
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

type GitHubResult = { state: 'signed-in' | 'failed'; reason: string };

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
  let cached: { expiresAt: number; result: GitHubResult } | undefined;
  let pending: Promise<GitHubResult> | undefined;

  const checkGithub = (): Promise<GitHubResult> => {
    if (cached && now() < cached.expiresAt)
      return Promise.resolve(cached.result);
    if (pending) return pending;
    pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      try {
        await Promise.race([
          exec('gh', ['auth', 'status', '--hostname', 'github.com'], {
            timeout: timeoutMs,
            maxBuffer: 8_192,
            windowsHide: true,
            signal: controller.signal,
            env: {
              GH_PROMPT_DISABLED: '1',
              GH_NO_UPDATE_NOTIFIER: '1',
              NO_COLOR: '1',
            },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              controller.abort();
              reject(Object.assign(new Error('timed out'), { killed: true }));
            }, timeoutMs);
          }),
        ]);
        return {
          state: 'signed-in',
          reason:
            'GitHub CLI is signed in to github.com; repository and issue permissions have not been checked.',
        } as const;
      } catch (error) {
        return {
          state: 'failed',
          reason: timedOut
            ? 'GitHub authentication check timed out.'
            : githubFailure(error),
        } as const;
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().then((result) => {
      cached = { result, expiresAt: now() + cacheMs };
      pending = undefined;
      return result;
    });
    return pending;
  };

  return [
    {
      async run() {
        const result = await checkGithub();
        const computedBy = 'github.gh-auth-status';
        return {
          connectionId: 'github',
          provider: 'github',
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
        try {
          const configuration = deps.readWebhook();
          if (configuration.enabled !== true) {
            state = 'unsupported';
            reason = 'Inbound webhooks are not enabled.';
          } else if (
            !configuration.tokens?.some(
              (token) =>
                token.revokedAt === undefined &&
                (token.starts?.length ?? 0) > 0,
            )
          ) {
            state = 'unsupported';
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
