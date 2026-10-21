import {
  ACP_ENGINE_INSTALL_PLATFORMS,
  validateACPEngineDescriptor,
} from '@kontourai/station-contracts/acp';
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

  test('every built-in descriptor validates and has a recipe for each platform', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      () => false,
      () => false,
    ).listAvailable();
    for (const entry of entries) {
      expect(validateACPEngineDescriptor(entry), entry.id).toEqual([]);
      expect(Object.keys(entry.install ?? {}).sort(), entry.id).toEqual(
        [...ACP_ENGINE_INSTALL_PLATFORMS].sort(),
      );
    }
  });

  test('lists the added engines with their launch commands, and never Gemini CLI', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      () => false,
      () => false,
    ).listAvailable();
    const launch = Object.fromEntries(
      entries.map((entry) => [
        entry.id,
        [entry.command, ...(entry.args ?? [])],
      ]),
    );
    expect(launch).toMatchObject({
      antigravity: ['agy_acp_server.par'],
      'factory-droid': ['droid', 'exec', '--output-format', 'acp-daemon'],
      hermes: ['hermes', 'acp'],
      pi: ['pi-acp'],
      cline: ['cline', '--acp'],
      devin: ['devin', 'acp'],
      kimi: ['kimi', 'acp'],
      kilo: ['kilo', 'acp'],
      junie: ['junie', '--acp=true'],
    });
    expect(Object.keys(launch)).not.toContain('gemini');
    expect(entries.map((entry) => entry.command)).not.toContain('gemini');
    // No built-in launches through a package runner that downloads code.
    expect(entries.map((entry) => entry.command)).not.toEqual(
      expect.arrayContaining(['npx', 'uvx']),
    );
  });

  test('Cursor is detected and launched as cursor-agent, never the bare agent alias', () => {
    const asked: string[] = [];
    const entries = new BuiltinACPConnectionRegistryProvider(
      (command) => {
        asked.push(command);
        return command === 'agent';
      },
      () => false,
    ).listAvailable();
    const cursor = entries.find((entry) => entry.id === 'cursor');
    expect(cursor).toMatchObject({ command: 'cursor-agent', detected: false });
    expect(asked).toContain('cursor-agent');
    expect(asked).not.toContain('agent');
  });

  test('descriptions read true whether or not the CLI is installed', () => {
    const entries = new BuiltinACPConnectionRegistryProvider(
      () => false,
      () => false,
    ).listAvailable();
    for (const entry of entries) {
      expect(entry.description, entry.id).not.toMatch(
        /installed|on this machine/i,
      );
    }
  });

  test('the descriptor-only listing runs no host lookup', () => {
    let lookups = 0;
    const entries = new BuiltinACPConnectionRegistryProvider(
      () => {
        lookups += 1;
        return true;
      },
      () => false,
    ).listAvailable({ detect: false });
    expect(lookups).toBe(0);
    expect(entries.every((entry) => entry.detected === undefined)).toBe(true);
    expect(entries.find((entry) => entry.id === 'goose')?.launchEnv).toEqual({
      GOOSE_DISABLE_KEYRING: '1',
    });
  });

  test('a listing cannot mutate the catalogue it came from', () => {
    const provider = new BuiltinACPConnectionRegistryProvider(
      () => false,
      () => false,
    );
    const first = provider.listAvailable();
    const goose = first.find((entry) => entry.id === 'goose');
    if (goose?.launchEnv) goose.launchEnv.GOOSE_DISABLE_KEYRING = '0';
    expect(
      provider.listAvailable().find((entry) => entry.id === 'goose')?.launchEnv,
    ).toEqual({ GOOSE_DISABLE_KEYRING: '1' });
  });
});
