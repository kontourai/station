import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENTS = [
  'src-ui/src/components/coding-layout/TerminalPanel.tsx',
  'src-ui/src/providers/voice/NovaVoiceSessionAdapter.ts',
];

describe('browser websocket credential handling', () => {
  it.each(CLIENTS)(
    '%s keeps credentials out of URLs and subprotocols',
    (path) => {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      const websocketCalls =
        source.match(/new\s+WebSocket\s*\([\s\S]*?\)/g) ?? [];

      expect(websocketCalls.length).toBeGreaterThan(0);
      for (const call of websocketCalls) {
        expect(call).not.toMatch(/credential|authorization|bearer/i);
      }
    },
  );
});
