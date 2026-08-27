// @vitest-environment node

/**
 * The reserved Station identity's engine binding: one authority, one write
 * boundary, one read projection (station#3662 delta H2/H3/M2;
 * `docs/design/agent-engine-unification.md` §7.1.1).
 *
 * These tests run against a REAL temp home through the real
 * `config-loader-agents` persistence functions, because every claim here is
 * about what ends up in `agents/<slug>/agent.json` — a mock loader would only
 * prove the service passed something along.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  agentOps: { add: vi.fn() },
}));

const {
  createAgentConfig,
  listAgentConfigs,
  loadAgentConfig,
  mutateAgentConfig,
  updateAgentConfig,
} = await import('../../../domain/config-loader-agents.js');
const { AgentService } = await import('../agent-service.js');
const { agentCatalogReadSeam } = await import(
  '../../../routes/agents/enriched-agents.js'
);

/**
 * The source text of one function/method body, brace-matched from its
 * declaration.
 *
 * The guards below count call sites INSIDE a specific body rather than
 * anywhere in the file, which is what makes them non-vacuous: the previous
 * version passed while `getAgent` no longer called the helper, because a
 * docblock still named it.
 */
function methodBody(source: string, name: string): string {
  const candidates = source.matchAll(
    new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:private\\s+|public\\s+|protected\\s+|static\\s+)*(?:async\\s+)?(?:function\\s+)?${name}\\s*(?:<[^>]*>)?\\s*\\(`,
      'g',
    ),
  );
  for (const candidate of candidates) {
    const signatureOpen = candidate.index + candidate[0].length - 1;
    const signatureClose = matchDelimiter(source, signatureOpen, '(', ')');
    // A DECLARATION's signature closes into a body; a CALL SITE closes into
    // `,`/`;`/`)`. Without this, the first match in `listAgents` is the call
    // to `projectStationEngineBinding` itself and the guard reads some
    // unrelated block — which is exactly how it reported 0 call sites for a
    // function that plainly has them.
    let cursor = signatureClose + 1;
    while (cursor < source.length && !'{,;).'.includes(source[cursor])) {
      cursor += 1;
    }
    if (source[cursor] !== '{') continue;
    return source.slice(cursor, matchDelimiter(source, cursor, '{', '}') + 1);
  }
  throw new Error(
    `${name} is not declared in this file — the guard is reading the wrong source`,
  );
}

/** Index of the delimiter closing the one that opens at `open`. */
function matchDelimiter(
  source: string,
  open: number,
  opener: string,
  closer: string,
): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === opener) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`unbalanced ${opener}${closer} from index ${open}`);
}

/** Call sites of `name` in `source`, ignoring bare mentions in prose. */
function callCount(source: string, name: string): number {
  return source.split(`${name}(`).length - 1;
}

/**
 * The `createEnrichedAgentRoutes({ ... })` argument object, brace-matched, so
 * the wiring assertions read the CALL rather than the whole file (where a
 * comment elsewhere could satisfy them).
 */
function createEnrichedAgentRoutesCall(source: string): string {
  const marker = 'createEnrichedAgentRoutes({';
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error('runtime-routes.ts no longer builds the enriched catalog');
  }
  const open = start + marker.length - 1;
  return source.slice(open, matchDelimiter(source, open, '{', '}') + 1);
}

describe('the Station identity binding is app state, not Agent state', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'station-binding-projection-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeAgent(slug: string, spec: Record<string, unknown>) {
    const dir = join(home, 'agents', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent.json'), JSON.stringify(spec, null, 2));
  }

  function readAgent(slug: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(home, 'agents', slug, 'agent.json'), 'utf8'),
    );
  }

  /**
   * The service over the real loader functions. Only the surface
   * `AgentService` actually calls is provided, so an unexpected new call site
   * fails loudly instead of silently reading a stub.
   */
  function service(runtimeStationExecution?: AgentSpec['execution']) {
    const configLoader = {
      listAgents: () => listAgentConfigs(home),
      loadAgent: (slug: string) => loadAgentConfig(home, slug),
      createAgent: (spec: AgentSpec) => createAgentConfig(home, spec),
      updateAgent: (slug: string, updates: Partial<AgentSpec>) =>
        updateAgentConfig(home, slug, updates),
      mutateAgent: (
        slug: string,
        mutate: (current: AgentSpec) => AgentSpec | null,
      ) => mutateAgentConfig(home, slug, mutate),
      loadACPConfig: async () => ({ connections: [] }),
    };
    // The runtime's own metadata map: `bootstrapRuntimeDefaultAgent` records
    // the resolved built-in engine under the internal `default` key.
    const agentMetadataMap = new Map<string, unknown>([
      [
        'default',
        {
          slug: 'default',
          name: 'Station',
          ...(runtimeStationExecution
            ? { execution: runtimeStationExecution }
            : {}),
        },
      ],
    ]);
    return new AgentService(
      configLoader as never,
      { findLayoutsUsingAgent: () => [] } as never,
      new Map(),
      agentMetadataMap as never,
      new Map(),
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    );
  }

  describe('`execution: null` clears a binding (review HIGH-2 / delta H2)', () => {
    test('a Codex-bound Agent switched to Station loses its binding on disk', async () => {
      writeAgent('writer', {
        name: 'Writer',
        prompt: 'Write.',
        execution: { agentConnectionId: 'codex', modelId: 'gpt-5' },
      });

      await service().updateAgent('writer', { execution: null });

      // The whole point of the save: the record no longer names an engine, so
      // `resolveExecutionTarget` takes its unbound (Station's own engine)
      // branch. `AgentService.updateAgent` used to drop every null except
      // `project`, so the clear signal never reached the loader and the Codex
      // binding survived a save that visibly changed the engine.
      expect(readAgent('writer')).not.toHaveProperty('execution');
    });

    test('an omitted execution block still means "no change"', async () => {
      writeAgent('writer', {
        name: 'Writer',
        prompt: 'Write.',
        execution: { agentConnectionId: 'codex' },
      });

      await service().updateAgent('writer', { description: 'Prose.' });

      expect(readAgent('writer')).toMatchObject({
        description: 'Prose.',
        execution: { agentConnectionId: 'codex' },
      });
    });

    test('a from-scratch materialization never persists the null itself', async () => {
      // `updateAgent` materializes a virtual Agent on first save. There is
      // nothing to clear, and a persisted `null` would be a second spelling
      // of "absent".
      await service().updateAgent('fresh', {
        name: 'Fresh',
        prompt: 'New.',
        execution: null,
      });

      expect(readAgent('fresh')).not.toHaveProperty('execution');
    });
  });

  describe('the record never carries the binding (delta H3, write boundary)', () => {
    test('a submitted binding is REFUSED, not silently stripped (delta-2 HIGH)', async () => {
      // The strip alone kept the file honest and lied to the caller: a 2xx
      // for a write that did not happen. Any API/SDK/CLI client submitting a
      // binding for this identity now learns it, and learns where the
      // setting lives.
      writeAgent('station', {
        name: 'Station',
        prompt: '',
        execution: { modelId: 'pinned-model' },
      });

      await expect(
        service({ agentConnectionId: engineConnectionId('codex') }).updateAgent(
          'station',
          {
            prompt: 'Be helpful.',
            execution: { agentConnectionId: 'codex', modelId: 'pinned-model' },
          },
        ),
      ).rejects.toThrow(/builtinAgentEngineConnectionId/);

      // And it is a refusal, not a partial write: the unrelated prompt change
      // in the same body did not land either.
      expect(readAgent('station')).toEqual({
        name: 'Station',
        prompt: '',
        execution: { modelId: 'pinned-model' },
      });
    });

    test('a create is refused the same way', async () => {
      await expect(
        service().createAgent({
          slug: 'station',
          name: 'Station',
          prompt: '',
          execution: { agentConnectionId: engineConnectionId('codex') },
        }),
      ).rejects.toThrow(/builtinAgentEngineConnectionId/);
    });

    test('the write boundary still strips, for the records the refusal never sees', async () => {
      // Defence in depth, and not redundant: the refusal guards the API
      // doors, while THIS is what a legacy record written by an older build
      // meets on its next ordinary save. Reached here through the loader —
      // the same door `materializeStationAgent`'s heal uses.
      writeAgent('station', {
        name: 'Station',
        prompt: '',
        execution: { agentConnectionId: 'codex', modelId: 'pinned-model' },
      });

      const persisted = await updateAgentConfig(home, 'station', {
        prompt: 'Be helpful.',
      } as never);

      expect(persisted.prompt).toBe('Be helpful.');
      // The user's own model pin survives; only the binding is dropped.
      expect(persisted.execution).toEqual({ modelId: 'pinned-model' });
      expect(readAgent('station').execution).toEqual({
        modelId: 'pinned-model',
      });
    });

    test('the projection is what a caller reads back', async () => {
      // The save response is a read: the editor loads it straight into its
      // form, so an accepted save must not flip the form to "Station" while
      // the runtime is on Codex.
      writeAgent('station', { name: 'Station', prompt: '' });

      const returned = await service({
        agentConnectionId: engineConnectionId('codex'),
      }).updateAgent('station', { prompt: 'Be helpful.' });

      expect(returned.execution).toEqual({ agentConnectionId: 'codex' });
      expect(readAgent('station')).not.toHaveProperty('execution');
    });

    test('a custom Agent keeps the binding both guards refuse for `station`', async () => {
      // Both the refusal and the strip are scoped to the one reserved
      // identity. If either widened, every external Agent would become
      // unbindable — or silently become a Station Agent on save.
      await service().createAgent({
        slug: 'writer',
        name: 'Writer',
        prompt: 'Write.',
        execution: { agentConnectionId: engineConnectionId('codex') },
      });

      expect(readAgent('writer')).toMatchObject({
        execution: { agentConnectionId: 'codex' },
      });
    });
  });

  describe('every read goes through the service projection (delta H3/M2)', () => {
    test('getAgent reports the runtime engine, not the unbound file', async () => {
      writeAgent('station', { name: 'Station', prompt: '' });

      const spec = await service({
        agentConnectionId: engineConnectionId('codex'),
      }).getAgent('station');

      expect(spec.execution).toEqual({ agentConnectionId: 'codex' });
    });

    test('listAgents agrees with getAgent', async () => {
      writeAgent('station', { name: 'Station', prompt: '' });

      const listed = await service({
        agentConnectionId: engineConnectionId('codex'),
      }).listAgents();

      expect(
        listed.find((agent) => agent.slug === 'station')?.execution,
      ).toEqual({ agentConnectionId: 'codex' });
    });

    test('an unhealed record is never honoured, whatever it names', async () => {
      // A home this process could not heal (read-only mount, a filesystem
      // that refuses the atomic replace). Both the impossible literal
      // `station` and a stale real connection left by an older build are
      // ignored — the app-level selection is the authority, and here it
      // resolved to Station's own engine.
      writeAgent('station', {
        name: 'Station',
        prompt: '',
        execution: { agentConnectionId: 'station', modelId: 'pinned-model' },
      });
      writeAgent('legacy-station', { name: 'Legacy', prompt: '' });

      const unhealed = await service().getAgent('station');
      expect(unhealed.execution).toEqual({ modelId: 'pinned-model' });

      writeAgent('station', {
        name: 'Station',
        prompt: '',
        execution: { agentConnectionId: 'codex' },
      });
      expect((await service().getAgent('station')).execution).toBeUndefined();
    });

    test('a custom Agent is projected verbatim', async () => {
      writeAgent('writer', {
        name: 'Writer',
        prompt: 'Write.',
        execution: { agentConnectionId: 'codex' },
      });

      const spec = await service({
        agentConnectionId: engineConnectionId('claude'),
      }).getAgent('writer');

      expect(spec.execution).toEqual({ agentConnectionId: 'codex' });
    });
  });
});

/**
 * The projection is structural only while it has one home, and the previous
 * version of this guard could not prove that (delta-2 MEDIUM): it matched one
 * exact wiring STRING, which a comment satisfies while production rebinds
 * `loadAgent` to the loader, and its helper-name check passed as long as the
 * names appeared anywhere in the seam file — including in a docblock, after
 * `getAgent` stopped calling them.
 *
 * So the load-bearing half is behavioural now. What remains grep-shaped is
 * only the negative claim a test cannot make by executing: that NO OTHER
 * production file re-derives the projection.
 */
describe('the Station binding projection has exactly one home', () => {
  describe('behavioural: the catalog reads through the service', () => {
    test('agentCatalogReadSeam resolves loadAgent through AgentService.getAgent', async () => {
      // The exact wiring `runtime-routes.ts` spreads into
      // `createEnrichedAgentRoutes`. Rebinding it to `ConfigLoader.loadAgent`
      // is what sends every reader of `/api/agents` back to the raw file.
      const agentService = {
        getAgent: vi.fn(async () => ({ name: 'Station', prompt: '' })),
        listAgents: vi.fn(async () => [{ slug: 'station', name: 'Station' }]),
      };

      const seam = agentCatalogReadSeam(agentService as never);
      await seam.loadAgent('station');
      await seam.listAgents?.();

      expect(agentService.getAgent).toHaveBeenCalledWith('station');
      expect(agentService.listAgents).toHaveBeenCalled();
    });

    test('the seam passes the service’s answer through unchanged', async () => {
      // Not merely "getAgent was called": the value the route receives must be
      // the projected one, so a seam that called the service and then returned
      // something else would still fail here.
      const projected = {
        name: 'Station',
        prompt: '',
        execution: { agentConnectionId: 'codex' },
      };
      const seam = agentCatalogReadSeam({
        getAgent: async () => projected,
        listAgents: async () => [],
      } as never);

      await expect(seam.loadAgent('station')).resolves.toBe(projected);
    });

    test('a loader-wired seam fails this test', async () => {
      // The negative control, run rather than asserted in prose: this is the
      // regression the guard exists to catch, and it must be observable from
      // the seam's own behaviour.
      const agentService = {
        getAgent: vi.fn(),
        listAgents: vi.fn(async () => []),
      };
      const configLoader = {
        loadAgent: vi.fn(async (_slug: string) => ({
          name: 'Station',
          prompt: '',
        })),
      };
      const loaderWired: Pick<
        ReturnType<typeof agentCatalogReadSeam>,
        'loadAgent'
      > = { loadAgent: (slug: string) => configLoader.loadAgent(slug) };

      await loaderWired.loadAgent('station');

      expect(agentService.getAgent).not.toHaveBeenCalled();
      expect(configLoader.loadAgent).toHaveBeenCalled();
    });

    test('the runtime route wires the catalog through that seam', () => {
      // Grep, but for the SEAM CALL rather than a lambda's spelling: the
      // deps object must be built by `agentCatalogReadSeam`, and must not
      // declare `loadAgent`/`listAgents` keys of its own that would override
      // it. `.bind(...)`, a differently-spaced arrow, or any other loader
      // wiring is a `loadAgent:` key and fails.
      const source = readFileSync(
        'src-server/runtime/routes/runtime-routes.ts',
        'utf8',
      );
      const call = createEnrichedAgentRoutesCall(source);
      expect(call).toContain('...agentCatalogReadSeam(context.agentService)');
      expect(call).not.toMatch(/\bloadAgent\s*:/);
      expect(call).not.toMatch(/\blistAgents\s*:/);
    });
  });

  describe('structural: the seam still applies the projection', () => {
    const SERVICE = 'src-server/services/agents/agent-service.ts';

    test.each(['getAgent', 'listAgents'])(
      '%s calls projectStationEngineBinding',
      (method) => {
        // Counted inside the METHOD BODY, not anywhere in the file: the old
        // check passed on a file that merely mentioned the helper. The
        // behavioural projection tests above would also redden — this states
        // the requirement where a reader of the service will see it.
        const body = methodBody(readFileSync(SERVICE, 'utf8'), method);
        expect(callCount(body, 'projectStationEngineBinding')).toBeGreaterThan(
          0,
        );
      },
    );

    test('the projection itself is derived from both halves', () => {
      // The runtime overlay AND the fallback that copes with a home the heal
      // could not write. Dropping either is a silent half-projection.
      const body = methodBody(
        readFileSync(SERVICE, 'utf8'),
        'projectStationEngineBinding',
      );
      expect(callCount(body, 'runtimeStationEngineExecution')).toBeGreaterThan(
        0,
      );
      expect(callCount(body, 'withoutReservedStationBinding')).toBeGreaterThan(
        0,
      );
    });
  });

  describe('negative: nothing outside the seam re-derives it', () => {
    const PROJECTION_HELPERS = [
      'runtimeStationEngineExecution',
      'withoutReservedStationBinding',
    ];

    /**
     * THE ALLOWED SEAM. Every other production file naming a projection helper
     * is a second authority by definition.
     *
     * Known blind spot, same as `receipt-bus.production-usage.test.ts`:
     * `git grep` sees only tracked files, so a brand-new unstaged production
     * file is invisible here until it is added.
     */
    const ALLOWED_FILES = new Set([
      // The definition, the startup heal, and the write boundary.
      'src-server/domain/agent-registry.ts',
      'src-server/domain/config-loader-agents.ts',
      // The read projection every route/CLI/MCP reader consumes.
      'src-server/services/agents/agent-service.ts',
      // Prose only: the adoption path explains why a failed heal is survivable.
      'src-server/runtime/bootstrap/native-engine-adoption.ts',
    ]);

    const PRODUCTION_PATHSPEC = [
      'src-server/',
      'src-ui/',
      'packages/',
      'plugins/',
      ':!**/__tests__/**',
      ':!**/*.test.ts',
      ':!**/*.test.tsx',
    ];

    function gitGrepFiles(pattern: string): string[] {
      try {
        return execFileSync(
          'git',
          ['grep', '-I', '-l', '-F', pattern, '--', ...PRODUCTION_PATHSPEC],
          { encoding: 'utf8', windowsHide: true },
        )
          .trim()
          .split('\n')
          .filter(Boolean);
      } catch (error) {
        const status = (error as { status?: number | null }).status;
        // 1 is git grep's documented "no matches". Anything else (a malformed
        // pathspec, git missing) must not read as a clean repo — that is how a
        // guard reports success for a scan it never performed.
        if (status === 1) return [];
        throw error;
      }
    }

    test.each(PROJECTION_HELPERS)(
      'no production file outside the seam names %s',
      (helper) => {
        const files = gitGrepFiles(helper);
        // Positive control: a pathspec that matches nothing looks identical to
        // a clean repo. The seam itself must always be in the results.
        expect(files).toContain('src-server/services/agents/agent-service.ts');
        expect(files.filter((file) => !ALLOWED_FILES.has(file))).toEqual([]);
      },
    );

    test('the catalog route re-derives nothing', () => {
      const source = readFileSync(
        'src-server/routes/agents/enriched-agents.ts',
        'utf8',
      );
      for (const helper of PROJECTION_HELPERS) {
        expect(source).not.toContain(`${helper}(`);
      }
    });
  });
});
