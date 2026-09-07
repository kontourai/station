import { describe, expect, test } from 'vitest';
import {
  MAX_TOOL_REQUEST_PREVIEW_LENGTH,
  TOOL_REQUEST_ARGS_FIELDS,
  toolRequestDisplayName,
  toolRequestFromPayload,
  toolRequestPreview,
  toolRequestPreviewFromPayload,
} from '../tool-request-preview.js';

describe('toolRequestPreview', () => {
  describe('names what the call will do, per tool family', () => {
    const families: Array<[string, string, unknown, string]> = [
      [
        'Bash',
        'the command',
        { command: 'touch /tmp/probe', description: 'make a file' },
        'touch /tmp/probe',
      ],
      [
        'Edit',
        'the file being changed',
        { file_path: '/repo/src/index.ts', old_string: 'a', new_string: 'b' },
        '/repo/src/index.ts',
      ],
      [
        'Write',
        'the file being written',
        { filePath: '/repo/notes.md', content: 'long body' },
        '/repo/notes.md',
      ],
      [
        'NotebookEdit',
        'the notebook',
        { notebook_path: '/repo/run.ipynb', new_source: 'print(1)' },
        '/repo/run.ipynb',
      ],
      [
        'Read',
        'the file being read',
        { file_path: '/repo/README.md' },
        '/repo/README.md',
      ],
      [
        'Grep',
        'the pattern over the path',
        { pattern: 'TODO', path: '/repo' },
        'TODO',
      ],
      ['Glob', 'the glob', { pattern: '**/*.ts' }, '**/*.ts'],
      [
        'WebFetch',
        'the url',
        { url: 'https://example.com/x', prompt: 'summarise' },
        'https://example.com/x',
      ],
    ];

    for (const [toolName, what, input, expected] of families) {
      test(`${toolName} previews ${what}`, () => {
        expect(toolRequestPreview(toolName, input)).toBe(expected);
      });
    }

    test('matches a family regardless of the casing an adapter uses', () => {
      for (const name of ['Bash', 'bash', 'BASH', 'shell_exec', 'shell-exec']) {
        expect(toolRequestPreview(name, { command: 'ls -la' })).toBe('ls -la');
      }
    });

    test('reads a field regardless of the casing an adapter uses', () => {
      for (const args of [
        { file_path: '/a/b.ts' },
        { filePath: '/a/b.ts' },
        { FilePath: '/a/b.ts' },
      ]) {
        expect(toolRequestPreview('Read', args)).toBe('/a/b.ts');
      }
    });

    test('falls through to the next field in the family when the first is absent', () => {
      // Grep's family prefers `pattern`; with none, the path is still the most
      // informative thing the call carries.
      expect(toolRequestPreview('Grep', { path: '/repo/src' })).toBe(
        '/repo/src',
      );
    });
  });

  describe('a tool no family claims', () => {
    test('serializes the whole input, keys and values', () => {
      expect(
        toolRequestPreview('mcp__station-control__list_agents', {
          status: 'active',
          limit: 5,
        }),
      ).toBe('{"status":"active","limit":5}');
    });

    test('does not borrow a family field from an MCP tool that happens to share a name', () => {
      // An MCP server's `read` is its own vocabulary — `path` there need not be
      // a filesystem path, so the family table must not claim it and the whole
      // input is shown instead.
      expect(
        toolRequestPreview('mcp__notes__read', { path: 'inbox', depth: 2 }),
      ).toBe('{"path":"inbox","depth":2}');
      expect(toolRequestPreview('Read', { path: 'inbox', depth: 2 })).toBe(
        'inbox',
      );
    });

    test('still finds a familiar field on an unfamiliar tool name', () => {
      expect(toolRequestPreview('run_terminal_v2', { command: 'ls' })).toBe(
        'ls',
      );
    });
  });

  describe('what it refuses to say', () => {
    test('redacts a known secret in a value AND in a key', () => {
      const secret = 'sk-live-super-secret-token-value-1234567890';
      const inValue = toolRequestPreview('http_request', {
        authorization: `Bearer ${secret}`,
      });
      expect(inValue).not.toContain(secret);
      expect(inValue).toContain('[REDACTED]');

      const inKey = toolRequestPreview('call_tool', { [secret]: 'value' });
      expect(inKey).not.toContain(secret);
      expect(inKey).toContain('[REDACTED]');
    });

    test('keeps paths and URLs, which a preview exists to show', () => {
      expect(toolRequestPreview('Bash', { command: 'rm -rf /var/tmp/x' })).toBe(
        'rm -rf /var/tmp/x',
      );
      expect(
        toolRequestPreview('WebFetch', { url: 'https://example.com/a/b' }),
      ).toBe('https://example.com/a/b');
    });

    test('bounds an oversized value and marks the truncation', () => {
      const preview = toolRequestPreview('Bash', {
        command: `echo ${'y'.repeat(5_000)}`,
      });
      expect(preview).toHaveLength(MAX_TOOL_REQUEST_PREVIEW_LENGTH);
      expect(preview?.endsWith('…')).toBe(true);
    });

    test('redacts BEFORE collapsing to one line, not after', () => {
      // Order is load-bearing and the reason this test exists. `redactSecrets`
      // is line-oriented: its contextual `key=value` pass is anchored on a line
      // boundary, so a secret on the SECOND line is only reachable while the
      // newline is still there. Collapse first and `PASSWORD=hunter2` becomes
      // mid-line text the contextual pass no longer sees — reproduced.
      expect(
        toolRequestPreview('Bash', {
          command: 'NAME=bob\nPASSWORD=hunter2',
        }),
      ).toBe('NAME=bob PASSWORD=[REDACTED]');
      expect(
        toolRequestPreview('Bash', {
          command: 'echo one\n--password=hunter2',
        }),
      ).toBe('echo one --password=[REDACTED]');
    });

    test('does not cut a length-anchored token in half at the pre-redaction slice', () => {
      // The prefix slice is 4096 characters. `ghp_` + 40 straddling that cut
      // arrives as a fragment too short for the length-anchored pattern to
      // match, and redaction SHORTENS what precedes it — `password=<4052>`
      // becomes `password=[REDACTED]` — which pulls the unredacted fragment
      // into the visible 160 characters. The trailing-token trim removes it.
      const command = `password=${'j'.repeat(4052)};ghp_${'A'.repeat(40)} rest`;
      const preview = toolRequestPreview('Bash', { command });

      expect(preview).toBe('password=[REDACTED];');
      expect(preview).not.toContain('ghp_');
    });

    test('the trim leaves a long ordinary argument alone', () => {
      // A run longer than `MAX_TRUNCATED_TOKEN_TRIM` is not a truncated
      // credential — any recognised shape that long still matches its own
      // length-anchored pattern — so trimming it would throw the preview away.
      // Trimming unconditionally reduced this whole command to `echo`.
      const preview = toolRequestPreview('Bash', {
        command: `echo ${'y'.repeat(5_000)}`,
      });
      expect(preview).toHaveLength(MAX_TOOL_REQUEST_PREVIEW_LENGTH);
      expect(preview?.startsWith('echo yyy')).toBe(true);

      // A prefix that is one unbroken run has no delimiter to trim back to; a
      // `\S+$` trim would delete everything and show nothing at all.
      expect(
        toolRequestPreview('Bash', { command: 'z'.repeat(9_000) }),
      ).toMatch(/^z+…$/);
      // A short input keeps its last word.
      expect(toolRequestPreview('Bash', { command: 'echo hello' })).toBe(
        'echo hello',
      );
    });

    test('collapses newlines and control characters into one line', () => {
      // A multi-line value must not be able to push a toast's buttons out of
      // view, and a second command below a newline must stay readable.
      expect(
        toolRequestPreview('Bash', {
          command: 'echo one\nrm -rf /tmp/x\r\n\tsecond',
        }),
      ).toBe('echo one rm -rf /tmp/x second');
      // An ANSI escape is inert in a React text node but renders as a gap
      // that hides what follows it.
      expect(
        toolRequestPreview('Bash', { command: 'a\u0000\u001b[31mb' }),
      ).toBe('a [31mb');
    });

    test('says nothing rather than something empty', () => {
      expect(toolRequestPreview('Bash', undefined)).toBeUndefined();
      expect(toolRequestPreview('Bash', null)).toBeUndefined();
      expect(toolRequestPreview('Bash', {})).toBeUndefined();
      expect(toolRequestPreview(undefined, undefined)).toBeUndefined();
    });

    test('survives an input that cannot be serialized', () => {
      const circular: Record<string, unknown> = { name: 'x' };
      circular.self = circular;
      // `name` is not a family field for an unknown tool, so this reaches the
      // whole-input serializer, which is the branch that would throw.
      expect(() => toolRequestPreview('weird_tool', circular)).not.toThrow();
      expect(toolRequestPreview('weird_tool', circular)).toBeUndefined();
    });
  });
});

describe('toolRequestDisplayName', () => {
  test('reads an MCP wire name as server and tool', () => {
    expect(toolRequestDisplayName('mcp__station-control__list_agents')).toBe(
      'station-control.list_agents',
    );
  });

  test('leaves an ordinary tool name alone', () => {
    expect(toolRequestDisplayName('Bash')).toBe('Bash');
  });

  test('bounds an adapter-supplied name and refuses an empty one', () => {
    expect(toolRequestDisplayName('n'.repeat(5_000))).toHaveLength(
      MAX_TOOL_REQUEST_PREVIEW_LENGTH,
    );
    expect(toolRequestDisplayName('   ')).toBeUndefined();
    expect(toolRequestDisplayName(undefined)).toBeUndefined();
  });
});

describe('toolRequestFromPayload — adapters do not agree on a field name', () => {
  // The list is not cosmetic: reading `toolInput` alone left every ACP engine
  // (`rawInput`) and every station-agent session (`toolArgs`) with no preview on
  // the live toast while the durable inbox row showed the command.
  test.each([
    ['claude canUseTool', 'toolInput'],
    ['station-agent + the Claude PreToolUse hook', 'toolArgs'],
    ['ACP session/request_permission (Gemini and friends)', 'rawInput'],
    ['a future producer', 'arguments'],
    ['a future producer', 'args'],
  ])('reads the arguments %s publishes under %j', (_who, field) => {
    const payload = { toolName: 'Bash', [field]: { command: 'ls -la' } };
    expect(toolRequestFromPayload(payload)).toEqual({
      toolName: 'Bash',
      toolInput: { command: 'ls -la' },
    });
    expect(toolRequestPreviewFromPayload(payload)).toBe('ls -la');
  });

  test('every declared field name is actually read', () => {
    // Pins the list against a field being dropped from it: the loop above is
    // hand-written, so this is what notices a name leaving the export.
    for (const field of TOOL_REQUEST_ARGS_FIELDS) {
      expect(
        toolRequestFromPayload({ [field]: { command: 'ls' } }).toolInput,
      ).toEqual({ command: 'ls' });
    }
  });

  test('prefers the most specific name when a payload carries two', () => {
    expect(
      toolRequestFromPayload({
        args: { command: 'second' },
        toolInput: { command: 'first' },
      }).toolInput,
    ).toEqual({ command: 'first' });
  });

  test('falls back from toolName to tool, and trims', () => {
    expect(toolRequestFromPayload({ tool: '  Bash  ' }).toolName).toBe('Bash');
    expect(
      toolRequestFromPayload({ toolName: '  ', tool: 'Bash' }).toolName,
    ).toBe('Bash');
  });

  test('reports nothing for a payload that carries neither', () => {
    expect(toolRequestFromPayload(undefined)).toEqual({});
    expect(toolRequestFromPayload({ toolCallId: 'x' })).toEqual({});
    expect(toolRequestPreviewFromPayload({ toolCallId: 'x' })).toBeUndefined();
  });
});

describe('#1545 D4: an engine that names no argument bag (Codex)', () => {
  // Codex has no Station pre-tool interception seam, so its `request.opened`
  // payload is the app-server's raw request params — no `toolInput`/`toolArgs`/
  // `rawInput` anywhere. Before the payload fallback, a command approval showed
  // a bare title and a file-change approval named no file on either surface.
  test('previews the command from item/commandExecution/requestApproval', () => {
    expect(
      toolRequestPreviewFromPayload({
        command: 'rm -rf tmp',
        reason: 'Needs approval',
      }),
    ).toBe('rm -rf tmp');
  });

  test('previews the paths from item/fileChange/requestApproval', () => {
    expect(
      toolRequestPreviewFromPayload({
        changes: [
          { path: 'src/index.ts', diff: '@@ -1 +1 @@\n-a\n+b' },
          { path: 'README.md', diff: 'x'.repeat(5_000) },
        ],
        reason: 'Needs approval',
      }),
    ).toBe('src/index.ts, README.md');
  });

  test('counts the rest rather than spending the line on the first few paths', () => {
    expect(
      toolRequestPreviewFromPayload({
        changes: Array.from({ length: 12 }, (_unused, index) => ({
          path: `file-${index}.ts`,
          diff: 'y'.repeat(1_000),
        })),
      }),
    ).toBe('file-0.ts, file-1.ts, file-2.ts and 9 more');
  });

  test('reads changes[] wherever it arrives, including a named argument bag', () => {
    // `deriveToolArguments` builds `{ changes }` for an apply_patch tool call,
    // which reaches the surfaces as `toolArgs` rather than as the payload.
    expect(
      toolRequestPreviewFromPayload({
        toolName: 'apply_patch',
        toolArgs: { changes: [{ path: 'a.ts', diff: 'z'.repeat(5_000) }] },
      }),
    ).toBe('a.ts');
  });

  test('does not claim the payload IS the arguments, only previews from it', () => {
    // `toolRequestFromPayload` must keep answering "the adapter named none",
    // because that is the truth a caller reasoning about provenance needs.
    expect(toolRequestFromPayload({ command: 'rm -rf tmp' })).toEqual({});
  });

  test('a changes array with nothing readable falls through rather than inventing a path', () => {
    expect(toolRequestPreviewFromPayload({ changes: [] })).toBeUndefined();
    // No path anywhere, so nothing to name. The whole payload is NOT serialized
    // in the fallback: a payload is request scaffolding, not an argument bag.
    expect(
      toolRequestPreviewFromPayload({ changes: [{ diff: 'x' }] }),
    ).toBeUndefined();
    expect(
      toolRequestPreviewFromPayload({ toolCallId: 'x', reason: 'because' }),
    ).toBeUndefined();
    // An explicitly-handed argument bag still serializes, which is what makes an
    // MCP tool's server-defined arguments visible.
    expect(toolRequestPreview('mcp__x__y', { changes: [{ diff: 'x' }] })).toBe(
      '{"changes":[{"diff":"x"}]}',
    );
  });
});
