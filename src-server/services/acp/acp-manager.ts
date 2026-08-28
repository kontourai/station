import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
import type { FileMemoryAdapter } from '../../adapters/file/memory-adapter.js';
import { MonitoringEmitter } from '../../monitoring/emitter.js';
import { ApprovalRegistry } from '../approvals/approval-registry.js';
import {
  addACPManagerConnection,
  reconnectACPManagerConnection,
  removeACPManagerConnection,
  runACPManagerProbes,
  shutdownACPManager,
} from './acp-manager-orchestration.js';
import { getACPManagerStatus } from './acp-manager-view.js';
import { ACPProbe, type ACPProbeInitiator } from './acp-probe.js';

/**
 * Probe architecture: periodic connect→discover→disconnect per ACP source.
 * Caches modes and capabilities for the Connections Hub. Chat turns
 * for ACP connections are driven by the canonical orchestration adapter
 * (`providers/adapters/acp-adapter.ts`), not by this class.
 */
export class ACPManager {
  private probes = new Map<string, ACPProbe>();
  private configs = new Map<string, ACPConnectionConfig>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  // The chat-session substrate that consumed approvalRegistry/memoryAdapters/
  // usageAggregatorRef/monitoringEvents/persistEvent/monitoringEmitter was
  // retired (archive#149) — these positional params are kept only so the
  // runtime-service-bootstrap.ts call site (unchanged in shape per archive#149's
  // plan) doesn't need edits. Probing/connection-management uses only
  // logger/managedWorkspaceHomeDir/eventBus.
  constructor(
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private approvalRegistry: ApprovalRegistry,
    private logger: any,
    private managedWorkspaceHomeDir: string,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private memoryAdapters?: Map<string, FileMemoryAdapter>,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private createMemoryAdapter?: (slug: string) => FileMemoryAdapter,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private usageAggregatorRef?: { get: () => any },
    private eventBus?: {
      emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
    },
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private monitoringEvents?: import('node:events').EventEmitter,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private persistEvent?: (event: any) => Promise<void>,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: kept for call-site signature stability, see class-level comment
    private monitoringEmitter?: MonitoringEmitter,
  ) {}

  /**
   * archive#3404: `initiator` defaults to `'request'` because this is called
   * from BOTH a fire-and-forget boot task (`startRuntimeACPConnections`,
   * where nothing is waiting and a cold engine start is exactly the case
   * archive#3404 is about) and a registry install's mode refresh, which an HTTP
   * client is awaiting. Only the boot caller passes `'background'`.
   */
  async startAll(
    configs: ACPConnectionConfig[],
    initiator: ACPProbeInitiator = 'request',
  ): Promise<void> {
    await Promise.all(
      configs.map((config) => this.addConnection(config, initiator)),
    );
    this.probeTimer = setInterval(() => void this.runProbes(), 60_000);
  }

  private async runProbes(): Promise<void> {
    await runACPManagerProbes({
      sessions: new Map(),
      probes: this.probes,
      eventBus: this.eventBus,
      getAvailableConnectionCount: () =>
        Array.from(this.probes.values()).filter((probe) => probe.isAvailable())
          .length,
    });
  }

  async addConnection(
    config: ACPConnectionConfig,
    initiator: ACPProbeInitiator = 'request',
  ): Promise<boolean> {
    return addACPManagerConnection({
      config,
      initiator,
      probes: this.probes,
      configs: this.configs,
      logger: this.logger,
      managedWorkspaceHomeDir: this.managedWorkspaceHomeDir,
      eventBus: this.eventBus,
      removeConnection: (id) => this.removeConnection(id),
    });
  }

  async removeConnection(id: string): Promise<void> {
    await removeACPManagerConnection({
      id,
      probes: this.probes,
      configs: this.configs,
    });
  }

  async reconnect(id: string): Promise<boolean> {
    return reconnectACPManagerConnection({
      id,
      probes: this.probes,
      eventBus: this.eventBus,
    });
  }

  async shutdown(): Promise<void> {
    const probeTimer = this.probeTimer;
    this.probeTimer = null;
    const timers = await shutdownACPManager({
      probeTimer,
      cullTimer: null,
      probes: this.probes,
      configs: this.configs,
    });
    this.probeTimer = timers.probeTimer;
  }

  isConnected(): boolean {
    return Array.from(this.probes.values()).some((probe) =>
      probe.isAvailable(),
    );
  }

  /**
   * archive#1549: the return type is now taken FROM `getACPManagerStatus`
   * rather than re-declared here. The hand-written copy had already drifted
   * — it omitted the `capabilities` field archive#895 wave B started emitting, so
   * every caller typed through this method saw a shape narrower than what
   * actually crossed the boundary at runtime, and a new field would have
   * been invisible again. One declaration, at the producer.
   */
  getStatus(): ReturnType<typeof getACPManagerStatus> {
    return getACPManagerStatus(this.probes, this.configs, 0);
  }
}
