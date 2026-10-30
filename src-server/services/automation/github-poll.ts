/**
 * The `github-poll` Automation source (epic kontourai/station#3439, owner
 * decision 1): Station polls GitHub for completed workflow runs, so it needs
 * no public ingress.
 *
 * It has no timer of its own. The built-in scheduler calls {@link poll} on
 * its existing minute tick, and each source's own interval
 * (`pollIntervalMs`) is enforced here from the ledger's poll state, so a
 * restart neither re-polls early nor loses its place. GitHub is read through
 * the external monitor's REST transport and secret-binding credential path
 * (`listGitHubWorkflowRuns`).
 *
 * Observe-only (slice S2): each run is normalized, deduped, matched and
 * recorded; nothing is started.
 *
 * Cursor: the ledger keeps, per source, the newest `updated_at` a successful
 * poll processed. A later poll skips runs older than that cursor minus
 * {@link CURSOR_OVERLAP_MS}; runs inside the overlap are re-read and dedupe
 * as transport duplicates, which write nothing. The cursor never trails the
 * freshness bound, so a run already too old to act on is refused (and
 * recorded) once, not on every poll.
 */

import {
  AUTOMATION_EXECUTION_LIMITS,
  type AutomationPollOutcome,
  type AutomationRule,
  type AutomationSource,
  type GitHubPollAutomationSource,
} from '@kontourai/station-contracts/automation';
import { errorMessage } from '../../utils/error-message.js';
import type { Logger } from '../../utils/logger.js';
import type {
  FeaturePreviewRegistry,
  FeaturePreviewSelector,
} from '../feature-previews/feature-preview-registry.js';
import {
  type GitHubWorkflowRunListing,
  listGitHubWorkflowRuns,
} from '../scheduling/external-monitor.js';
import type { IntegrationSecretResolver } from '../secrets/secret-binding-administration.js';
import {
  recordAutomationEvent,
  recordAutomationRefusal,
} from './automation-intake.js';
import type {
  AutomationLedger,
  SharedAutomationLedger,
} from './automation-ledger.js';
import type { AutomationStore } from './automation-store.js';
import {
  normalizeGitHubWorkflowRun,
  WORKFLOW_RUN_COMPLETED,
} from './github-workflow-run.js';

/** Runs requested per listing; one page, never paginated. */
const GITHUB_POLL_RUNS_PER_PAGE = 20;
/** Listing lag tolerated behind the cursor before a run counts as seen. */
export const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
/** Above this many pinned workflow files, one repository-wide listing is cheaper. */
const MAX_POLLED_WORKFLOW_FILES = 4;
const WORKFLOW_PATH = /^\.github\/workflows\/([A-Za-z0-9_.-]{1,100}\.ya?ml)$/;

type MonitorFetch = (input: string, init: RequestInit) => Promise<Response>;

export type GitHubPollSourceSummary = Readonly<{
  sourceId: string;
  outcome:
    | AutomationPollOutcome
    | 'skipped-not-due'
    | 'skipped-no-rules'
    | 'skipped-disabled'
    | 'skipped-source-changed'
    | 'skipped-stopping';
  matched: number;
  noMatch: number;
  ignored: number;
  duplicate: number;
  refused: number;
  seen: number;
}>;

export interface GitHubPollAutomationPollerOptions {
  preview: FeaturePreviewSelector;
  store: Pick<AutomationStore, 'read' | 'actionableRules'>;
  /** Opened on the first due poll; closed with the poller. */
  ledger: Pick<SharedAutomationLedger, 'get' | 'close'>;
  fetcher?: MonitorFetch;
  integrationSecretResolver?: IntegrationSecretResolver;
  logger?: Logger;
}

export function composeGitHubAutomationObservation(
  input: Omit<GitHubPollAutomationPollerOptions, 'preview'> & {
    hosted: boolean;
    featurePreviews: FeaturePreviewRegistry;
  },
) {
  if (input.hosted) return { preview: undefined, poller: undefined };
  const preview = input.featurePreviews.bind({
    id: 'github-automation-observations',
    label: 'GitHub automation observations',
    description:
      'Observe configured GitHub workflow runs without starting agents. Uses GitHub API requests and stores bounded delivery history.',
  });
  const poller = new GitHubPollAutomationPoller({ ...input, preview });
  return { preview, poller };
}

/**
 * The workflow files every actionable rule (and its `closeOn`) pins, or
 * undefined when any matcher leaves `workflow.path` open, names a path
 * outside `.github/workflows/`, or there are too many to list separately.
 * Listing per workflow keeps a long run (created hours ago, completed now)
 * on the first page in a busy repository.
 */
export function pinnedWorkflowFiles(
  rules: readonly AutomationRule[],
): string[] | undefined {
  const files = new Set<string>();
  const matchers = rules.flatMap((rule) => [
    rule.match,
    ...(rule.episode?.closeOn ? [rule.episode.closeOn] : []),
  ]);
  for (const matcher of matchers) {
    const pinned = matcher.where['workflow.path'];
    if (pinned === undefined) return undefined;
    for (const path of typeof pinned === 'string' ? [pinned] : pinned) {
      const file = WORKFLOW_PATH.exec(path)?.[1];
      if (!file) return undefined;
      files.add(file);
    }
  }
  if (files.size === 0 || files.size > MAX_POLLED_WORKFLOW_FILES)
    return undefined;
  return [...files].sort();
}

function isDuePollSource(
  source: AutomationSource,
): source is GitHubPollAutomationSource {
  return (
    source.kind === 'github-poll' &&
    source.enabled &&
    source.revokedAt === undefined
  );
}

function updatedAtOf(run: unknown): number {
  const value = (run as { updated_at?: unknown } | null)?.updated_at;
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export class GitHubPollAutomationPoller {
  constructor(private readonly options: GitHubPollAutomationPollerOptions) {}

  /**
   * Polls every enabled, due `github-poll` source once. Errors are logged
   * per source and never thrown: the scheduler tick must not fail with it.
   */
  async poll(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<GitHubPollSourceSummary[]> {
    if (
      !this.options.preview.select({
        enabled: () => true,
        disabled: () => false,
      })
    )
      return [];
    let sources: GitHubPollAutomationSource[];
    try {
      sources = this.options.store.read().sources.filter(isDuePollSource);
    } catch (error) {
      this.options.logger?.warn('Automation policy unavailable; poll skipped', {
        error: errorMessage(error),
      });
      return [];
    }
    if (sources.length === 0) return [];
    let ledger: AutomationLedger;
    try {
      ledger = this.options.ledger.get();
    } catch (error) {
      this.options.logger?.warn('Automation ledger unavailable; poll skipped', {
        error: errorMessage(error),
      });
      return [];
    }
    const summaries: GitHubPollSourceSummary[] = [];
    for (const source of sources) {
      if (
        input.signal.aborted ||
        !this.options.preview.select({
          enabled: () => true,
          disabled: () => false,
        })
      )
        break;
      try {
        summaries.push(await this.pollSource(ledger, source, input));
      } catch (error) {
        this.options.logger?.warn('Automation poll failed', {
          sourceId: source.id,
          error: errorMessage(error),
        });
      }
    }
    return summaries;
  }

  close(): void {
    this.options.ledger.close();
  }

  private pollRefusal(
    source: GitHubPollAutomationSource,
    signal: AbortSignal,
  ): GitHubPollSourceSummary['outcome'] | undefined {
    if (signal.aborted) return 'skipped-stopping';
    if (
      !this.options.preview.select({
        enabled: () => true,
        disabled: () => false,
      })
    )
      return 'skipped-disabled';
    const current = this.options.store
      .read()
      .sources.find((entry) => entry.id === source.id);
    if (
      !current ||
      !isDuePollSource(current) ||
      JSON.stringify(current) !== JSON.stringify(source)
    )
      return 'skipped-source-changed';
    if (this.options.store.actionableRules(source.id).length === 0)
      return 'skipped-no-rules';
    return undefined;
  }

  private async pollSource(
    ledger: AutomationLedger,
    source: GitHubPollAutomationSource,
    input: { now: number; signal: AbortSignal },
  ): Promise<GitHubPollSourceSummary> {
    const counts = {
      matched: 0,
      noMatch: 0,
      ignored: 0,
      duplicate: 0,
      refused: 0,
      seen: 0,
    };
    const state = ledger.pollState(source.id);
    const interval =
      source.pollIntervalMs ??
      AUTOMATION_EXECUTION_LIMITS.defaultPollIntervalMs;
    if (state && input.now < state.lastPolledAt + interval)
      return { sourceId: source.id, outcome: 'skipped-not-due', ...counts };
    const rules = this.options.store.actionableRules(source.id);
    // No rule can act on anything this poll would find: spend no quota.
    if (rules.length === 0)
      return { sourceId: source.id, outcome: 'skipped-no-rules', ...counts };

    const files = pinnedWorkflowFiles(rules);
    const listings: GitHubWorkflowRunListing[] = [];
    for (const workflowFile of files ?? [undefined]) {
      const refusal = this.pollRefusal(source, input.signal);
      if (refusal) return { sourceId: source.id, outcome: refusal, ...counts };
      listings.push(
        await listGitHubWorkflowRuns(
          {
            repository: source.repository,
            ...(workflowFile ? { workflowFile } : {}),
            ...(source.credentialSecretBinding
              ? { credentialSecretBinding: source.credentialSecretBinding }
              : {}),
            perPage: GITHUB_POLL_RUNS_PER_PAGE,
            signal: input.signal,
          },
          this.options.fetcher,
          this.options.integrationSecretResolver,
        ),
      );
    }
    const failed = listings.find((listing) => listing.kind === 'failed');
    const refusal = this.pollRefusal(source, input.signal);
    if (refusal) return { sourceId: source.id, outcome: refusal, ...counts };
    const currentRules = this.options.store.actionableRules(source.id);
    const observedAt = Date.now();
    if (failed?.kind === 'failed') {
      const outcome =
        failed.outcome === 'unauthorized' ? 'unauthorized' : 'unavailable';
      ledger.recordPoll({
        sourceId: source.id,
        polledAt: input.now,
        outcome,
      });
      this.options.logger?.warn('Automation GitHub poll unavailable', {
        sourceId: source.id,
        outcome: failed.outcome,
        detail: failed.detail,
      });
      return { sourceId: source.id, outcome, ...counts };
    }

    // Oldest first, so an episode opens on the first failing run.
    const runs = listings
      .flatMap((listing) => (listing.kind === 'runs' ? listing.runs : []))
      .sort((a, b) => updatedAtOf(a) - updatedAtOf(b));
    const cutoff =
      state?.cursorMs === undefined
        ? Number.NEGATIVE_INFINITY
        : state.cursorMs - CURSOR_OVERLAP_MS;
    let newest = Number.NEGATIVE_INFINITY;
    for (const run of runs) {
      const normalized = normalizeGitHubWorkflowRun(run, {
        source,
        receivedAt: observedAt,
      });
      const updatedAtMs = normalized.updatedAtMs;
      if (updatedAtMs !== undefined && updatedAtMs < cutoff) continue;
      counts.seen += 1;
      if (normalized.kind === 'refused') {
        recordAutomationRefusal({
          ledger,
          sourceId: source.id,
          semanticKey: normalized.semanticKey,
          eventType: WORKFLOW_RUN_COMPLETED,
          reason: normalized.reason,
          now: observedAt,
        });
        counts.refused += 1;
        continue;
      }
      newest = Math.max(newest, normalized.updatedAtMs);
      const result = recordAutomationEvent({
        ledger,
        rules: currentRules,
        event: normalized.event,
        transportId: normalized.event.semanticKey,
        now: observedAt,
      });
      if (result.outcome === 'matched') counts.matched += 1;
      else if (result.outcome === 'no-match') counts.noMatch += 1;
      else if (result.outcome === 'ignored') counts.ignored += 1;
      else counts.duplicate += 1;
    }
    const partial = listings.some(
      (listing) => listing.kind === 'runs' && listing.partial,
    );
    ledger.recordPoll({
      sourceId: source.id,
      polledAt: input.now,
      outcome: partial ? 'partial' : 'ok',
      ...(partial
        ? {}
        : {
            cursorMs: Math.max(
              newest,
              observedAt - AUTOMATION_EXECUTION_LIMITS.maxEventAgeMs,
            ),
          }),
    });
    return {
      sourceId: source.id,
      outcome: partial ? 'partial' : 'ok',
      ...counts,
    };
  }
}
