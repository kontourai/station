/**
 * WorkItemProviderService — provider seam aggregator (roadmap #583, part of
 * epic #580, S3). Follows the `NotificationService` precedent: registered
 * `IWorkItemProvider` backends are polled per project and merged into one
 * response. Every backend is expected to report `available: false` on its
 * own absence rather than throw; this service adds a defensive catch on top
 * so one backend's genuine failure (e.g. an unexpected exception) never
 * takes down the whole Tasks board response.
 */

import type {
  WorkItemProviderResult,
  WorkItemsListResponse,
} from '@kontourai/station-contracts/work-item-provider';
import type {
  IWorkItemProvider,
  WorkItemProjectContext,
} from '../../providers/provider-interfaces.js';
import { workItemProviderListTotal } from '../../telemetry/metrics.js';

interface WorkItemProviderServiceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export class WorkItemProviderService {
  constructor(
    private readonly providers: IWorkItemProvider[],
    private readonly logger?: WorkItemProviderServiceLogger,
  ) {}

  async listWorkItems(
    context: WorkItemProjectContext,
  ): Promise<WorkItemsListResponse> {
    const results = await Promise.all(
      this.providers.map((provider) => this.runProvider(provider, context)),
    );
    return { providers: results };
  }

  private async runProvider(
    provider: IWorkItemProvider,
    context: WorkItemProjectContext,
  ): Promise<WorkItemProviderResult> {
    try {
      const result = await provider.listWorkItems(context);
      workItemProviderListTotal.add(1, {
        provider_kind: provider.identity.kind,
        outcome: result.available ? 'available' : 'unavailable',
      });
      return {
        identity: provider.identity,
        capabilities: provider.capabilities,
        ...result,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger?.warn('Work-item provider threw unexpectedly', {
        providerId: provider.identity.id,
        projectId: context.projectId,
        reason,
      });
      workItemProviderListTotal.add(1, {
        provider_kind: provider.identity.kind,
        outcome: 'error',
      });
      return {
        identity: provider.identity,
        capabilities: provider.capabilities,
        available: false,
        items: [],
        reason,
      };
    }
  }
}
