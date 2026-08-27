import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock(
  '@kontourai/station-shared/lifecycle-events',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/lifecycle-events')
      >();
    return {
      ...actual,
      acquireFileMutationLock: (path: string) =>
        actual.acquireFileMutationLock(path, {
          birthFingerprint: (pid) => `test-birth-${pid}`,
        }),
    };
  },
);

describe('portability commands', () => {
  let home: string;
  let cwd: string;
  const extraDirs: string[] = [];
  const originalHome = process.env.STATION_HOME;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    home = mkdtempSync(join(tmpdir(), 'station-portability-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'station-portability-cwd-'));
    process.env.STATION_HOME = home;
  });

  afterEach(() => {
    process.env.STATION_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    for (const dir of extraDirs.splice(0, extraDirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export writes an AGENTS.md document with the Station machine block', async () => {
    mkdirSync(join(home, 'config'), { recursive: true });
    mkdirSync(join(home, 'agents', 'writer'), { recursive: true });
    mkdirSync(join(home, 'integrations', 'filesystem'), { recursive: true });

    writeFileSync(
      join(home, 'config', 'app.json'),
      JSON.stringify(
        {
          defaultModel: 'gpt-5.4',
          invokeModel: 'invoke-model',
          structureModel: 'structure-model',
          systemPrompt: 'Be helpful',
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(home, 'agents', 'writer', 'agent.json'),
      JSON.stringify(
        {
          name: 'Writer',
          prompt: 'Write clearly',
          tools: { mcpServers: ['filesystem'] },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(home, 'integrations', 'filesystem', 'integration.json'),
      JSON.stringify(
        {
          id: 'filesystem',
          kind: 'mcp',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { SECRET: 'redacted' },
        },
        null,
        2,
      ),
    );

    const { exportConfig } = await import('../commands/export.js');
    const output = exportConfig({
      format: 'agents-md',
      output: join(cwd, 'AGENTS.md'),
      projectHome: home,
    });

    expect(existsSync(join(cwd, 'AGENTS.md'))).toBe(true);
    expect(output).toContain('<!-- STATION:EXPORT:START -->');
    expect(output).toContain('## Workspace Guidance');
    expect(output).toContain('defaultModel');
  });

  test('import restores canonical config, writes notes, and appends import ledger', async () => {
    const agentsMdPath = join(cwd, 'AGENTS.md');
    writeFileSync(
      agentsMdPath,
      `# AGENTS.md

## Workspace Guidance

Imported prose that should become notes.

<!-- STATION:EXPORT:START -->
\`\`\`json
${JSON.stringify(
  {
    kind: 'station-agents-md',
    version: 1,
    generatedAt: '2026-04-12T06:00:00.000Z',
    guidance: {
      workspace: {
        systemPrompt: 'Imported system prompt',
      },
      agents: [
        {
          slug: 'assistant',
          spec: { name: 'Assistant', prompt: 'Help users' },
        },
      ],
      integrations: [{ id: 'codex', transport: 'stdio', command: 'codex' }],
    },
    losses: [
      {
        code: 'degraded-field',
        scope: 'document',
        path: 'notes',
        message: 'Example warning',
        severity: 'warning',
      },
    ],
  },
  null,
  2,
)}
\`\`\`
<!-- STATION:EXPORT:END -->
`,
      'utf-8',
    );

    const { importConfig } = await import('../commands/import.js');
    const result = await importConfig(agentsMdPath, { projectHome: home });

    expect(
      JSON.parse(readFileSync(join(home, 'config', 'app.json'), 'utf-8'))
        .systemPrompt,
    ).toBe('Imported system prompt');
    expect(
      JSON.parse(
        readFileSync(join(home, 'agents', 'assistant', 'agent.json'), 'utf-8'),
      ).prompt,
    ).toBe('Help users');
    expect(
      JSON.parse(
        readFileSync(
          join(home, 'integrations', 'codex', 'integration.json'),
          'utf-8',
        ),
      ).command,
    ).toBe('codex');
    expect(result.notesPath).toBeDefined();
    expect(readFileSync(result.notesPath!, 'utf-8')).toContain(
      'Imported prose that should become notes.',
    );
    expect(
      JSON.parse(readFileSync(result.ledgerPath, 'utf-8')).sourceFormat,
    ).toBe('agents-md');
  });

  test('export -> import -> export preserves the structured Station document', async () => {
    const sourceHome = mkdtempSync(
      join(tmpdir(), 'station-portability-source-'),
    );
    const targetHome = mkdtempSync(
      join(tmpdir(), 'station-portability-target-'),
    );
    const exportedPath = join(cwd, 'AGENTS.md');
    extraDirs.push(sourceHome, targetHome);

    mkdirSync(join(sourceHome, 'config'), { recursive: true });
    mkdirSync(join(sourceHome, 'agents', 'assistant'), { recursive: true });
    mkdirSync(join(sourceHome, 'integrations', 'codex'), { recursive: true });

    writeFileSync(
      join(sourceHome, 'config', 'app.json'),
      JSON.stringify(
        {
          invokeModel: 'invoke-model',
          structureModel: 'structure-model',
          systemPrompt: 'Imported system prompt',
          approvalGuardian: { enabled: true, mode: 'review' },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(sourceHome, 'agents', 'assistant', 'agent.json'),
      JSON.stringify({ name: 'Assistant', prompt: 'Help users' }, null, 2),
    );
    writeFileSync(
      join(sourceHome, 'integrations', 'codex', 'integration.json'),
      JSON.stringify(
        {
          id: 'codex',
          kind: 'mcp',
          transport: 'stdio',
          command: 'codex',
        },
        null,
        2,
      ),
    );

    const { exportConfig } = await import('../commands/export.js');
    const { importConfig } = await import('../commands/import.js');

    const first = exportConfig({
      format: 'agents-md',
      output: exportedPath,
      projectHome: sourceHome,
    });
    await importConfig(exportedPath, { projectHome: targetHome });
    const second = exportConfig({
      format: 'agents-md',
      projectHome: targetHome,
    });

    expect(second).toContain('Imported system prompt');
    expect(second).toContain('<!-- STATION:EXPORT:START -->');

    const firstDocument = JSON.parse(
      first.match(/```json\s*([\s\S]*?)\s*```/)![1],
    );
    const secondDocument = JSON.parse(
      second.match(/```json\s*([\s\S]*?)\s*```/)![1],
    );

    expect(secondDocument.guidance).toEqual(firstDocument.guidance);
    expect(secondDocument.losses).toEqual([]);
  });

  test('exports and imports Claude Desktop MCP config', async () => {
    mkdirSync(join(home, 'integrations', 'github'), { recursive: true });
    writeFileSync(
      join(home, 'integrations', 'github', 'integration.json'),
      JSON.stringify(
        {
          id: 'github',
          kind: 'mcp',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
        null,
        2,
      ),
    );

    const { exportConfig } = await import('../commands/export.js');
    const { importConfig } = await import('../commands/import.js');
    const outputPath = join(cwd, 'claude_desktop_config.json');

    const exported = exportConfig({
      format: 'claude-desktop',
      output: outputPath,
      projectHome: home,
    });

    expect(JSON.parse(exported)).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
        },
      },
    });

    const targetHome = mkdtempSync(join(tmpdir(), 'station-claude-import-'));
    extraDirs.push(targetHome);
    const result = await importConfig(outputPath, { projectHome: targetHome });

    expect(
      JSON.parse(
        readFileSync(
          join(targetHome, 'integrations', 'github', 'integration.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({
      id: 'github',
      kind: 'mcp',
      transport: 'stdio',
      command: 'npx',
    });
    expect(result.integrationCount).toBe(1);
  });

  test('CLI import stores integration env outside integration.json and export withholds it by default', async () => {
    const source = join(cwd, 'secret-claude.json');
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          github: {
            command: 'github-mcp',
            env: { TOKEN: 'cli-import-secret' },
          },
        },
      }),
    );
    const { importConfig } = await import('../commands/import.js');
    const { exportConfig } = await import('../commands/export.js');
    await importConfig(source, { projectHome: home });
    const disk = readFileSync(
      join(home, 'integrations', 'github', 'integration.json'),
      'utf8',
    );
    expect(disk).not.toContain('cli-import-secret');
    const redacted = exportConfig({
      format: 'claude-desktop',
      projectHome: home,
    });
    expect(redacted).not.toContain('cli-import-secret');
    expect(redacted).toContain('requiredEnvNames');
    expect(redacted).toContain('TOKEN');
    const redactedPath = join(cwd, 'redacted-claude.json');
    writeFileSync(redactedPath, redacted);
    const hint = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      importConfig(redactedPath, { projectHome: home }),
    ).resolves.toBeDefined();
    expect(hint).toHaveBeenCalledWith(
      expect.stringContaining('untrusted hint only'),
    );
    const included = exportConfig({
      format: 'claude-desktop',
      projectHome: home,
      includeSecrets: true,
    });
    expect(included).toContain('cli-import-secret');
    const includedPath = join(cwd, 'included-claude.json');
    const includedHome = join(cwd, 'included-home');
    extraDirs.push(includedHome);
    writeFileSync(includedPath, included);
    await expect(
      importConfig(includedPath, { projectHome: includedHome }),
    ).resolves.toBeDefined();
  });

  test('bounds and sanitizes untrusted requiredEnvNames warnings', async () => {
    const source = join(cwd, 'hostile-hints.json');
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          hostile: {
            command: 'hostile',
            requiredEnvNames: [
              `SAFE\u202eSPOOF`,
              42,
              ...Array.from({ length: 100 }, (_, index) => `TOKEN_${index}`),
            ],
          },
        },
      }),
    );
    const { importConfig } = await import('../commands/import.js');
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    await importConfig(source, { projectHome: home });
    const message = String(warning.mock.calls.at(-1)?.[0]);
    expect(message).not.toContain('\u202e');
    expect(message).toContain('SAFESPOOF, 42');
    expect(message).not.toContain('TOKEN_14');
    expect(message.length).toBeLessThan(1400);
  });

  test('refuses a traversal integration id before any path write', async () => {
    const source = join(cwd, 'traversal.json');
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: { '../../escape': { command: 'hostile' } },
      }),
    );
    const { importConfig } = await import('../commands/import.js');
    await expect(importConfig(source, { projectHome: home })).rejects.toThrow(
      /Invalid Claude Desktop tool-server id.*\.\.\/\.\.\/escape/,
    );
    expect(existsSync(join(home, '..', 'escape'))).toBe(false);
    expect(existsSync(join(home, 'escape'))).toBe(false);
    expect(existsSync(join(home, 'integrations'))).toBe(false);
  });

  test('validates every credential before writing any credential record', async () => {
    const source = join(cwd, 'atomic-validation.json');
    writeFileSync(
      source,
      '{"mcpServers":{"atomic":{"command":"server","env":{"SAFE":"secret","__proto__":"x"}}}}',
    );
    const { importConfig } = await import('../commands/import.js');
    await expect(importConfig(source, { projectHome: home })).rejects.toThrow(
      /Invalid tool-server credential env name.*__proto__/,
    );
    const { ToolServerCredentialStore } = await import(
      '@kontourai/station-shared/tool-server-credential-store'
    );
    const store = new ToolServerCredentialStore(home);
    expect(() => store.get('atomic', 'SAFE')).toThrow(
      'Tool-server credential is missing',
    );
    expect(
      existsSync(join(home, 'integrations', 'atomic', 'integration.json')),
    ).toBe(false);
  });

  test('CLI import preserves stored env names omitted by a partial artifact', async () => {
    const first = join(cwd, 'first.json');
    const second = join(cwd, 'second.json');
    writeFileSync(
      first,
      JSON.stringify({
        mcpServers: {
          github: { command: 'github', env: { TOKEN_A: 'a', TOKEN_B: 'b' } },
        },
      }),
    );
    writeFileSync(
      second,
      JSON.stringify({
        mcpServers: {
          github: { command: 'github', env: { TOKEN_A: 'new-a' } },
        },
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { importConfig } = await import('../commands/import.js');
    await importConfig(first, { projectHome: home });
    await importConfig(second, { projectHome: home });
    const { ToolServerCredentialStore } = await import(
      '@kontourai/station-shared/tool-server-credential-store'
    );
    const store = new ToolServerCredentialStore(home);
    expect(store.get('github', 'TOKEN_A')).toBe('new-a');
    expect(store.get('github', 'TOKEN_B')).toBe('b');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        'preserved existing environment variables for github: TOKEN_B',
      ),
    );
  });

  test('export resolves credentials with directory identity, not manifest id', async () => {
    const { ToolServerCredentialStore } = await import(
      '@kontourai/station-shared/tool-server-credential-store'
    );
    mkdirSync(join(home, 'integrations', 'a'), { recursive: true });
    writeFileSync(
      join(home, 'integrations', 'a', 'integration.json'),
      JSON.stringify({
        id: 'a:b',
        kind: 'mcp',
        command: 'server',
        storedEnvNames: ['TOKEN'],
      }),
    );
    const store = new ToolServerCredentialStore(home);
    await store.upsert('a', 'TOKEN', 'directory-owned');
    await store.upsert('a:b', 'TOKEN', 'manifest-owned');
    const { exportConfig } = await import('../commands/export.js');
    const output = exportConfig({
      format: 'claude-desktop',
      projectHome: home,
      includeSecrets: true,
    });
    expect(output).toContain('directory-owned');
    expect(output).not.toContain('manifest-owned');
  });

  test('exports binding-backed environment hints without binding ids in either secret mode', async () => {
    mkdirSync(join(home, 'integrations', 'github'), { recursive: true });
    writeFileSync(
      join(home, 'integrations', 'github', 'integration.json'),
      JSON.stringify({
        id: 'github',
        kind: 'mcp',
        command: 'server',
        secretEnvRefs: { TOKEN: 'operator-token' },
      }),
    );
    const { listIntegrations } = await import('../commands/portability-io.js');
    for (const includeSecrets of [false, true]) {
      const [integration] = listIntegrations(home, includeSecrets);
      expect(integration.requiredEnvNames).toContain('TOKEN');
      expect(integration).not.toHaveProperty('secretEnvRefs');
      expect(JSON.stringify(integration)).not.toContain('operator-token');
    }
  });

  test('refuses a portable artifact that attempts to import a secret binding ref', async () => {
    const { validateIntegrationImport } = await import(
      '../commands/portability-io.js'
    );
    expect(() =>
      validateIntegrationImport('github', {
        id: 'github',
        kind: 'mcp',
        secretEnvRefs: { TOKEN: 'operator-token' },
      }),
    ).toThrow('cannot import secret binding references');
  });

  test('--include-secrets warns at runtime and writes a new output with mode 0600', async () => {
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outputPath = join(cwd, 'secret-export.json');
    const { exportConfig } = await import('../commands/export.js');
    exportConfig({
      format: 'claude-desktop',
      projectHome: home,
      includeSecrets: true,
      output: outputPath,
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('ordinary legacy credentials as plaintext'),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('never exports secret binding references'),
    );
    if (process.platform !== 'win32')
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(() =>
      exportConfig({
        format: 'claude-desktop',
        projectHome: home,
        includeSecrets: true,
        output: outputPath,
      }),
    ).toThrow('Refusing to overwrite');
  });

  test('import rejects a literal withheld marker', async () => {
    const source = join(cwd, 'withheld.json');
    writeFileSync(
      source,
      JSON.stringify({
        mcpServers: {
          github: { command: 'github', env: { TOKEN: '[WITHHELD:TOKEN]' } },
        },
      }),
    );
    const { importConfig } = await import('../commands/import.js');
    await expect(importConfig(source, { projectHome: home })).rejects.toThrow(
      'Refusing to import withheld credential marker',
    );
  });

  test('records degraded transport fidelity when importing URL-based Claude Desktop MCP servers', async () => {
    const configPath = join(cwd, 'claude_desktop_config.json');
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            linear: {
              url: 'https://mcp.example.com/linear',
            },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const { importConfig } = await import('../commands/import.js');
    const result = await importConfig(configPath, { projectHome: home });
    const ledger = JSON.parse(readFileSync(result.ledgerPath, 'utf-8'));

    expect(
      JSON.parse(
        readFileSync(
          join(home, 'integrations', 'linear', 'integration.json'),
          'utf-8',
        ),
      ),
    ).toMatchObject({
      id: 'linear',
      kind: 'mcp',
      transport: 'streamable-http',
      endpoint: 'https://mcp.example.com/linear',
    });
    expect(ledger.degradedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'degraded-field',
          path: 'linear.transport',
        }),
      ]),
    );
  });
});
