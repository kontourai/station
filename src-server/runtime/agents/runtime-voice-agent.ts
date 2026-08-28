import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { Tool } from '@voltagent/core';
import { SC_READ_ONLY_TOOLS } from '../tools/runtime-control-tools.js';

interface RuntimeVoiceAgentConfigLoader {
  agentExists(slug: string): Promise<boolean>;
  updateAgent(
    slug: string,
    spec: {
      name: string;
      prompt: string;
      tools: {
        mcpServers: string[];
        autoApprove: string[];
        available: string[];
      };
    },
  ): Promise<unknown>;
  createAgent(spec: {
    name: string;
    prompt: string;
    tools: {
      mcpServers: string[];
      autoApprove: string[];
      available: string[];
    };
  }): Promise<unknown>;
}

interface RuntimeVoiceLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

interface RuntimeVoiceBootstrapContext {
  agentSpecs: Iterable<AgentSpec>;
  configLoader: RuntimeVoiceAgentConfigLoader;
  createVoltAgentInstance: (slug: string) => Promise<unknown>;
  agentTools: Map<string, Tool<any>[]>;
  logger: RuntimeVoiceLogger;
}

const STATION_VOICE_PROMPT =
  'You are Station Voice, a hands-free voice assistant. You can navigate the app, query data, and perform actions. Be concise — this is voice, not text. Use short sentences. Always confirm before creating, modifying, or deleting anything.';

/**
 * archive#1194 (epic archive#1191, slice B review): `station-voice` is deliberately
 * OUT of scope for the onboarding engine picker's rebind. Voice is a
 * speech-to-speech agent (`voice-session.ts`'s `IS2SProvider`, e.g. Nova
 * Sonic) — it never reads `execution.agentConnectionId` or any engine
 * binding, and its MCP tools are translated into S2S tool definitions, not
 * routed through a text-chat engine. "Binding station-voice to Claude
 * Code/Codex" is a category error (Voice is speech, not text chat); this
 * function stays byte-identical to its pre-#1194 shape.
 */
export function createRuntimeVoiceAgentSpec(agentSpecs: Iterable<AgentSpec>) {
  const mcpServers = Array.from(
    new Set([
      'station-control',
      ...Array.from(agentSpecs).flatMap((spec) => spec.tools?.mcpServers ?? []),
    ]),
  );

  return {
    name: 'Station Voice',
    prompt: STATION_VOICE_PROMPT,
    tools: {
      mcpServers,
      autoApprove: SC_READ_ONLY_TOOLS,
      available: ['*'],
    },
  };
}

export async function bootstrapRuntimeVoiceAgent(
  context: RuntimeVoiceBootstrapContext,
): Promise<void> {
  const voiceSpec = createRuntimeVoiceAgentSpec(context.agentSpecs);

  if (await context.configLoader.agentExists('station-voice')) {
    await context.configLoader.updateAgent('station-voice', voiceSpec);
  } else {
    await context.configLoader.createAgent(voiceSpec);
  }

  try {
    await context.createVoltAgentInstance('station-voice');
    context.logger.info('Bootstrapped station-voice agent', {
      mcpServers: voiceSpec.tools.mcpServers,
      toolCount: context.agentTools.get('station-voice')?.length ?? 0,
    });
  } catch (error) {
    context.logger.warn('Failed to load station-voice tools', { error });
    context.logger.info('Bootstrapped station-voice agent (no tools)', {
      mcpServers: voiceSpec.tools.mcpServers,
    });
  }
}
