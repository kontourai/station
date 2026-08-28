import { mkdtempSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadStrandsTools } from '../../frameworks/strands-tool-loader.js';
import { createBuiltinTool } from '../../mcp/mcp-manager.js';
import {
  createBuiltinVendedToolDef,
  listBuiltinVendedRegistryItems,
} from '../vended-tool-compat.js';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs
      .splice(0, cleanupDirs.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('vended tool compatibility', () => {
  test('lists the shared builtin tools in the registry catalog', () => {
    expect(listBuiltinVendedRegistryItems().map((item) => item.id)).toEqual([
      'bash',
      'file-editor',
      'http-request',
      'notebook',
      'render-component',
    ]);
  });

  describe('render_component (chat-native UIBlock producer)', () => {
    function makeTool() {
      const toolDef = createBuiltinVendedToolDef('render-component');
      return createBuiltinTool('agent-ui', toolDef!, { warn: vi.fn() } as any);
    }

    test('exposes no filesystem/network permissions (pure data transform)', () => {
      expect(createBuiltinVendedToolDef('render-component')?.permissions).toBe(
        undefined,
      );
    });

    test('returns a validated card block as { uiBlock } output', async () => {
      const tool = makeTool();
      expect(tool?.name).toBe('render_component');
      await expect(
        tool?.execute?.({
          type: 'card',
          title: 'Status',
          body: 'All gates green',
          tone: 'success',
          fields: [
            { label: 'Tests', value: '1875' },
            { label: 'bad', value: 42 },
          ],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
        }),
      ).resolves.toEqual({
        uiBlock: {
          type: 'card',
          title: 'Status',
          body: 'All gates green',
          tone: 'success',
          // the non-string field value is dropped by validation
          fields: [{ label: 'Tests', value: '1875' }],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
          provenanceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          attestationState: 'attested',
        },
      });
    });

    test('refuses a data-bearing card block with no derivedFrom', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'card',
          body: 'All gates green',
          fields: [{ label: 'Tests', value: '1875' }],
        }),
      ).rejects.toThrow(/requires 'derivedFrom' source references/);
    });

    test('refuses a data-bearing block that self-declares decorative attestation', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'card',
          body: 'All gates green',
          fields: [{ label: 'Tests', value: '1875' }],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
          attestationState: 'decorative',
        }),
      ).rejects.toThrow(/cannot declare itself 'decorative'/);
    });

    test('returns a card block with no fields as decorative, no derivedFrom required', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'card',
          body: 'All gates green',
        }),
      ).resolves.toEqual({
        uiBlock: {
          type: 'card',
          title: undefined,
          body: 'All gates green',
          tone: undefined,
          fields: undefined,
          derivedFrom: undefined,
          provenanceDigest: undefined,
          attestationState: 'decorative',
        },
      });
    });

    test('returns a validated table block, coercing odd cells to strings', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'table',
          columns: ['Name', 'Value'],
          rows: [['Coverage', 98], ['Flag', null], 'not-a-row'],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
        }),
      ).resolves.toEqual({
        uiBlock: {
          type: 'table',
          title: undefined,
          caption: undefined,
          columns: ['Name', 'Value'],
          rows: [
            ['Coverage', 98],
            ['Flag', null],
          ],
          derivedFrom: [{ kind: 'toolCallId', toolCallId: 'call_1' }],
          provenanceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
          attestationState: 'attested',
        },
      });
    });

    test('refuses a data-bearing table block with no derivedFrom', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'table',
          columns: ['Name'],
          rows: [['Coverage']],
        }),
      ).rejects.toThrow(/requires 'derivedFrom' source references/);
    });

    test('returns a validated form block, keeping only valid fields', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'form',
          title: 'Approve gate',
          submitLabel: 'Approve',
          fields: [
            {
              name: 'decision',
              label: 'Decision',
              type: 'select',
              options: ['approve', 'reject'],
            },
            { name: 'note', label: 'Note', type: 'textarea', required: true },
            { name: 'bad', label: 'Bad', type: 'range' },
          ],
        }),
      ).resolves.toEqual({
        uiBlock: {
          type: 'form',
          title: 'Approve gate',
          description: undefined,
          submitLabel: 'Approve',
          fields: [
            {
              name: 'decision',
              label: 'Decision',
              type: 'select',
              required: undefined,
              placeholder: undefined,
              defaultValue: undefined,
              options: ['approve', 'reject'],
            },
            {
              name: 'note',
              label: 'Note',
              type: 'textarea',
              required: true,
              placeholder: undefined,
              defaultValue: undefined,
              options: undefined,
            },
          ],
          // form fields are input definitions, not asserted facts — always
          // decorative, no derivedFrom required (archive#1399).
          derivedFrom: undefined,
          provenanceDigest: undefined,
          attestationState: 'decorative',
        },
      });
    });

    test('throws when a form block has no valid fields', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'form',
          fields: [{ name: 'x', label: 'X', type: 'range' }],
        }),
      ).rejects.toThrow(/requires at least one valid field/);
    });

    test('returns a validated code block', async () => {
      const tool = makeTool();
      await expect(
        tool?.execute?.({
          type: 'code',
          language: 'bash',
          code: 'npm run verify:static',
        }),
      ).resolves.toEqual({
        uiBlock: {
          type: 'code',
          title: undefined,
          caption: undefined,
          language: 'bash',
          code: 'npm run verify:static',
          // code is inert text, not structured data — always decorative
          // (archive#1399).
          derivedFrom: undefined,
          provenanceDigest: undefined,
          attestationState: 'decorative',
        },
      });
    });

    test('throws a descriptive error the agent can act on for invalid input', async () => {
      const tool = makeTool();
      await expect(tool?.execute?.({ type: 'card' })).rejects.toThrow(
        /requires a string 'body'/,
      );
      await expect(
        tool?.execute?.({ type: 'table', columns: [] }),
      ).rejects.toThrow(/non-empty string 'columns'/);
      await expect(tool?.execute?.({ type: 'spreadsheet' })).rejects.toThrow(
        /unknown block type 'spreadsheet'/,
      );
    });
  });

  test('VoltAgent built-in tool wrapper uses the shared notebook implementation', async () => {
    const toolDef = createBuiltinVendedToolDef('notebook');
    const tool = createBuiltinTool('agent-a', toolDef!, {
      warn: vi.fn(),
    } as any);

    expect(tool?.name).toBe('notebook');
    await expect(
      tool?.execute?.({ mode: 'create', name: 'plan', newStr: '# Plan' }),
    ).resolves.toContain('Created notebook');
    await expect(
      tool?.execute?.({ mode: 'read', name: 'plan' }),
    ).resolves.toContain('# Plan');
  });

  test('Strands loader pulls built-in tools through the shared implementation path', async () => {
    const toolDef = createBuiltinVendedToolDef('notebook');
    const tools = await loadStrandsTools({
      slug: 'agent-b',
      spec: {
        name: 'Agent B',
        prompt: 'Test',
        tools: { mcpServers: ['notebook'] },
      },
      opts: {
        configLoader: {
          loadIntegration: vi.fn().mockResolvedValue(toolDef),
        },
        mcpConnectionStatus: new Map(),
        integrationMetadata: new Map(),
        toolNameMapping: new Map(),
        toolNameReverseMapping: new Map(),
        logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
      } as any,
      state: {
        mcpClients: new Map(),
        agentMcpClients: new Map(),
      },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('notebook');
    await expect(
      tools[0]?.execute({ mode: 'create', name: 'checklist', newStr: '- one' }),
    ).resolves.toContain('Created notebook');
    await expect(
      tools[0]?.execute({ mode: 'read', name: 'checklist' }),
    ).resolves.toContain('- one');
  });

  test('bash preserves shell session state across calls', async () => {
    const toolDef = createBuiltinVendedToolDef('bash');
    const tool = createBuiltinTool('agent-shell', toolDef!, {} as any);

    await expect(
      tool?.execute?.({ mode: 'execute', command: 'export TEST_VALUE=hello' }),
    ).resolves.toEqual(
      expect.objectContaining({
        output: '',
      }),
    );

    await expect(
      tool?.execute?.({ mode: 'execute', command: 'echo $TEST_VALUE' }),
    ).resolves.toEqual(
      expect.objectContaining({
        output: 'hello',
      }),
    );
  });

  test('file editor creates and updates files through the shared implementation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'station-vended-file-editor-'));
    cleanupDirs.push(dir);
    const filePath = join(dir, 'notes.txt');
    const toolDef = createBuiltinVendedToolDef('file-editor');
    const tool = createBuiltinTool('agent-files', toolDef!, {} as any);

    await expect(
      tool?.execute?.({
        command: 'create',
        path: filePath,
        file_text: 'Hello\nWorld',
      }),
    ).resolves.toContain('File created successfully');

    await expect(
      tool?.execute?.({
        command: 'str_replace',
        path: filePath,
        old_str: 'World',
        new_str: 'Station',
      }),
    ).resolves.toContain('has been edited');

    await expect(readFile(filePath, 'utf-8')).resolves.toBe('Hello\nStation');
  });

  test('http request executes real network calls through the shared implementation', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;

    try {
      const toolDef = createBuiltinVendedToolDef('http-request');
      const tool = createBuiltinTool('agent-http', toolDef!, {} as any);

      await expect(
        tool?.execute?.({
          method: 'GET',
          url: `http://127.0.0.1:${port}/health`,
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: 200,
          body: '{"ok":true}',
        }),
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
