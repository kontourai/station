import { describe, expect, test, vi } from 'vitest';
import { shutdownRuntimeServices } from '../runtime-shutdown.js';

describe('shutdownRuntimeServices', () => {
  test('expires all optional network work once, then continues required teardown', async () => {
    vi.useFakeTimers();
    const schedulerService = { stop: vi.fn(async () => {}) };
    const signals: AbortSignal[] = [];
    const shutdown = shutdownRuntimeServices({
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
      timers: [],
      schedulerService,
      optionalNetworkShutdownBudgetMs: 20,
      optionalNetworkShutdownTasks: ['usage', 'otel'].map((name) => ({
        name,
        shutdown: (signal: AbortSignal) => {
          signals.push(signal);
          return new Promise<void>(() => {});
        },
      })),
      mcpConfigs: new Map(),
      activeAgents: new Map(),
      acpBridge: { shutdown: vi.fn(async () => {}) },
      feedbackService: { stop: vi.fn() },
      voiceService: { stop: vi.fn(async () => {}) },
      terminalWsServer: { stop: vi.fn() },
      terminalService: { dispose: vi.fn(async () => {}) },
      configLoader: { dispose: vi.fn(async () => {}) },
    });
    await vi.advanceTimersByTimeAsync(19);
    expect(signals).toHaveLength(2);
    expect(schedulerService.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(shutdown).resolves.toBeUndefined();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(schedulerService.stop).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  test('stops runtime services, disconnects MCPs, and clears state', async () => {
    const timer = setTimeout(() => {}, 60_000);
    const schedulerService = { stop: vi.fn(async () => {}) };
    const orchestrationService = { shutdown: vi.fn(async () => {}) };
    const sshEnvironmentService = { shutdown: vi.fn(async () => {}) };
    const voltAgent = { shutdown: vi.fn(async () => {}) };
    const activeAgents = new Map([['default', { id: 'default' }]]);
    const mcpConfigs = new Map([
      ['alpha', { disconnect: vi.fn(async () => {}) }],
      ['beta', { disconnect: vi.fn(async () => {}) }],
    ]);
    const retiredMcp = { disconnect: vi.fn(async () => {}) };
    const retiredMcpConfigs = new Set([retiredMcp]);
    const connectionService = { dispose: vi.fn() };
    const modelCatalog = { dispose: vi.fn() };
    const logger = { info: vi.fn(), error: vi.fn() };

    await shutdownRuntimeServices({
      logger,
      timers: [timer],
      schedulerService,
      orchestrationService,
      sshEnvironmentService,
      voltAgent,
      mcpConfigs,
      retiredMcpConfigs,
      activeAgents,
      connectionService,
      modelCatalog,
      acpBridge: { shutdown: vi.fn(async () => {}) },
      feedbackService: { stop: vi.fn() },
      notificationService: { shutdown: vi.fn() },
      voiceService: { stop: vi.fn(async () => {}) },
      terminalWsServer: { stop: vi.fn() },
      terminalService: { dispose: vi.fn(async () => {}) },
      configLoader: { dispose: vi.fn(async () => {}) },
    });

    expect(schedulerService.stop).toHaveBeenCalledTimes(1);
    expect(orchestrationService.shutdown).toHaveBeenCalledTimes(1);
    expect(sshEnvironmentService.shutdown).toHaveBeenCalledTimes(1);
    expect(voltAgent.shutdown).toHaveBeenCalledTimes(1);
    expect(connectionService.dispose).toHaveBeenCalledTimes(1);
    expect(modelCatalog.dispose).toHaveBeenCalledTimes(1);
    expect(mcpConfigs.size).toBe(0);
    expect(retiredMcp.disconnect).toHaveBeenCalledTimes(1);
    expect(retiredMcpConfigs.size).toBe(0);
    expect(activeAgents.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith('Shutdown complete');
  });

  test('awaits notification service shutdown before runtime shutdown resolves', async () => {
    let release!: () => void;
    const notificationShutdown = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notificationService = {
      shutdown: vi.fn(() => notificationShutdown),
    };
    const shutdown = shutdownRuntimeServices({
      logger: { info: vi.fn(), error: vi.fn() },
      timers: [],
      mcpConfigs: new Map(),
      activeAgents: new Map(),
      acpBridge: { shutdown: vi.fn(async () => {}) },
      feedbackService: { stop: vi.fn() },
      notificationService,
      voiceService: { stop: vi.fn(async () => {}) },
      terminalWsServer: { stop: vi.fn() },
      terminalService: { dispose: vi.fn(async () => {}) },
      configLoader: { dispose: vi.fn(async () => {}) },
    });
    let settled = false;
    void shutdown.then(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(notificationService.shutdown).toHaveBeenCalledTimes(1),
    );
    expect(settled).toBe(false);

    release();
    await expect(shutdown).resolves.toBeUndefined();
  });

  test('tolerates route services that were never assigned during partial initialization', async () => {
    const configLoader = { dispose: vi.fn(async () => {}) };

    await expect(
      shutdownRuntimeServices({
        logger: { info: vi.fn(), error: vi.fn() },
        timers: [],
        schedulerService: undefined,
        mcpConfigs: new Map(),
        activeAgents: new Map(),
        acpBridge: { shutdown: vi.fn(async () => {}) },
        feedbackService: { stop: vi.fn() },
        notificationService: undefined,
        voiceService: { stop: vi.fn(async () => {}) },
        terminalWsServer: { stop: vi.fn() },
        terminalService: { dispose: vi.fn(async () => {}) },
        configLoader,
      }),
    ).resolves.toBeUndefined();

    expect(configLoader.dispose).toHaveBeenCalledTimes(1);
  });

  test('stops attached-session polling before it closes orchestration', async () => {
    const calls: string[] = [];

    await shutdownRuntimeServices({
      logger: { info: vi.fn(), error: vi.fn() },
      timers: [],
      attachedSessionFollowService: { stop: () => calls.push('follow') },
      orchestrationService: {
        shutdown: async () => {
          calls.push('orchestration');
        },
      },
      mcpConfigs: new Map(),
      activeAgents: new Map(),
      acpBridge: { shutdown: vi.fn(async () => {}) },
      feedbackService: { stop: vi.fn() },
      voiceService: { stop: vi.fn(async () => {}) },
      terminalWsServer: { stop: vi.fn() },
      terminalService: { dispose: vi.fn(async () => {}) },
      configLoader: { dispose: vi.fn(async () => {}) },
    });

    expect(calls).toEqual(['follow', 'orchestration']);
  });

  test('attempts every cleanup and returns aggregate failures with step identity', async () => {
    const calls: string[] = [];
    const failure = (step: string) => () => {
      calls.push(step);
      throw new Error(`${step} failed`);
    };
    const asyncFailure = (step: string) => async () => failure(step)();
    const mcpConfigs = new Map([
      ['alpha', { disconnect: vi.fn(asyncFailure('mcp:alpha')) }],
    ]);
    const activeAgents = new Map([['default', { id: 'default' }]]);

    const shutdown = shutdownRuntimeServices({
      logger: { info: vi.fn(), error: vi.fn() },
      timers: [],
      schedulerService: { stop: vi.fn(asyncFailure('scheduler')) },
      orchestrationService: {
        shutdown: vi.fn(asyncFailure('orchestration')),
      },
      voltAgent: { shutdown: vi.fn(asyncFailure('voltagent')) },
      mcpConfigs,
      activeAgents,
      connectionService: { dispose: vi.fn(failure('connection')) },
      acpBridge: { shutdown: vi.fn(asyncFailure('acp')) },
      feedbackService: { stop: vi.fn(failure('feedback')) },
      notificationService: { shutdown: vi.fn(failure('notification')) },
      voiceService: { stop: vi.fn(asyncFailure('voice')) },
      mcpUiFrameServer: { close: vi.fn(asyncFailure('mcp-ui-frame')) },
      terminalWsServer: { stop: vi.fn(failure('terminal-ws')) },
      terminalService: { dispose: vi.fn(asyncFailure('terminal')) },
      monitoringEmitter: { flush: vi.fn(asyncFailure('monitoring')) },
      configLoader: { dispose: vi.fn(asyncFailure('config')) },
    });

    await expect(shutdown).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('scheduler'),
        }),
        expect.objectContaining({ message: expect.stringContaining('config') }),
      ]),
    });
    expect(calls).toEqual([
      'scheduler',
      'orchestration',
      'voltagent',
      'mcp:alpha',
      'connection',
      'acp',
      'feedback',
      'notification',
      'voice',
      'mcp-ui-frame',
      'terminal-ws',
      'terminal',
      'monitoring',
      'config',
    ]);
    expect(mcpConfigs.size).toBe(0);
    expect(activeAgents.size).toBe(0);
  });

  test('bounds retired MCP disconnects and retains timed-out configs for retry', async () => {
    vi.useFakeTimers();
    try {
      const configLoader = { dispose: vi.fn(async () => {}) };
      const retiredMcp = {
        disconnect: vi.fn(() => new Promise<void>(() => undefined)),
      };
      const retiredMcpConfigs = new Set([retiredMcp]);
      const shutdown = shutdownRuntimeServices({
        logger: { info: vi.fn(), error: vi.fn() },
        timers: [],
        mcpConfigs: new Map(),
        retiredMcpConfigs,
        activeAgents: new Map(),
        acpBridge: { shutdown: vi.fn(async () => {}) },
        feedbackService: { stop: vi.fn() },
        voiceService: { stop: vi.fn(async () => {}) },
        terminalWsServer: { stop: vi.fn() },
        terminalService: { dispose: vi.fn(async () => {}) },
        configLoader,
      });
      const caughtShutdown = shutdown.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(2_000);

      await expect(caughtShutdown).resolves.toMatchObject({
        name: 'AggregateError',
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('retiredMcpConfigs.0.disconnect'),
          }),
        ]),
      });
      expect(configLoader.dispose).toHaveBeenCalledTimes(1);
      expect(retiredMcp.disconnect).toHaveBeenCalledTimes(1);
      expect(retiredMcpConfigs.has(retiredMcp)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('retains rejected retired MCP disconnects for retry', async () => {
    const failure = new Error('disconnect failed');
    const retiredMcp = {
      disconnect: vi.fn(async () => {
        throw failure;
      }),
    };
    const retiredMcpConfigs = new Set([retiredMcp]);

    await expect(
      shutdownRuntimeServices({
        logger: { info: vi.fn(), error: vi.fn() },
        timers: [],
        mcpConfigs: new Map(),
        retiredMcpConfigs,
        activeAgents: new Map(),
        acpBridge: { shutdown: vi.fn(async () => {}) },
        feedbackService: { stop: vi.fn() },
        voiceService: { stop: vi.fn(async () => {}) },
        terminalWsServer: { stop: vi.fn() },
        terminalService: { dispose: vi.fn(async () => {}) },
        configLoader: { dispose: vi.fn(async () => {}) },
      }),
    ).rejects.toMatchObject({
      name: 'AggregateError',
      errors: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('retiredMcpConfigs.0.disconnect'),
        }),
      ]),
    });

    expect(retiredMcp.disconnect).toHaveBeenCalledTimes(1);
    expect(retiredMcpConfigs.has(retiredMcp)).toBe(true);
  });
});
