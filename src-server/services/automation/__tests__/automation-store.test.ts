import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  AUTOMATION_EXECUTION_LIMITS,
  type AutomationAction,
  type AutomationGrant,
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

    const MAX_ID = 'i'.repeat(128);
    const withRule = (c: any, change: (rule: any) => any) => ({
      ...c,
      rules: [change(c.rules[0])],
    });
    const withSource = (c: any, change: (source: any) => any) => ({
      ...c,
      sources: [change(c.sources[0]), ...c.sources.slice(1)],
    });
    const withWhere = (c: any, where: unknown) =>
      withRule(c, (rule) => ({ ...rule, match: { ...rule.match, where } }));
    test.each([
      [
        'an unknown top-level field',
        (c: any) => ({ ...c, extra: true }),
        /configuration: unknown field extra/,
      ],
      [
        'an unknown source field',
        (c: any) => withSource(c, (s) => ({ ...s, allowFork: true })),
        /sources\[0\]: unknown field allowFork/,
      ],
      [
        'an unknown source kind',
        (c: any) => withSource(c, (s) => ({ ...s, kind: 'gitlab-poll' })),
        /sources\[0\]: unknown source kind/,
      ],
      [
        'a regex-shaped matcher value',
        (c: any) => withWhere(c, { 'run.head_branch': { regex: '^main$' } }),
        /where\.run\.head_branch: must be an exact string or list/,
      ],
      [
        'a numeric matcher value',
        (c: any) => withWhere(c, { 'run.id': 1 }),
        /where\.run\.id: must be an exact string or list/,
      ],
      [
        'an empty where',
        (c: any) => withWhere(c, {}),
        /where: must name at least one field/,
      ],
      [
        'a matcher on a field the event never carries',
        (c: any) => withWhere(c, { 'head_commit.message': 'fix' }),
        /where: unknown field head_commit\.message/,
      ],
      [
        'a matcher value one past the length bound',
        (c: any) => withWhere(c, { 'run.head_branch': 'b'.repeat(257) }),
        /where\.run\.head_branch: must be an exact string or list/,
      ],
      [
        'a source without the rule grant',
        (c: any) => withSource(c, (s) => ({ ...s, grants: undefined })),
        /rules\[0\]: action is not granted by source/,
      ],
      [
        'a source id one past the length bound',
        (c: any) => withSource(c, (s) => ({ ...s, id: `${MAX_ID}x` })),
        /sources\[0\]: id invalid/,
      ],
      [
        'a grant agent id one past the length bound',
        (c: any) =>
          withSource(c, (s) => ({
            ...s,
            grants: [{ ...s.grants[0], agentId: `${MAX_ID}x` }],
          })),
        /grants\[0\]: agentId invalid/,
      ],
      [
        'a credential binding one past the length bound',
        (c: any) =>
          withSource(c, (s) => ({
            ...s,
            credentialSecretBinding: `${MAX_ID}x`,
          })),
        /credentialSecretBinding invalid/,
      ],
      [
        'a webhook secret under the floor',
        (c: any) => ({
          ...c,
          sources: [c.sources[0], { ...c.sources[1], secret: 'short' }],
        }),
        /sources\[1\]: secret must be 32 to 256 characters/,
      ],
      [
        'a webhook secret one past the ceiling',
        (c: any) => ({
          ...c,
          sources: [c.sources[0], { ...c.sources[1], secret: 's'.repeat(257) }],
        }),
        /sources\[1\]: secret must be 32 to 256 characters/,
      ],
    ])(
      'an invalid file with %s is refused on read',
      async (_name, edit, problem) => {
        const { source } = await grantedSource();
        await store.createRule(ruleInput(source.id));
        await store.createSource({
          kind: 'github-webhook',
          name: 'push',
          repository: 'kontourai/station',
        });
        const valid = JSON.parse(readFileSync(store.path, 'utf8'));
        writeFileSync(store.path, JSON.stringify(edit(valid)), 'utf8');
        expect(() => store.read()).toThrow(
          expect.objectContaining({
            code: 'policy_unavailable',
            detail: expect.stringMatching(problem),
          }),
        );
      },
    );

    test('values at their bounds are accepted', async () => {
      const { source } = await grantedSource();
      await store.createRule(ruleInput(source.id));
      const valid = JSON.parse(readFileSync(store.path, 'utf8'));
      const atBounds = withWhere(
        withSource(valid, (s) => ({
          ...s,
          credentialSecretBinding: MAX_ID,
          grants: [{ ...s.grants[0], agentId: MAX_ID }],
        })),
        { 'run.head_branch': 'b'.repeat(256) },
      );
      atBounds.rules[0].action.agentId = MAX_ID;
      writeFileSync(store.path, JSON.stringify(atBounds), 'utf8');
      expect(store.read().rules).toHaveLength(1);
    });

    test.skipIf(process.platform === 'win32')(
      'a file readable by group or others is refused as insecure',
      async () => {
        await grantedSource();
        chmodSync(store.path, 0o644);
        expect(() => store.read()).toThrow(
          expect.objectContaining({ detail: 'insecure permissions' }),
        );
        chmodSync(store.path, 0o600);
        expect(store.read().sources).toHaveLength(1);
      },
    );

    test('a file one byte past the size ceiling is refused, never truncated', async () => {
      await grantedSource();
      const valid = readFileSync(store.path, 'utf8');
      const ceiling = AUTOMATION_EXECUTION_LIMITS.maxConfigurationBytes;
      // JSON whitespace keeps the content valid at exactly the ceiling.
      writeFileSync(store.path, valid.padEnd(ceiling, ' '), 'utf8');
      expect(store.read().sources).toHaveLength(1);
      writeFileSync(store.path, valid.padEnd(ceiling + 1, ' '), 'utf8');
      expect(() => store.read()).toThrow(
        expect.objectContaining({ detail: 'file too large' }),
      );
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

    test('a revoked or disabled source grants nothing at run time', async () => {
      const { source } = await grantedSource();
      const rule = await store.createRule(ruleInput(source.id));
      const config = JSON.parse(readFileSync(store.path, 'utf8'));
      const write = (sourceChange: object) =>
        writeFileSync(
          store.path,
          JSON.stringify({
            ...config,
            sources: [{ ...config.sources[0], ...sourceChange }],
            rules: [{ ...config.rules[0], enabled: true }],
          }),
          'utf8',
        );
      write({ enabled: true });
      expect(store.actionableRules(source.id).map(({ id }) => id)).toEqual([
        rule.id,
      ]);
      write({ enabled: false });
      expect(store.actionableRules(source.id)).toEqual([]);
      write({ enabled: true, revokedAt: '2026-10-05T00:00:00.000Z' });
      // Revocation keeps the file valid but stops the rule acting.
      expect(store.read().rules).toHaveLength(1);
      expect(store.actionableRules(source.id)).toEqual([]);
      await expect(store.createRule(ruleInput(source.id))).rejects.toThrow(
        /is revoked/,
      );
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
