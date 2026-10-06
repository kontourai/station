import { readFileSync, statSync, writeFileSync } from 'node:fs';
import type {
  AutomationAction,
  AutomationGrant,
} from '@kontourai/station-contracts/automation';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  AutomationPolicyUnavailableError,
  AutomationStore,
  AutomationValidationError,
  type CreateAutomationRuleInput,
} from '../automation-store.js';

const makeTempDir = trackTempDirs();

const GRANT: AutomationGrant = {
  projectId: 'station',
  agentId: 'repairer',
  actions: ['dispatch-task'],
};

const DISPATCH: AutomationAction = {
  kind: 'dispatch-task',
  projectId: 'station',
  agentId: 'repairer',
  instructions: 'Diagnose the failing qualification run.',
  budget: { maxTurns: 4, maxTokens: 200_000, maxWallRuntimeMs: 1_800_000 },
};

function ruleInput(
  sourceId: string,
  overrides: Partial<CreateAutomationRuleInput> = {},
): CreateAutomationRuleInput {
  return {
    name: 'Repair main qualification',
    sourceId,
    match: {
      type: 'github.workflow_run.completed',
      where: {
        'workflow.path': '.github/workflows/main-qualification.yml',
        'run.head_branch': 'main',
        'run.conclusion': ['failure', 'timed_out'],
      },
    },
    episode: {
      keyFields: ['repository', 'workflow.path', 'run.head_branch'],
      closeOn: {
        type: 'github.workflow_run.completed',
        where: { 'run.conclusion': 'success' },
      },
      maxAttempts: 1,
    },
    action: DISPATCH,
    rateLimit: { maxStartsPerHour: 2 },
    ...overrides,
  };
}

describe('AutomationStore', () => {
  let home: string;
  let store: AutomationStore;

  beforeEach(() => {
    home = makeTempDir('automation-store-');
    store = new AutomationStore(home);
  });

  async function grantedSource() {
    return store.createSource({
      kind: 'github-poll',
      name: 'station',
      repository: 'kontourai/station',
      grants: [GRANT],
    });
  }

  test('a missing file reads as an empty configuration', () => {
    expect(store.read()).toEqual({ schemaVersion: 1, sources: [], rules: [] });
  });

  test('round-trips sources and rules through a fresh store on the same home', async () => {
    const { source } = await grantedSource();
    const rule = await store.createRule(ruleInput(source.id));

    const reread = new AutomationStore(home).read();
    expect(reread.sources).toEqual([
      {
        id: source.id,
        kind: 'github-poll',
        name: 'station',
        repository: 'kontourai/station',
        enabled: false,
        grants: [GRANT],
      },
    ]);
    expect(reread.rules).toEqual([rule]);
  });

  test('writes the file 0600 inside a 0700 security directory', async () => {
    await grantedSource();
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(statSync(`${home}/security`).mode & 0o777).toBe(0o700);
  });

  test('creates sources and rules disabled with server-issued ids', async () => {
    const { source } = await grantedSource();
    const rule = await store.createRule(ruleInput(source.id));
    expect(source.enabled).toBe(false);
    expect(rule.enabled).toBe(false);
    expect(source.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rule.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rule.id).not.toBe(source.id);
  });

  test('a webhook secret is returned once and never projected', async () => {
    const created = await store.createSource({
      kind: 'github-webhook',
      name: 'station push',
      repository: 'kontourai/station',
    });
    expect(created.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(created.source).toMatchObject({ hasSecret: true });
    expect(created.source).not.toHaveProperty('secret');
    expect(JSON.stringify(store.listSources())).not.toContain(created.secret);
    // The secret is persisted locally for signature verification.
    expect(readFileSync(store.path, 'utf8')).toContain(created.secret);
  });

  describe('fails closed', () => {
    test('corrupt JSON throws policy_unavailable, never an empty config', async () => {
      await grantedSource();
      writeFileSync(store.path, '{"schemaVersion":1,"sources":[', 'utf8');
      expect(() => store.read()).toThrow(AutomationPolicyUnavailableError);
      expect(() => store.read()).toThrow(
        expect.objectContaining({ code: 'policy_unavailable' }),
      );
      expect(() => store.listSources()).toThrow(
        AutomationPolicyUnavailableError,
      );
    });

    test('a mutation never overwrites a corrupt file', async () => {
      await grantedSource();
      writeFileSync(store.path, 'not json', 'utf8');
      await expect(grantedSource()).rejects.toBeInstanceOf(
        AutomationPolicyUnavailableError,
      );
      expect(readFileSync(store.path, 'utf8')).toBe('not json');
    });

    test.each([
      ['an unknown top-level field', (c: any) => ({ ...c, extra: true })],
      [
        'an unknown source field',
        (c: any) => ({
          ...c,
          sources: [{ ...c.sources[0], allowFork: true }],
        }),
      ],
      [
        'an unknown source kind',
        (c: any) => ({
          ...c,
          sources: [{ ...c.sources[0], kind: 'gitlab-poll' }],
        }),
      ],
      [
        'a regex-shaped matcher value',
        (c: any) => ({
          ...c,
          rules: [
            {
              ...c.rules[0],
              match: {
                ...c.rules[0].match,
                where: { 'run.head_branch': { regex: '^main$' } },
              },
            },
          ],
        }),
      ],
      [
        'a matcher on a field the event never carries',
        (c: any) => ({
          ...c,
          rules: [
            {
              ...c.rules[0],
              match: {
                ...c.rules[0].match,
                where: { 'head_commit.message': 'fix' },
              },
            },
          ],
        }),
      ],
      [
        'a source without the rule grant',
        (c: any) => ({
          ...c,
          sources: [{ ...c.sources[0], grants: undefined }],
        }),
      ],
      [
        'a webhook secret under the floor',
        (c: any) => ({
          ...c,
          sources: [
            {
              ...c.sources[0],
              kind: 'github-webhook',
              secret: 'short',
            },
          ],
        }),
      ],
    ])('an invalid file with %s is refused on read', async (_name, edit) => {
      const { source } = await grantedSource();
      await store.createRule(ruleInput(source.id));
      const valid = JSON.parse(readFileSync(store.path, 'utf8'));
      writeFileSync(store.path, JSON.stringify(edit(valid)), 'utf8');
      expect(() => store.read()).toThrow(AutomationPolicyUnavailableError);
    });
  });

  describe('two keys', () => {
    test('a rule whose source grants nothing is refused and not written', async () => {
      const { source } = await store.createSource({
        kind: 'github-poll',
        name: 'no grants',
        repository: 'kontourai/station',
      });
      await expect(store.createRule(ruleInput(source.id))).rejects.toThrow(
        AutomationValidationError,
      );
      expect(store.read().rules).toEqual([]);
    });

    test.each([
      ['another Project', { projectId: 'other' }],
      ['another Agent', { agentId: 'other' }],
    ])(
      'a dispatch through %s than the grant names is refused',
      async (_name, change) => {
        const { source } = await grantedSource();
        await expect(
          store.createRule(
            ruleInput(source.id, { action: { ...DISPATCH, ...change } }),
          ),
        ).rejects.toThrow(/not granted by source/);
        expect(store.read().rules).toEqual([]);
      },
    );

    test('a grant for notify does not authorize dispatch, and vice versa', async () => {
      const { source } = await store.createSource({
        kind: 'github-poll',
        name: 'notify only',
        repository: 'kontourai/station',
        grants: [{ ...GRANT, actions: ['notify'] }],
      });
      await expect(store.createRule(ruleInput(source.id))).rejects.toThrow(
        /not granted/,
      );
      const notify = await store.createRule(
        ruleInput(source.id, { action: { kind: 'notify', priority: 'high' } }),
      );
      expect(notify.action).toEqual({ kind: 'notify', priority: 'high' });

      const { source: dispatchOnly } = await grantedSource();
      await expect(
        store.createRule(
          ruleInput(dispatchOnly.id, {
            action: { kind: 'notify', priority: 'high' },
          }),
        ),
      ).rejects.toThrow(/not granted/);
    });

    test('a rule naming an unknown source is refused', async () => {
      await expect(store.createRule(ruleInput('missing'))).rejects.toThrow(
        /does not name a source/,
      );
    });
  });

  test('an episode key field outside the event allow-list is refused', async () => {
    const { source } = await grantedSource();
    await expect(
      store.createRule(
        ruleInput(source.id, {
          episode: { keyFields: ['run.display_title'], maxAttempts: 1 },
        }),
      ),
    ).rejects.toThrow(/unknown key field/);
  });
});
