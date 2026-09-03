import type {
  RunOutputRef,
  RunSource,
  RunSummary,
} from '@kontourai/station-contracts/runs';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import {
  type PluginForegroundRunReader,
  projectPluginForegroundRun,
} from '../plugins/plugin-foreground-runs.js';
import type { SchedulerService } from '../scheduling/scheduler-service.js';
import type { NativeInvocationRunReader } from './native-invocation-runs.js';
import type { OrchestrationService } from './orchestration-service.js';
import { projectOrchestrationRun } from './run-projection.js';
import type { VoiceTurnRunsReader } from './voice-turn-runs.js';

export class NativeInvocationStorageUnavailableError extends Error {
  constructor() {
    super('Native invocation run storage is temporarily unavailable.');
    this.name = 'NativeInvocationStorageUnavailableError';
  }
}

export class VoiceTurnStorageUnavailableError extends Error {
  constructor() {
    super('Voice turn run storage is temporarily unavailable.');
    this.name = 'VoiceTurnStorageUnavailableError';
  }
}

export class PluginForegroundRunStorageUnavailableError extends Error {
  constructor() {
    super('Plugin foreground run storage is temporarily unavailable.');
    this.name = 'PluginForegroundRunStorageUnavailableError';
  }
}

export interface RunListFilters {
  source?: RunSource;
  providerId?: string;
  sourceId?: string;
}

export class RunService {
  constructor(
    private readonly orchestrationService: OrchestrationService,
    private readonly schedulerService: SchedulerService,
    private readonly nativeInvocationRuns: NativeInvocationRunReader,
    private readonly voiceTurnRuns: VoiceTurnRunsReader,
    /** Optional only until the deep plugin foreground-work tracer is composed. */
    private readonly pluginForegroundRuns?: PluginForegroundRunReader,
  ) {}

  async listRuns(
    authority: SessionReadAuthority,
    filters: RunListFilters = {},
  ): Promise<RunSummary[]> {
    const includeOrchestration =
      !filters.source || filters.source === 'orchestration';
    // Schedule records and their output artifacts have no tenant binding.
    // Keep that leg entirely absent in hosted mode until schedule storage can
    // carry the same durable binding as orchestration sessions.
    const includeSchedule =
      !isHostedSessionReadAuthority(authority) &&
      (!filters.source || filters.source === 'schedule');
    const includeInvoke =
      !isHostedSessionReadAuthority(authority) &&
      (!filters.source || filters.source === 'invoke');
    const includeVoice =
      !isHostedSessionReadAuthority(authority) &&
      (!filters.source || filters.source === 'voice');
    const includePlugin =
      !!this.pluginForegroundRuns &&
      (!filters.source || filters.source === 'plugin');

    const [orchestrationRuns, scheduleRuns] = await Promise.all([
      includeOrchestration
        ? this.orchestrationService.listAgentRuns(authority)
        : Promise.resolve([]),
      includeSchedule
        ? this.schedulerService.listRunSummaries({
            providerId: filters.providerId,
            sourceId: filters.sourceId,
          })
        : Promise.resolve([]),
    ]);
    const nativeRuns = includeInvoke
      ? this.nativeInvocationRuns.list()
      : { kind: 'available' as const, runs: [] };
    const voiceRuns = includeVoice
      ? this.voiceTurnRuns.list()
      : { kind: 'available' as const, runs: [] };
    const pluginRuns = includePlugin
      ? await this.pluginForegroundRuns!.list(authority)
      : { kind: 'available' as const, runs: [] };
    if (nativeRuns.kind === 'unavailable') {
      throw new NativeInvocationStorageUnavailableError();
    }
    if (voiceRuns.kind === 'unavailable') {
      throw new VoiceTurnStorageUnavailableError();
    }
    if (pluginRuns.kind === 'unavailable') {
      throw new PluginForegroundRunStorageUnavailableError();
    }

    return [
      ...orchestrationRuns
        .map(projectOrchestrationRun)
        .filter((run) => this.matchesFilters(run, filters)),
      ...scheduleRuns,
      ...nativeRuns.runs.filter((run) => this.matchesFilters(run, filters)),
      ...voiceRuns.runs.filter((run) => this.matchesFilters(run, filters)),
      ...pluginRuns.runs
        .map(projectPluginForegroundRun)
        .filter((run) => this.matchesFilters(run, filters)),
    ].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async readRun(
    runId: string,
    authority: SessionReadAuthority,
  ): Promise<RunSummary | null> {
    if (runId.startsWith('schedule:')) {
      if (isHostedSessionReadAuthority(authority)) return null;
      return this.schedulerService.readRunSummary(runId);
    }
    if (runId.startsWith('orchestration:')) {
      const runs = await this.orchestrationService.listAgentRuns(authority);
      return (
        runs.map(projectOrchestrationRun).find((run) => run.runId === runId) ??
        null
      );
    }
    if (runId.startsWith('invoke:') || runId.startsWith('voice:')) {
      if (isHostedSessionReadAuthority(authority)) return null;
      const result = runId.startsWith('voice:')
        ? this.voiceTurnRuns.read(runId)
        : this.nativeInvocationRuns.read(runId);
      if (result.kind === 'unavailable') {
        throw runId.startsWith('voice:')
          ? new VoiceTurnStorageUnavailableError()
          : new NativeInvocationStorageUnavailableError();
      }
      return result.run;
    }
    if (runId.startsWith('plugin:')) {
      if (!this.pluginForegroundRuns) return null;
      const result = await this.pluginForegroundRuns.read(runId, authority);
      if (result.kind === 'unavailable') {
        throw new PluginForegroundRunStorageUnavailableError();
      }
      return result.run ? projectPluginForegroundRun(result.run) : null;
    }

    const legacy = await this.orchestrationService.readAgentRun(
      runId,
      authority,
    );
    return legacy ? projectOrchestrationRun(legacy) : null;
  }

  async readOutput(
    ref: RunOutputRef,
    authority: SessionReadAuthority,
  ): Promise<string | null> {
    if (ref.source === 'schedule') {
      if (isHostedSessionReadAuthority(authority)) return null;
      return this.schedulerService.readOutputRef(ref);
    }
    return null;
  }

  private matchesFilters(run: RunSummary, filters: RunListFilters): boolean {
    if (filters.providerId && run.providerId !== filters.providerId)
      return false;
    if (filters.sourceId && run.sourceId !== filters.sourceId) return false;
    return true;
  }
}
