import { describe, expect, test } from 'vitest';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { BedrockAdapter } from '../adapters/bedrock-adapter.js';
import { ClaudeAdapter } from '../adapters/claude-adapter.js';
import { CodexAdapter } from '../adapters/codex-adapter.js';
import { MuseAdapter } from '../adapters/muse-adapter.js';
import { OllamaAdapter } from '../adapters/ollama-adapter.js';
import { StationAgentAdapter } from '../adapters/station-agent-adapter.js';

describe('built-in continuity declarations', () => {
  test('every built-in adapter declares an explicit continuity tier', () => {
    const adapters = [
      new AcpAdapter({ connections: [] } as any),
      new BedrockAdapter(),
      new ClaudeAdapter({} as any),
      new CodexAdapter({} as any),
      new MuseAdapter({} as any),
      new OllamaAdapter(),
      new StationAgentAdapter({
        eventBus: {
          subscribe() {
            return () => {};
          },
        },
      } as any),
    ];
    for (const adapter of adapters) {
      expect(adapter.metadata.continuity).toMatchObject({
        resume: expect.any(String),
        fork: expect.any(String),
        rewind: expect.any(String),
      });
    }
  });

  test('optional continuity survives JSON and older descriptors omit it honestly', () => {
    const current = JSON.parse(
      JSON.stringify({
        continuity: {
          resume: 'same-session',
          fork: 'replay-seed',
          rewind: 'none',
        },
      }),
    );
    const older = JSON.parse(JSON.stringify({}));
    expect(current.continuity).toEqual({
      resume: 'same-session',
      fork: 'replay-seed',
      rewind: 'none',
    });
    expect(
      older.continuity ?? { resume: 'none', fork: 'none', rewind: 'none' },
    ).toEqual({ resume: 'none', fork: 'none', rewind: 'none' });
  });
});
