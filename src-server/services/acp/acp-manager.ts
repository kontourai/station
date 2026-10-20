import type { SetProviderRequest } from '@agentclientprotocol/sdk';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  type AcpApprovalControl,
  acpApprovalControl,
} from '@kontourai/station-contracts/engine-capability-matrix';
import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';
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

  // Chat sessions moved to the orchestration adapter (archive#149), so the
  // manager needs only what probing and connection management use.
  constructor(
    private logger: any,
    private managedWorkspaceHomeDir: string,
    private eventBus?: {
      emit: (event: ServerEventName, data?: Record<string, unknown>) => void;
    },
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
    // startAll runs again on every registry refresh; a stale timer would keep
    // sweeping alongside the new one.
    if (this.probeTimer) clearInterval(this.probeTimer);
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

  async setProvider(id: string, input: SetProviderRequest): Promise<void> {
    const probe = this.probes.get(id);
    if (!probe) throw new Error(`ACP connection '${id}' is not active.`);
    await probe.setProvider(input);
  }

  assertProviderSupported(
    id: string,
    providerId: string,
    apiType: string,
  ): void {
    const probe = this.probes.get(id);
    if (!probe) throw new Error(`ACP connection '${id}' is not active.`);
    probe.assertProviderSupported(providerId, apiType);
  }

  async disableProvider(id: string, providerId: string): Promise<void> {
    const probe = this.probes.get(id);
    if (!probe) throw new Error(`ACP connection '${id}' is not active.`);
    await probe.disableProvider(providerId);
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

  /**
   * #3290: who decides which of this connection's actions ask, from the
   * command it launches. `undefined` for a connection this manager does not
   * hold (not configured, or disabled).
   */
  approvalControl(connectionId: string): AcpApprovalControl | undefined {
    const config = this.configs.get(connectionId);
    return config ? acpApprovalControl(config.command) : undefined;
  }
}
