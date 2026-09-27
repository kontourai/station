import { describe, expect, test, vi } from 'vitest';
import { SC_AUTO_APPROVED_TOOLS } from '../../tools/runtime-control-tools.js';
import {
  bootstrapRuntimeVoiceAgent,
  createRuntimeVoiceAgentSpec,
} from '../runtime-voice-agent.js';

describe('createRuntimeVoiceAgentSpec', () => {
  test('deduplicates MCP servers and always includes station-control', () => {
    const spec = createRuntimeVoiceAgentSpec([
      { tools: { mcpServers: ['github', 'slack'] } } as any,
      { tools: { mcpServers: ['slack', 'jira'] } } as any,
    ]);

    expect(spec).toEqual({
      name: 'Station Voice',
      prompt: expect.stringContaining('hands-free voice assistant'),
      tools: {
        mcpServers: ['station-control', 'github', 'slack', 'jira'],
        autoApprove: SC_AUTO_APPROVED_TOOLS,
        available: ['*'],
      },
    });
    expect(spec.tools.autoApprove).not.toContain('station-control_*');
    expect(spec.tools.autoApprove).not.toContain(
      'station-control_update_config',
    );
  });
});

describe('bootstrapRuntimeVoiceAgent', () => {
  test.each([
    { exists: false, writes: 'createAgent', skips: 'updateAgent' },
    { exists: true, writes: 'updateAgent', skips: 'createAgent' },
  ] as const)(
    'an existing voice agent: $exists writes through $writes and logs loaded tools',
    async ({ exists, writes, skips }) => {
      const configLoader = {
        agentExists: vi.fn(async () => exists),
        createAgent: vi.fn(async () => {}),
        updateAgent: vi.fn(async () => {}),
      };
      const createVoltAgentInstance = vi.fn(async () => ({}));
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
      };
      const agentTools = new Map([
        ['station-voice', [{ name: 'tool-1' }] as any],
      ]);

      await bootstrapRuntimeVoiceAgent({
        agentSpecs: [{ tools: { mcpServers: ['github'] } } as any],
        configLoader,
        createVoltAgentInstance,
        agentTools,
        logger,
      });

      const spec = expect.objectContaining({
        name: 'Station Voice',
        tools: expect.objectContaining({
          mcpServers: ['station-control', 'github'],
        }),
      });
      expect(configLoader.agentExists).toHaveBeenCalledWith('station-voice');
      expect(configLoader[writes]).toHaveBeenCalledWith(
        ...(writes === 'updateAgent' ? ['station-voice', spec] : [spec]),
      );
      expect(configLoader[skips]).not.toHaveBeenCalled();
      expect(createVoltAgentInstance).toHaveBeenCalledWith('station-voice');
      expect(logger.info).toHaveBeenCalledWith(
        'Bootstrapped station-voice agent',
        expect.objectContaining({
          toolCount: 1,
        }),
      );
    },
  );
});
