import { describe, expect, test } from 'vitest';
import { BuiltinACPConnectionRegistryProvider } from '../llm/defaults.js';

describe('BuiltinACPConnectionRegistryProvider', () => {
  test('lists Kiro, Cursor, and OpenCode as `<cmd> acp` connections', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      (command) => command === 'kiro-cli',
      () => false,
    ).listAvailable();
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));

    expect(byId.kiro).toMatchObject({
      command: 'kiro-cli',
      args: ['acp'],
      detected: true,
    });
    expect(byId.cursor).toMatchObject({
      name: 'Cursor',
      command: 'cursor-agent',
      args: ['acp'],
      detected: false,
    });
    expect(byId.opencode).toMatchObject({
      name: 'OpenCode',
      command: 'opencode',
      args: ['acp'],
      detected: false,
    });
  });

  test('lists Goose, Qwen Code, Copilot, Grok Build, and Mistral Vibe with their ACP launch commands', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      (command) => command === 'goose',
      () => false,
    ).listAvailable();
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]));

    expect(byId.goose).toMatchObject({
      name: 'Goose',
      command: 'goose',
      args: ['acp'],
      detected: true,
    });
    expect(byId['qwen-code']).toMatchObject({
      name: 'Qwen Code',
      command: 'qwen',
      args: ['--acp'],
      detected: false,
    });
    expect(byId.copilot).toMatchObject({
      name: 'GitHub Copilot',
      command: 'copilot',
      args: ['--acp'],
      detected: false,
    });
    expect(byId['grok-build']).toMatchObject({
      name: 'Grok Build',
      command: 'grok',
      args: ['agent', 'stdio'],
      detected: false,
    });
    expect(byId['mistral-vibe']).toMatchObject({
      name: 'Mistral Vibe',
      command: 'vibe-acp',
      args: [],
      detected: false,
    });
  });

  test('disables host discovery in deterministic first-run mode', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      () => true,
      () => true,
    ).listAvailable();

    expect(entries.every((entry) => entry.detected === false)).toBe(true);
  });
});
