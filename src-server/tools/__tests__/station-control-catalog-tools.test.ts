import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../telemetry/metrics.js', () => ({
  skillOps: { add: vi.fn() },
}));

const { registerCatalogTools } = await import(
  '../station-control-catalog-tools.js'
);
const { createSkillRoutes } = await import('../../routes/agents/skills.js');
const { localSkillCreateSchema } = await import(
  '../../routes/schemas/schemas.js'
);
const { SkillUsageUnreadableError } = await import(
  '../../services/agents/skill-usage-service.js'
);

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
}>;

type ToolShape = Record<string, { safeParse(value: unknown): unknown }>;

/** The declared input shape of each tool, as the MCP server would see it. */
function collectShapes(): Map<string, ToolShape> {
  const shapes = new Map<string, ToolShape>();
  registerCatalogTools({
    tool: (name: string, _description: string, shape: ToolShape) => {
      shapes.set(name, shape);
    },
  } as never);
  return shapes;
}

/** Register the catalog tools against a recording registry, not a live MCP server. */
function collectTools(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  registerCatalogTools({
    tool: (
      name: string,
      _description: string,
      _shape: unknown,
      callback: ToolHandler,
    ) => {
      handlers.set(name, callback);
    },
  } as never);
  return handlers;
}

/**
 * The skill service the routes write through, with the two counter methods
 * recording what the tool asked for. Stubs, not a real home: what is under
 * test is that the TOOL reaches the route it claims to, with the arguments it
 * was handed — the service's own behaviour has its own suites.
 */
function skillServiceDouble() {
  return {
    listSkills: vi.fn().mockReturnValue([{ name: 'ship-it' }]),
    getSkill: vi.fn().mockResolvedValue({ name: 'ship-it' }),
    resolveSkillName: vi.fn((name: string) =>
      name === 'ship-it' || name === 'legacy-uuid' ? 'ship-it' : undefined,
    ),
    isSkillWritable: vi.fn().mockReturnValue(true),
    updateLocalSkill: vi
      .fn()
      .mockResolvedValue({ success: true, message: 'Updated' }),
    trackSkillRun: vi.fn().mockResolvedValue({
      runs: 1,
      successes: 0,
      failures: 0,
      qualityScore: null,
    }),
    recordSkillOutcome: vi.fn().mockResolvedValue({
      runs: 1,
      successes: 1,
      failures: 0,
      qualityScore: 100,
    }),
  };
}

/**
 * Route `fetch` at the real skills routes, so a tool that names a path no
 * route serves fails here rather than in production. `api()` builds absolute
 * URLs from `STATION_API_BASE`; the Hono app is mounted at `/api/skills`.
 */
function stubFetchAtSkillRoutes(
  skillService: ReturnType<typeof skillServiceDouble>,
) {
  const app = createSkillRoutes(skillService as never, () => '/home/test');
  vi.stubGlobal(
    'fetch',
    async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname.startsWith('/api/skills')).toBe(true);
      const path = url.pathname.replace(/^\/api\/skills/, '') || '/';
      return app.request(`${path}${url.search}`, init);
    },
  );
}

describe('station-control catalog tools', () => {
  const previousApiBase = process.env.STATION_API_BASE;

  beforeEach(() => {
    process.env.STATION_API_BASE = 'http://station-control.test';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousApiBase === undefined) delete process.env.STATION_API_BASE;
    else process.env.STATION_API_BASE = previousApiBase;
  });

  // The Playbooks→Skills merge deleted every *_playbook/*_prompt tool. These
  // are the skills equivalents that replaced them; the noun is the whole
  // point, so the registry is asserted by exact name.
  test('exposes the skills vocabulary and no retired playbook or prompt tool', () => {
    const names = [...collectTools().keys()];

    expect(names).toEqual([
      'list_skills',
      'list_registry_skills',
      'install_skill',
      'uninstall_skill',
      'update_skill',
      'track_skill_run',
      'record_skill_outcome',
    ]);
    expect(names.some((name) => /playbook|prompt/.test(name))).toBe(false);
  });

  test('update_skill writes through the skills route, not a parallel path', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('update_skill')!({
      name: 'ship-it',
      body: 'Do the thing.',
      description: 'Shipping',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
    });
    // The tool must pass the name as the ROUTE key and everything else as the
    // body — a tool that also sent `name` in the payload would rename the
    // skill on every update.
    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'ship-it',
      { body: 'Do the thing.', description: 'Shipping' },
      '/home/test',
    );
  });

  test('track_skill_run counts one use, resolving a legacy identifier', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('track_skill_run')!({
      name: 'legacy-uuid',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      data: { name: 'ship-it', stats: { runs: 1 } },
    });
    expect(skillService.trackSkillRun).toHaveBeenCalledWith('ship-it');
  });

  test('record_skill_outcome forwards the verdict it was given', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('record_skill_outcome')!({
      name: 'ship-it',
      outcome: 'success',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: true,
      data: { name: 'ship-it', stats: { successes: 1, qualityScore: 100 } },
    });
    expect(skillService.recordSkillOutcome).toHaveBeenCalledWith(
      'ship-it',
      'success',
    );
  });

  test('a counter tool on a name nothing claims is a 404, never a silent zero', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('track_skill_run')!({
      name: 'nothing-like-this',
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      success: false,
    });
    expect(skillService.trackSkillRun).not.toHaveBeenCalled();
  });
  // `mcp-manager.ts` stamps `_sourceContext` onto an agent-authored
  // `update_skill`. Before this it was declared nowhere and translated
  // nowhere, so an agent's edit succeeded carrying none of the promised
  // agent/conversation provenance (review M2).
  test('update_skill records the agent provenance the manager stamps', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    await collectTools().get('update_skill')!({
      name: 'ship-it',
      body: 'Do the thing.',
      _sourceContext: {
        kind: 'agent',
        agentSlug: 'station',
        conversationId: 'conv-1',
      },
    });

    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'ship-it',
      {
        body: 'Do the thing.',
        // `updatedFrom` only: an agent editing a user's skill does not become
        // its author, so `createdFrom` is untouched.
        provenance: {
          updatedFrom: {
            kind: 'agent',
            agentSlug: 'station',
            conversationId: 'conv-1',
          },
        },
      },
      '/home/test',
    );
    // ...and the private field never reaches the editable body.
    expect(skillService.updateLocalSkill.mock.calls[0][1]).not.toHaveProperty(
      '_sourceContext',
    );
  });

  test('a rename travels as newName, never as a body name on a plain update', async () => {
    const skillService = skillServiceDouble();
    stubFetchAtSkillRoutes(skillService);

    await collectTools().get('update_skill')!({
      name: 'ship-it',
      newName: 'ship-it-fast',
    });

    expect(skillService.updateLocalSkill).toHaveBeenCalledWith(
      'ship-it',
      { name: 'ship-it-fast' },
      '/home/test',
    );
  });

  // The route answers a command declaration on a read-only skill with a 409.
  // The narrow tool schema could not express `command` at all, so this
  // behaviour was unreachable through the MCP boundary (review M2).
  test('a command declaration on a read-only skill surfaces the route 409', async () => {
    const skillService = skillServiceDouble();
    skillService.isSkillWritable.mockReturnValue(false);
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('update_skill')!({
      name: 'ship-it',
      command: { enabled: true },
    });

    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.success).toBe(false);
    expect(envelope.error).toContain('read-only');
    expect(skillService.updateLocalSkill).not.toHaveBeenCalled();
  });

  // Counters that exist but cannot be read are a 503 naming the file, never a
  // silent zero — and that has to survive the tool boundary too.
  test('an unreadable usage store surfaces the route 503 through the tool', async () => {
    const skillService = skillServiceDouble();
    skillService.trackSkillRun.mockRejectedValue(
      new SkillUsageUnreadableError('/home/test/skills/.usage.json'),
    );
    stubFetchAtSkillRoutes(skillService);

    const result = await collectTools().get('track_skill_run')!({
      name: 'ship-it',
    });

    const envelope = JSON.parse(result.content[0].text);
    expect(envelope.success).toBe(false);
    expect(envelope.error).toContain('.usage.json');
    expect(envelope.error).toContain('left untouched');
  });
  // The recording registry above ignores the declared shape, so every handler
  // test would pass on a tool that cannot actually express its arguments. This
  // asserts the SHAPE: a narrow tool is how the route's command/variables 409
  // became unreachable in the first place (review M2).
  test('update_skill declares every field its route accepts', () => {
    const shape = collectShapes().get('update_skill');
    if (!shape) throw new Error('update_skill was not registered');

    // Derived from the route schema rather than re-listed here, so the two
    // cannot drift apart silently.
    const deliberatelyNotDeclared: Record<string, string> = {
      // The route key. A rename travels as `newName` so a plain update can
      // never rename the skill by accident.
      name: 'the route key; renames travel as newName',
      // An agent asserting its own `provenance` is a label nothing derived.
      // The trusted path is `_sourceContext`, which the manager stamps and the
      // route honours only for an internal-token request.
      provenance:
        'self-asserted provenance; _sourceContext is the trusted path',
    };
    const declared = new Set(Object.keys(shape));

    expect(declared.has('name')).toBe(true);
    expect(declared.has('newName')).toBe(true);
    for (const key of Object.keys(localSkillCreateSchema.shape)) {
      const excused = key in deliberatelyNotDeclared;
      expect({ key, declared: declared.has(key) }).toEqual({
        key,
        // `name` IS declared (as the route key); `provenance` must not be.
        declared: key === 'name' ? true : !excused,
      });
    }
  });

  test('update_skill accepts a command declaration and variable metadata', () => {
    const shape = collectShapes().get('update_skill');
    if (!shape) throw new Error('update_skill was not registered');

    expect(
      shape.command.safeParse({ enabled: true, name: 'ship', global: true }),
    ).toMatchObject({ success: true });
    expect(
      shape.variables.safeParse([{ name: 'ticket', description: 'Issue key' }]),
    ).toMatchObject({ success: true });
    expect(
      shape._sourceContext.safeParse({ kind: 'agent', agentSlug: 'station' }),
    ).toMatchObject({ success: true });
  });
});
