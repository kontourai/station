import { describe, expect, test } from 'vitest';
import {
  AUTHORED_ARTIFACT_MAX_CHARS,
  authoredArtifactBudgetMessage,
} from '../../../../src-shared/authored-artifact-limits.js';
import {
  CHAT_INPUT_MAX_CHARS,
  CHAT_INPUT_TOOL_PART_MAX_CHARS,
} from '../../../../src-shared/chat-input-limits.js';
import {
  acpConnectionSchema,
  addJobSchema,
  agentCreateSchema,
  agentUpdateSchema,
  chatSchema,
  connectionSchema,
  credentialProfileApplyRequestSchema,
  credentialProfileEnrollmentRequestSchema,
  credentialProfileUpsertRequestSchema,
  credentialRecoveryPolicyRequestSchema,
  editJobSchema,
  globalInvokeSchema,
  integrationSchema,
  invokeSchema,
  invokeStreamSchema,
  localSkillCreateSchema,
  localSkillUpdateSchema,
  pluginInstallSchema,
  skillImportSchema,
  skillOutcomeSchema,
} from '../schemas.js';

function bedrockConnection(config: Record<string, unknown>) {
  return {
    kind: 'model' as const,
    type: 'bedrock',
    name: 'AWS Bedrock',
    config,
    enabled: true,
    capabilities: ['llm', 'embedding'],
  };
}

describe('schema definitions barrel', () => {
  test('exports runtime and content schemas through schemas.ts', () => {
    expect(
      acpConnectionSchema.parse({
        id: 'kiro',
        command: 'kiro-cli',
      }),
    ).toEqual({
      id: 'kiro',
      command: 'kiro-cli',
    });

    expect(
      localSkillCreateSchema.parse({
        name: 'My Skill',
        body: 'Hello',
      }),
    ).toEqual({
      name: 'My Skill',
      body: 'Hello',
    });
  });

  describe('authored artifact budget (station#2838)', () => {
    const overBudget = 'x'.repeat(AUTHORED_ARTIFACT_MAX_CHARS + 1);

    test('is separately observable from the per-turn input budget', () => {
      expect(AUTHORED_ARTIFACT_MAX_CHARS).not.toBe(CHAT_INPUT_MAX_CHARS);
      expect(authoredArtifactBudgetMessage('Skill body')).toContain(
        'authored-artifact budget',
      );
    });

    const cases = [
      {
        name: 'agentCreateSchema.prompt',
        artifact: 'Agent system prompt',
        parse: () =>
          agentCreateSchema.safeParse({
            name: 'Bounded agent',
            prompt: overBudget,
          }),
      },
      {
        name: 'agentUpdateSchema.prompt',
        artifact: 'Agent system prompt',
        parse: () => agentUpdateSchema.safeParse({ prompt: overBudget }),
      },
      {
        name: 'localSkillCreateSchema.body',
        artifact: 'Skill body',
        parse: () =>
          localSkillCreateSchema.safeParse({
            name: 'Bounded skill',
            body: overBudget,
          }),
      },
    ];

    for (const budgetedArtifact of cases) {
      test(`${budgetedArtifact.name} refuses without truncating and names its budget`, () => {
        const result = budgetedArtifact.parse();
        expect(result.success).toBe(false);
        if (result.success)
          throw new Error('Expected an authored-artifact refusal');
        expect(result.error.issues[0]?.message).toBe(
          authoredArtifactBudgetMessage(budgetedArtifact.artifact),
        );
      });
    }

    test('accepts each artifact exactly at the separate authored-artifact budget', () => {
      const exact = 'x'.repeat(AUTHORED_ARTIFACT_MAX_CHARS);
      expect(
        agentCreateSchema.safeParse({ name: 'Agent', prompt: exact }).success,
      ).toBe(true);
      expect(agentUpdateSchema.safeParse({ prompt: exact }).success).toBe(true);
      expect(
        localSkillCreateSchema.safeParse({ name: 'Skill', body: exact })
          .success,
      ).toBe(true);
    });
  });

  test('provideToolServers: accepts valid lowercase-kebab tool-server ids, no dupes', () => {
    expect(
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['filesystem', 'station-sessions-mcp'],
      }).provideToolServers,
    ).toEqual(['filesystem', 'station-sessions-mcp']);
  });

  test('ACP admission rejects identities that cannot cross public and runtime seams', () => {
    for (const id of ['bad_id', 'Bad', '1bad', 'bad.id']) {
      expect(() =>
        acpConnectionSchema.parse({ id, command: 'engine-cli' }),
      ).toThrow(/clean engine identity/);
    }
  });

  test('credential recovery schemas fail closed for hostile refs, labels, booleans, and confirmation', () => {
    expect(
      credentialProfileUpsertRequestSchema.parse({
        ref: 'profile-a',
        label: 'Account A',
      }),
    ).toEqual({ ref: 'profile-a', label: 'Account A' });
    for (const ref of ['../canary', 'profile/canary', '.', '..', '']) {
      expect(() =>
        credentialProfileUpsertRequestSchema.parse({ ref }),
      ).toThrow();
    }
    expect(() =>
      credentialProfileUpsertRequestSchema.parse({
        ref: 'profile-a',
        label: 'canary\nlabel',
      }),
    ).toThrow();
    expect(() =>
      credentialProfileEnrollmentRequestSchema.parse({ enrolled: 'true' }),
    ).toThrow();
    expect(() =>
      credentialRecoveryPolicyRequestSchema.parse({ automatic: 'false' }),
    ).toThrow();
    expect(() =>
      credentialProfileApplyRequestSchema.parse({ confirmed: false }),
    ).toThrow();
    expect(() =>
      credentialProfileApplyRequestSchema.parse({
        confirmed: true,
        timeoutMs: 1_000,
      }),
    ).toThrow();
  });

  test('provideToolServers: rejects a path-traversal id (MED-1, repo review 2026-07-26)', () => {
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['../outside'],
      }),
    ).toThrow();
  });

  test('provideToolServers: rejects an id containing a path separator', () => {
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['foo/bar'],
      }),
    ).toThrow();
  });

  test('provideToolServers: compat (repo review, 2026-07-26) — accepts a legacy-shaped id with dots/uppercase, matching the storage-safety rule rather than an aesthetic pattern', () => {
    // An existing on-disk integration id may not be lowercase-kebab (that
    // was only ever a *display* filter in the registry list route, never a
    // write-time constraint) — a user must still be able to opt it into
    // MCP passthrough. Only real filesystem-escape risk is rejected.
    expect(
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['My.Tool_v2', 'Filesystem'],
      }).provideToolServers,
    ).toEqual(['My.Tool_v2', 'Filesystem']);
  });

  test('provideToolServers: rejects an empty-string id', () => {
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: [''],
      }),
    ).toThrow();
  });

  test("provideToolServers: rejects a bare '.' or '..' id", () => {
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['.'],
      }),
    ).toThrow();
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['..'],
      }),
    ).toThrow();
  });

  test('provideToolServers: rejects duplicate ids', () => {
    expect(() =>
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: ['filesystem', 'filesystem'],
      }),
    ).toThrow(/duplicate/);
  });

  test('provideToolServers: an empty array is valid (explicit off)', () => {
    expect(
      acpConnectionSchema.parse({
        id: 'opencode',
        command: 'opencode',
        provideToolServers: [],
      }).provideToolServers,
    ).toEqual([]);
  });

  test('bounds chat model selectors while preserving other options', () => {
    expect(
      chatSchema.parse({
        input: 'hello',
        options: { model: 'model-a', maxSteps: 4 },
      }).options,
    ).toEqual({ model: 'model-a', maxSteps: 4 });
    expect(() =>
      chatSchema.parse({
        input: 'hello',
        options: { model: 'x'.repeat(513) },
      }),
    ).toThrow();
  });

  test('refuses an oversized inline attachment the size guard measures as zero (#2828)', () => {
    // The exact payload from the issue: a file part whose base64 url is far
    // over the per-attachment limit. The prompt-size guard counts only `text`,
    // so this measures 0 characters and previously rode the 22 MiB body cap.
    // 8 MiB of base64 → ~6 MiB decoded, over the 5 MiB per-attachment cap.
    // (6 MiB of base64 decodes to ~4.5 MiB and is legitimately accepted.)
    const oversized = 'A'.repeat(8 * 1024 * 1024);
    expect(() =>
      chatSchema.parse({
        input: [
          {
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'text/plain',
                url: `data:text/plain;base64,${oversized}`,
              },
            ],
          },
        ],
      }),
    ).toThrow(/byte limit/);
  });

  test('bounds attachments carried under content[] as well as parts[] (#2828)', () => {
    // The attachment bound walks the same shapes the size guard walks. A
    // second, independently-written traversal could recognize only parts[],
    // leaving this envelope unbounded while both guards reported success.
    const oversized = 'A'.repeat(8 * 1024 * 1024);
    expect(
      () =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'text/plain',
                  url: `data:text/plain;base64,${oversized}`,
                },
              ],
            },
          ],
        }),
      // Asserts the SIZE reason specifically: a bare .toThrow() also passes
      // when the envelope is merely unrecognized, which is how a divergent
      // traversal would look — that would be a red for the wrong reason.
    ).toThrow(/byte limit/);
  });

  test('refuses an unsupported attachment media type (#2828)', () => {
    expect(() =>
      chatSchema.parse({
        input: [
          {
            role: 'user',
            parts: [
              {
                type: 'file',
                mediaType: 'application/zip',
                url: 'data:application/zip;base64,QUJD',
              },
            ],
          },
        ],
      }),
    ).toThrow(/not supported/);
  });

  test('admits an ordinary image turn (#2828 must not refuse every attachment)', () => {
    // 1x1 png. The guard has to stay usable: refusing legitimate attachments
    // would be the same failure in the other direction.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    expect(
      chatSchema.parse({
        input: [
          {
            role: 'user',
            parts: [
              { type: 'text', text: 'what is this?' },
              {
                type: 'file',
                mediaType: 'image/png',
                url: `data:image/png;base64,${png}`,
              },
            ],
          },
        ],
      }),
    ).toBeTruthy();
  });

  test('chat schema accepts the optional out-of-band ambientContext (#685)', () => {
    expect(
      chatSchema.parse({
        input: 'what time is it?',
        ambientContext: '[Timezone: America/Denver]',
      }).ambientContext,
    ).toBe('[Timezone: America/Denver]');
    // Optional: plain sends parse without it.
    expect(chatSchema.parse({ input: 'hello' }).ambientContext).toBeUndefined();
  });

  test('exports scheduler and system schemas through schemas.ts', () => {
    expect(
      addJobSchema.parse({
        name: 'daily-sync',
        cron: '0 9 * * *',
        prompt: 'run sync',
      }).name,
    ).toBe('daily-sync');

    expect(
      pluginInstallSchema.parse({
        source: 'https://example.com/plugin.tgz',
      }),
    ).toEqual({
      source: 'https://example.com/plugin.tgz',
    });
  });

  test('integrationSchema accepts an omitted icon and a short manifest-declared icon (issue #691)', () => {
    expect(
      integrationSchema.parse({ id: 'docs', displayName: 'Docs' }).icon,
    ).toBeUndefined();

    expect(
      integrationSchema.parse({ id: 'docs', displayName: 'Docs', icon: '📋' })
        .icon,
    ).toBe('📋');
  });

  test('integrationSchema rejects an icon longer than the bounded local-path limit', () => {
    expect(() =>
      integrationSchema.parse({
        id: 'docs',
        icon: 'a'.repeat(241),
      }),
    ).toThrow();
  });

  test('integrationSchema rejects dangerous credential-map keys at the boundary', () => {
    expect(() =>
      integrationSchema.parse({ id: '__proto__', kind: 'mcp' }),
    ).toThrow(/dangerous keys/);
    expect(() =>
      integrationSchema.parse({
        id: 'safe',
        kind: 'mcp',
        env: JSON.parse('{"__proto__":"hostile"}'),
      }),
    ).toThrow(/dangerous keys/);
  });

  test('integrationSchema strips caller-supplied service-owned probe state', () => {
    expect(
      integrationSchema.parse({
        id: 'safe',
        kind: 'mcp',
        probe: {
          ok: false,
          error: 'caller-controlled text',
          toolCount: 0,
          checkedAt: '2026-08-15T00:00:00.000Z',
          authorization: {
            state: 'authorization-failed',
            reason: 'caller-controlled text',
          },
        },
      }),
    ).not.toHaveProperty('probe');
  });

  test('integrationSchema keeps raw secret binding references out of the public write boundary', () => {
    expect(
      integrationSchema.parse({
        id: 'safe',
        kind: 'mcp',
        secretEnvRefs: { TOKEN: 'github-token' },
      }),
    ).not.toHaveProperty('secretEnvRefs');
  });

  // HIGH-2 (review fix round): a Bedrock connection save must never persist
  // a mode/field mismatch — that would otherwise resolve silently to the
  // default credential chain at request time (docs/design/
  // connections-onboarding.md §3.1).
  describe('connectionSchema — Bedrock auth-mode enforcement', () => {
    test("accepts an absent authMode (chain, today's default behavior)", () => {
      expect(() =>
        connectionSchema.parse(bedrockConnection({ region: 'us-east-1' })),
      ).not.toThrow();
    });

    test('accepts a well-formed profile-mode config', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({
            region: 'us-east-1',
            authMode: 'profile',
            profile: 'work',
          }),
        ),
      ).not.toThrow();
    });

    test('accepts a well-formed api-key-mode config', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({
            region: 'us-east-1',
            authMode: 'api-key',
            apiKey: 'bedrock-key-abc',
          }),
        ),
      ).not.toThrow();
    });

    test('rejects profile mode with a missing profile field', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({ region: 'us-east-1', authMode: 'profile' }),
        ),
      ).toThrow(/named AWS profile is required/i);
    });

    test('rejects profile mode with a blank profile field', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({
            region: 'us-east-1',
            authMode: 'profile',
            profile: '   ',
          }),
        ),
      ).toThrow(/named AWS profile is required/i);
    });

    test('rejects api-key mode with a missing apiKey field', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({ region: 'us-east-1', authMode: 'api-key' }),
        ),
      ).toThrow(/Bedrock API key is required/i);
    });

    test('rejects an unrecognized authMode', () => {
      expect(() =>
        connectionSchema.parse(
          bedrockConnection({ region: 'us-east-1', authMode: 'bogus' }),
        ),
      ).toThrow(/authMode must be one of/i);
    });

    test('never validates authMode/profile/apiKey for non-bedrock connection types', () => {
      expect(() =>
        connectionSchema.parse({
          kind: 'model',
          type: 'ollama',
          name: 'Local Ollama',
          config: { authMode: 'bogus' },
          enabled: true,
          capabilities: ['llm'],
        }),
      ).not.toThrow();
    });
  });

  describe('chat input size bound (station#2807)', () => {
    // The boundary is pinned to the shared constant — if chatSchema's bound
    // ever diverges from CHAT_INPUT_MAX_CHARS (the same module the UI
    // composer reads), these two tests fail.
    test('accepts a plain string exactly at the shared limit constant', () => {
      expect(() =>
        chatSchema.parse({ input: 'x'.repeat(CHAT_INPUT_MAX_CHARS) }),
      ).not.toThrow();
    });

    test('refuses a plain string one character over, naming size and limit', () => {
      expect(() =>
        chatSchema.parse({ input: 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1) }),
      ).toThrow(
        new RegExp(
          `Message is ${CHAT_INPUT_MAX_CHARS + 1} characters, which is 1 over the ${CHAT_INPUT_MAX_CHARS}-character limit`,
        ),
      );
    });

    test('refuses a ChatMessage[] whose combined text exceeds the limit', () => {
      const overBy = 4321;
      const messages = [
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'a'.repeat(CHAT_INPUT_MAX_CHARS - 100) },
          ],
        },
        {
          role: 'user',
          parts: [{ type: 'text', text: 'b'.repeat(100 + overBy) }],
        },
      ];
      expect(() => chatSchema.parse({ input: messages })).toThrow(
        `Message is ${CHAT_INPUT_MAX_CHARS + overBy} characters, which is ${overBy} over the ${CHAT_INPUT_MAX_CHARS}-character limit`,
      );
    });

    test('accepts a ChatMessage[] exactly at the combined-text limit', () => {
      const messages = [
        // Text is counted regardless of role; this tool part contributes
        // nothing because it carries no `text` field — not because of its
        // role or type.
        { role: 'assistant', parts: [{ type: 'tool', name: 'noop' }] },
        {
          role: 'user',
          parts: [
            { type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS - 10) },
            { type: 'text', text: '0123456789' },
          ],
        },
      ];
      expect(() => chatSchema.parse({ input: messages })).not.toThrow();
    });

    test('does not count a file part dataUrl toward the text limit (attachments are a separate budget)', () => {
      const messages = [
        {
          id: 'msg-1',
          role: 'user',
          parts: [
            { type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
            {
              type: 'file',
              url: `data:image/png;base64,${'Z'.repeat(2_000_000)}`,
              mediaType: 'image/png',
            },
          ],
        },
      ];
      expect(() => chatSchema.parse({ input: messages })).not.toThrow();
    });

    // station#2807 H1: a parts-only sizer measured the AI SDK ModelMessage
    // shape (text in `content`) as ZERO, so a 500k-char prompt passed the
    // bound unmeasured. This enumerates EVERY shape `Agent.streamText`
    // accepts (`string | UIMessage[] | ModelMessage[]`) and asserts each is
    // bounded — a future shape regression should land here, not in prod.
    test('bounds the four authored-text shapes: string, UIMessage parts, ModelMessage content string, ModelMessage content parts (tool-part text has its own budget — see the station#2830 block below)', () => {
      const over = CHAT_INPUT_MAX_CHARS + 7;
      const shapes: Array<{ name: string; atLimit: unknown; over: unknown }> = [
        {
          name: 'plain string',
          atLimit: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
          over: 'x'.repeat(over),
        },
        {
          name: 'UIMessage parts',
          atLimit: [
            {
              role: 'user',
              parts: [{ type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS) }],
            },
          ],
          over: [
            { role: 'user', parts: [{ type: 'text', text: 'x'.repeat(over) }] },
          ],
        },
        {
          name: 'ModelMessage user content (string)',
          atLimit: [
            { role: 'user', content: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
          ],
          over: [{ role: 'user', content: 'x'.repeat(over) }],
        },
        {
          name: 'ModelMessage user content (parts)',
          atLimit: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
              ],
            },
          ],
          over: [
            {
              role: 'user',
              content: [{ type: 'text', text: 'x'.repeat(over) }],
            },
          ],
        },
        {
          name: 'ModelMessage system content (role is not a filter)',
          atLimit: [
            { role: 'system', content: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
          ],
          over: [{ role: 'system', content: 'x'.repeat(over) }],
        },
        {
          name: 'ModelMessage assistant content parts (role is not a filter)',
          atLimit: [
            {
              role: 'assistant',
              content: [
                { type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
              ],
            },
          ],
          over: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'x'.repeat(over) }],
            },
          ],
        },
        {
          name: 'ModelMessage mix: text split across content and a prior UIMessage',
          atLimit: [
            {
              id: 'm1',
              role: 'user',
              parts: [{ type: 'text', text: 'x'.repeat(100) }],
            },
            { role: 'user', content: 'y'.repeat(CHAT_INPUT_MAX_CHARS - 100) },
          ],
          over: [
            {
              id: 'm1',
              role: 'user',
              parts: [{ type: 'text', text: 'x'.repeat(100) }],
            },
            { role: 'user', content: 'y'.repeat(CHAT_INPUT_MAX_CHARS - 93) },
          ],
        },
      ];
      for (const shape of shapes) {
        expect(
          () => chatSchema.parse({ input: shape.atLimit }),
          shape.name,
        ).not.toThrow();
        expect(
          () => chatSchema.parse({ input: shape.over }),
          shape.name,
        ).toThrow(
          `Message is ${over} characters, which is 7 over the ${CHAT_INPUT_MAX_CHARS}-character limit`,
        );
      }
    });

    test('does not count ModelMessage image/file part payloads toward the text limit', () => {
      const messages = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'x'.repeat(CHAT_INPUT_MAX_CHARS) },
            {
              type: 'image',
              image: `data:image/png;base64,${'Z'.repeat(2_000_000)}`,
            },
            {
              type: 'file',
              data: 'Z'.repeat(2_000_000),
              mediaType: 'application/pdf',
            },
          ],
        },
      ];
      expect(() => chatSchema.parse({ input: messages })).not.toThrow();
    });

    // The fail-closed half of H1: input whose shape cannot be sized is
    // REFUSED, never measured as zero — including shapes that are small, so
    // the refusal is provably about recognition, not size.
    test('refuses input whose shape it cannot size — the guard fails closed, never to zero', () => {
      const big = 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1);
      const unrecognized: Array<{ name: string; value: unknown }> = [
        {
          name: 'a bare message object (not wrapped in an array)',
          value: { role: 'user', parts: [{ type: 'text', text: big }] },
        },
        { name: 'an array of raw strings', value: [big] },
        {
          name: 'parts as an object with numeric keys',
          value: [{ role: 'user', parts: { 0: { type: 'text', text: big } } }],
        },
        {
          name: 'text as an array of strings',
          value: [{ role: 'user', parts: [{ type: 'text', text: [big] }] }],
        },
        { name: 'a number', value: 42 },
        { name: 'null', value: null },
        {
          name: 'a message with neither parts nor content',
          value: [{ role: 'user' }],
        },
        { name: 'content: null', value: [{ role: 'user', content: null }] },
        {
          name: 'a message carrying BOTH parts and content (neither vocabulary)',
          value: [
            {
              role: 'user',
              parts: [{ type: 'text', text: big }],
              content: big,
            },
          ],
        },
        { name: 'a non-object message element', value: [17] },
        {
          name: 'a small but still-unrecognized object',
          value: { role: 'user' },
        },
      ];
      for (const shape of unrecognized) {
        expect(
          () => chatSchema.parse({ input: shape.value }),
          shape.name,
        ).toThrow('Message shape is not recognized');
      }
    });
  });

  // station#2807 M1: the invoke routes' turn-starting text fields derive
  // from the same declared maximum as chatSchema — these pins fail if any
  // of them stops deriving (a hardcoded literal diverges the moment the
  // constant moves).
  describe('tool-part text is bounded on its own budget (station#2830)', () => {
    // The #2807 guard summed a part's `text` only, so a tool call's `input`
    // or a tool result's `output` was a RECOGNIZED shape that measured zero
    // and rode ~110x the declared limit to the provider. Fail-closed does
    // not catch it — the shape is known — so these cases pin the separate
    // tool budget rather than the prompt one.
    const toolOver = 'x'.repeat(CHAT_INPUT_TOOL_PART_MAX_CHARS + 1);

    test('refuses an oversized tool-result output in UIMessage parts', () => {
      expect(() =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              parts: [{ type: 'dynamic-tool', output: toolOver }],
            },
          ],
        }),
      ).toThrow(/tool/i);
    });

    test('refuses an oversized tool-call input in ModelMessage content', () => {
      expect(() =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              content: [{ type: 'tool-call', input: toolOver }],
            },
          ],
        }),
      ).toThrow(/tool/i);
    });

    test('refuses an oversized non-string tool payload by its serialized size', () => {
      expect(() =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              parts: [
                {
                  type: 'tool-result',
                  output: {
                    rows: ['y'.repeat(CHAT_INPUT_TOOL_PART_MAX_CHARS)],
                  },
                },
              ],
            },
          ],
        }),
      ).toThrow(/tool/i);
    });

    test('accepts an ordinary tool round-trip', () => {
      expect(() =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              parts: [
                { type: 'text', text: 'read the config' },
                { type: 'tool-call', input: { path: 'config.json' } },
                { type: 'tool-result', output: '{"port":3141}' },
              ],
            },
          ],
        }),
      ).not.toThrow();
    });

    test('the tool budget is its own number, not the prompt budget', () => {
      // Pinning the DISTINCTNESS, not the values: coupling tool payloads to
      // the user-prompt constant means lowering that constant later silently
      // drags an unrelated policy with it.
      expect(CHAT_INPUT_TOOL_PART_MAX_CHARS).not.toBe(CHAT_INPUT_MAX_CHARS);
      // Tool text above the PROMPT limit but below the TOOL limit is fine —
      // if this ever throws, the two budgets have been fused.
      expect(() =>
        chatSchema.parse({
          input: [
            {
              role: 'user',
              parts: [
                {
                  type: 'tool-result',
                  output: 'z'.repeat(CHAT_INPUT_MAX_CHARS + 1),
                },
              ],
            },
          ],
        }),
      ).not.toThrow();
    });
  });

  describe('scheduler job prompts derive from the shared limit (station#2829)', () => {
    // #2829's second acceptance criterion: the bound must be covered by the
    // derivation pin, not merely present. Deleting `.max(CHAT_INPUT_MAX_CHARS)`
    // from `jobPrompt` previously reddened nothing.
    const over = 'x'.repeat(CHAT_INPUT_MAX_CHARS + 1);

    test('refuses an over-limit job prompt at schedule time', () => {
      expect(() =>
        addJobSchema.parse({ name: 'j', cron: '0 9 * * *', prompt: over }),
      ).toThrow();
    });

    test('accepts a job prompt exactly at the shared limit', () => {
      expect(() =>
        addJobSchema.parse({
          name: 'j',
          cron: '0 9 * * *',
          prompt: 'x'.repeat(CHAT_INPUT_MAX_CHARS),
        }),
      ).not.toThrow();
    });

    test('the edit path is bounded too — a job can be edited, not just created', () => {
      expect(() => editJobSchema.parse({ prompt: over })).toThrow();
    });
  });

  describe('invoke prompt bounds derive from the shared chat input limit (station#2807)', () => {
    const cases: Array<{ name: string; parse: (value: string) => unknown }> = [
      {
        name: 'invokeSchema.input',
        parse: (value) => invokeSchema.parse({ input: value }),
      },
      {
        name: 'invokeStreamSchema.prompt',
        parse: (value) => invokeStreamSchema.parse({ prompt: value }),
      },
      {
        name: 'globalInvokeSchema.prompt',
        parse: (value) => globalInvokeSchema.parse({ prompt: value }),
      },
      {
        name: 'globalInvokeSchema.system',
        parse: (value) =>
          globalInvokeSchema.parse({ prompt: 'p', system: value }),
      },
    ];
    for (const bound of cases) {
      test(`${bound.name} accepts exactly CHAT_INPUT_MAX_CHARS and refuses one more`, () => {
        expect(() =>
          bound.parse('x'.repeat(CHAT_INPUT_MAX_CHARS)),
        ).not.toThrow();
        expect(() =>
          bound.parse('x'.repeat(CHAT_INPUT_MAX_CHARS + 1)),
        ).toThrow();
      });
    }
  });
});

describe('skill command and variable schemas', () => {
  test('command.enabled must be a real boolean an author wrote', () => {
    expect(
      localSkillUpdateSchema.safeParse({ command: { enabled: true } }).success,
    ).toBe(true);
    expect(
      localSkillUpdateSchema.safeParse({ command: { enabled: 'yes' } }).success,
    ).toBe(false);
    expect(localSkillUpdateSchema.safeParse({ command: {} }).success).toBe(
      false,
    );
  });

  test('command.name must be typable after a slash', () => {
    expect(
      localSkillUpdateSchema.safeParse({
        command: { enabled: true, name: 'release-check' },
      }).success,
    ).toBe(true);
    for (const name of ['Release Check', 'ship it', '-lead', 'UPPER']) {
      expect(
        localSkillUpdateSchema.safeParse({ command: { enabled: true, name } })
          .success,
      ).toBe(false);
    }
  });

  test('legacyIds and origin are not client-writable', () => {
    const parsed = localSkillCreateSchema.parse({
      name: 'Skill',
      body: 'Body',
      legacyIds: ['some-uuid'],
      origin: 'registry',
    });
    expect(parsed).not.toHaveProperty('legacyIds');
    expect(parsed).not.toHaveProperty('origin');
  });

  test('variables carry a name plus optional description and default', () => {
    expect(
      localSkillUpdateSchema.safeParse({
        variables: [{ name: 'ticket', description: 'Issue key', default: '' }],
      }).success,
    ).toBe(true);
    expect(
      localSkillUpdateSchema.safeParse({
        variables: [{ description: 'no name' }],
      }).success,
    ).toBe(false);
  });

  test('skillOutcomeSchema accepts only success or failure', () => {
    expect(skillOutcomeSchema.safeParse({ outcome: 'success' }).success).toBe(
      true,
    );
    expect(skillOutcomeSchema.safeParse({ outcome: 'maybe' }).success).toBe(
      false,
    );
  });

  test('skillImportSchema requires at least one named file with content', () => {
    expect(
      skillImportSchema.safeParse({
        files: [{ filename: 'a.md', content: 'Body' }],
      }).success,
    ).toBe(true);
    expect(skillImportSchema.safeParse({ files: [] }).success).toBe(false);
    expect(
      skillImportSchema.safeParse({
        files: [{ filename: 'a.md', content: '' }],
      }).success,
    ).toBe(false);
  });
});
