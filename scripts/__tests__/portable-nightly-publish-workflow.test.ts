import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  assertNotRegressing,
  checkArchives,
  compareNightlyVersions,
  createDryRunKeys,
  DRY_RUN_SIGNING_KEY_ID,
  NIGHTLY_MANIFEST_ASSET,
  portableNightlyVersion,
  publicationLocations,
  ROLLING_NIGHTLY_TAG,
  verifyExpectedManifest,
  verifyPublishedAssets,
} from '../portable-nightly-publication.mjs';
import { platformPayload } from './fixtures/release-manifest-v2';

/**
 * #2675 slice E. The portable Nightly publication must be impossible without
 * the owner's explicit gate, so these tests read the real workflow graph and
 * evaluate the publish job's own `if:` against the scenarios that must NOT
 * publish, and drive the real signer and helper CLIs as children.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: unknown;
  permissions?: Record<string, string>;
  environment?: unknown;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
};

const repoRoot = resolve(import.meta.dirname, '../..');
const workflowsDir = join(repoRoot, '.github/workflows');
const readWorkflow = (name: string) =>
  load(readFileSync(join(workflowsDir, name), 'utf8')) as Workflow;
const PUBLISH_WORKFLOW = 'portable-nightly-publish.yml';
const publication = readWorkflow(PUBLISH_WORKFLOW);
const nightly = readWorkflow('nightly.yml');
const GATE_VARIABLE = 'STATION_PORTABLE_NIGHTLY_PUBLISH';
const SIGNING_SECRET = 'STATION_PORTABLE_NIGHTLY_MANIFEST_SIGNING_KEY';

/** Top-level `&&` conjuncts of a `${{ }}` expression (never inside parens). */
function conjuncts(expression: string): string[] {
  const inner = expression
    .trim()
    .replace(/^\$\{\{|\}\}$/g, '')
    .trim();
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && inner.startsWith('&&', index)) {
      parts.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += char;
  }
  parts.push(current.trim());
  return parts;
}

type Context = {
  vars: Record<string, string>;
  ref: string;
  workflowRef: string;
  repository: string;
  reserved: string;
  assemble: string;
};

/**
 * Evaluates the publish gate's conjuncts against a scenario. Only the
 * comparison shapes the gate is allowed to use are understood; anything else
 * throws, so a rewritten gate cannot pass these scenarios by being opaque.
 */
function gateAllows(expression: string, context: Context): boolean {
  const value = (operand: string): string => {
    const literal = operand.match(/^'([^']*)'$/);
    if (literal) return literal[1];
    const variable = operand.match(/^vars\.([A-Z_]+)$/);
    if (variable) return context.vars[variable[1]] ?? '';
    const format = operand.match(/^format\('([^']*)', github\.repository\)$/);
    if (format) return format[1].replace('{0}', context.repository);
    const known: Record<string, string> = {
      'github.ref': context.ref,
      'github.workflow_ref': context.workflowRef,
      'needs.plan.outputs.reserved': context.reserved,
      'needs.assemble.result': context.assemble,
    };
    if (operand in known) return known[operand];
    throw new Error(`unrecognised gate operand: ${operand}`);
  };
  return conjuncts(expression).every((part) => {
    const comparison = part.match(/^(.+?) (==|!=) (.+)$/);
    if (!comparison) throw new Error(`unrecognised gate conjunct: ${part}`);
    const [, left, operator, right] = comparison;
    const equal = value(left.trim()) === value(right.trim());
    return operator === '==' ? equal : !equal;
  });
}

/** A literal GitHub expression, as the workflow YAML spells it. */
const expr = (inner: string) => `\${{ ${inner} }}`;
const REPOSITORY = 'kontourai/station';
const NIGHTLY_ON_MAIN = `${REPOSITORY}/.github/workflows/nightly.yml@refs/heads/main`;
const enabledNightly: Context = {
  vars: { [GATE_VARIABLE]: 'enabled' },
  ref: 'refs/heads/main',
  workflowRef: NIGHTLY_ON_MAIN,
  repository: REPOSITORY,
  reserved: 'true',
  assemble: 'success',
};

/** Every step that changes what is published or signs with the real key. */
function isPublicationEffect(step: Step): boolean {
  const run = step.run ?? '';
  return (
    /gh release (create|upload|edit|delete)|gh api[^\n]*(POST|PATCH|DELETE)/.test(
      run,
    ) ||
    (run.includes('ecosystem-manifest.mjs create') &&
      !run.includes('--allow-unpinned-key'))
  );
}

function referencesCredential(value: unknown): boolean {
  return /\bsecrets\b|github\.token|GITHUB_TOKEN/.test(JSON.stringify(value));
}

describe('portable Nightly publication workflow: the owner gate', () => {
  const publish = publication.jobs.publish;
  const gate = publish.if ?? '';

  it('publishes nothing when the owner has not set the gate variable', () => {
    expect(gate).toContain(`vars.${GATE_VARIABLE} == 'enabled'`);
    for (const value of [undefined, '', 'true', 'Enabled', 'enabled ']) {
      const vars: Record<string, string> =
        value === undefined ? {} : { [GATE_VARIABLE]: value };
      expect(gateAllows(gate, { ...enabledNightly, vars }), String(value)).toBe(
        false,
      );
    }
  });

  it('keeps a direct dispatch, on main or any branch, a dry run even with the gate enabled', () => {
    for (const context of [
      {
        ...enabledNightly,
        workflowRef: `${REPOSITORY}/.github/workflows/${PUBLISH_WORKFLOW}@refs/heads/main`,
        reserved: 'false',
      },
      {
        ...enabledNightly,
        ref: 'refs/heads/feat/x',
        workflowRef: `${REPOSITORY}/.github/workflows/${PUBLISH_WORKFLOW}@refs/heads/feat/x`,
        reserved: 'false',
      },
      // Nightly dispatched on a branch, or from a fork's copy of the workflow.
      {
        ...enabledNightly,
        ref: 'refs/heads/feat/x',
        workflowRef: `${REPOSITORY}/.github/workflows/nightly.yml@refs/heads/feat/x`,
      },
      {
        ...enabledNightly,
        workflowRef:
          'someone/station/.github/workflows/nightly.yml@refs/heads/main',
      },
      // A synthetic (unreserved) version or a failed dry run never publishes.
      { ...enabledNightly, reserved: 'false' },
      { ...enabledNightly, assemble: 'failure' },
    ])
      expect(gateAllows(gate, context), JSON.stringify(context)).toBe(false);
  });

  it('publishes only for the enabled, reserved Nightly on main', () => {
    expect(gateAllows(gate, enabledNightly)).toBe(true);
  });

  it('is a plain conjunction that nothing upstream can widen', () => {
    // always() would run it after a failed dry run; a top-level || would let
    // one disjunct bypass the variable.
    expect(gate).not.toMatch(/always\(\)|\|\||success\(\)|failure\(\)/);
    expect(publish.needs).toEqual(['plan', 'assemble']);
    // The plan reports `reserved` only after re-reading the reservation tag.
    const plan = publication.jobs.plan.steps?.find(
      (step) =>
        step.name === 'Bind the source SHA and derive the Nightly version',
    );
    expect(plan?.run).toContain('refs/tags/nightly-version-code/$VERSION_CODE');
    expect(plan?.run).toContain('test "$reserved" = "$SOURCE_SHA"');
  });

  it('can only run on triggers the owner controls', () => {
    expect(Object.keys(publication.on ?? {}).sort()).toEqual([
      'workflow_call',
      'workflow_dispatch',
    ]);
    // A dispatch takes no input that could name a version or a publish mode.
    expect(publication.on?.workflow_dispatch ?? null).toBeNull();
    // Its one caller is Nightly; no pull-request workflow calls it.
    const callers = readdirSync(workflowsDir)
      .filter((file) => /\.ya?ml$/.test(file))
      .filter((file) =>
        Object.values(readWorkflow(file).jobs ?? {}).some(
          (job) => job?.uses === `./.github/workflows/${PUBLISH_WORKFLOW}`,
        ),
      );
    expect(callers).toEqual(['nightly.yml']);
    expect(Object.keys(nightly.on ?? {}).join()).not.toMatch(/pull_request/);
  });
});

describe('portable Nightly publication workflow: token, secret and effect scope', () => {
  it('grants contents: write to the publish job alone, and id-token to nothing', () => {
    expect(publication.permissions).toEqual({ contents: 'read' });
    for (const [id, job] of Object.entries(publication.jobs))
      expect(job.permissions, id).toEqual(
        id === 'publish' ? { contents: 'write' } : { contents: 'read' },
      );
    expect(JSON.stringify(publication)).not.toContain('id-token');
  });

  it('reads the signing secret only in the publish job, inside the protected environment', () => {
    const publish = publication.jobs.publish;
    expect(publish.environment).toBe('portable-nightly-signing');
    for (const [id, job] of Object.entries(publication.jobs)) {
      if (id === 'publish') continue;
      expect(referencesCredential(job), id).toBe(false);
    }
    const secretSteps = (publish.steps ?? []).filter((step) =>
      /\bsecrets\./.test(JSON.stringify(step)),
    );
    expect(secretSteps.map((step) => step.name)).toEqual([
      'Sign with the pinned Nightly key',
    ]);
    expect(secretSteps[0].env).toEqual({
      SIGNING_KEY: `\${{ secrets.${SIGNING_SECRET} }}`,
    });
    expect(secretSteps[0].run).toContain(
      '--key-id station-portable-nightly-2026-09',
    );
    // The workflow declares no secrets to be passed in, and the Nightly
    // caller passes none: the key lives only in the environment.
    expect(JSON.stringify(publication.on?.workflow_call)).not.toContain(
      'secrets',
    );
    expect(nightly.jobs['portable-nightly'].secrets).toBeUndefined();
  });

  it('keeps every publication effect in the publish job, rolling manifest last and re-verified', () => {
    for (const [id, job] of Object.entries(publication.jobs)) {
      if (id === 'publish') continue;
      for (const step of job.steps ?? [])
        expect(isPublicationEffect(step), `${id}: ${step.name}`).toBe(false);
    }
    const steps = publication.jobs.publish.steps ?? [];
    const index = (name: string) => {
      const found = steps.findIndex((step) => step.name === name);
      expect(found, name).toBeGreaterThanOrEqual(0);
      return found;
    };
    const effects = steps
      .map((step, position) => ({ step, position }))
      .filter(({ step }) => isPublicationEffect(step));
    const rolling = index('Replace the rolling Nightly manifest (last)');
    expect(effects.at(-1)?.position).toBe(rolling);
    expect(steps[rolling].run).toContain('gh release upload "$ROLLING_TAG"');
    // Before the rolling write: the pinned-key verify, the not-newer refusal,
    // the pointer and immutability checks, and the versioned upload with its
    // re-download comparison.
    for (const name of [
      'Verify the signed manifest with the pinned key table',
      'Refuse to publish over a newer or equal rolling Nightly',
      "Require the owner's rolling pointer release and a fresh version",
      'Upload the versioned release assets',
      'Re-download the versioned assets and compare them with the manifest',
    ])
      expect(index(name), name).toBeLessThan(rolling);
    const reverify = index(
      'Re-fetch and re-verify the rolling manifest with the pinned key',
    );
    expect(reverify).toBe(rolling + 1);
    expect(steps[reverify].run).toContain('--manifest "$ROLLING_MANIFEST_URL"');
    // Pinned-key verification: no --keys or --public-key override.
    expect(steps[reverify].run).not.toMatch(/--keys|--public-key/);
    // The versioned release is never the repository's "latest".
    expect(steps[index('Upload the versioned release assets')].run).toContain(
      '--latest=false',
    );
  });

  it('dry-runs the whole signing path with a throwaway key the pinned table refuses', () => {
    const assemble = publication.jobs.assemble.steps ?? [];
    const sign = assemble.find(
      (step) => step.name === 'Sign with a throwaway key and verify',
    );
    expect(sign?.run).toContain('--allow-unpinned-key');
    expect(sign?.run).toContain(`--key-id ${DRY_RUN_SIGNING_KEY_ID}`);
    expect(sign?.run).toContain(
      'if node scripts/ecosystem-manifest.mjs verify --manifest publication/dry-run-manifest.json > /dev/null 2>&1; then',
    );
    const assembleStep = assemble.find((step) =>
      step.run?.includes('ecosystem-manifest.mjs assemble'),
    );
    expect(assembleStep?.run).toContain('--channel nightly');
    expect(assembleStep?.run).not.toMatch(/--allow-partial|--targets/);
  });

  it('builds through the reusable archive workflow for the nightly ring', () => {
    const archives = publication.jobs.archives;
    expect(archives.uses).toBe(
      './.github/workflows/portable-server-archives.yml',
    );
    expect(archives.with).toEqual({
      ref: expr('needs.plan.outputs.source_sha'),
      version: expr('needs.plan.outputs.version'),
      ring: 'nightly',
    });
  });
});

describe('Nightly caller', () => {
  const caller = nightly.jobs['portable-nightly'];

  it('passes the native reservation as the version and waits for full regression', () => {
    expect(caller.uses).toBe(`./.github/workflows/${PUBLISH_WORKFLOW}`);
    expect(caller.with).toEqual({
      source_sha: expr('needs.test-gate.outputs.source_sha'),
      marketing_version: expr('needs.native-stage.outputs.marketing_version'),
      version_code: expr('needs.native-stage.outputs.bundle_version'),
    });
    expect(caller.needs).toEqual([
      'test-gate',
      'full-regression',
      'native-stage',
    ]);
    const parts = conjuncts(caller.if ?? '');
    for (const required of [
      "needs['full-regression'].result == 'success'",
      "github.ref == 'refs/heads/main'",
      "needs['native-stage'].outputs.build == 'true'",
    ])
      expect(parts).toContain(required);
    // Native build health does not gate the server; the reservation does.
    expect(caller.if).not.toContain("needs['native-stage'].result");
  });

  it('hands the callee contents: write and nothing else', () => {
    expect(caller.permissions).toEqual({ contents: 'write' });
  });
});

describe('portable Nightly helpers', () => {
  it('derives X.Y.Z-nightly.<version code> and refuses anything else', () => {
    expect(portableNightlyVersion('0.1.11', '245600')).toBe(
      '0.1.11-nightly.245600',
    );
    for (const [marketing, code] of [
      ['0.1.11-nightly.1', '1'],
      ['0.1', '1'],
      ['0.1.11', '0'],
      ['0.1.11', '01'],
      ['0.1.11', ''],
      ['0.1.11', '2.1'],
    ])
      expect(() => portableNightlyVersion(marketing, code)).toThrow();
  });

  it('orders Nightly versions numerically, release first', () => {
    expect(
      compareNightlyVersions('0.1.11-nightly.9', '0.1.11-nightly.10'),
    ).toBe(-1);
    expect(
      compareNightlyVersions('0.1.12-nightly.1', '0.1.11-nightly.99'),
    ).toBe(1);
    expect(compareNightlyVersions('0.1.11-nightly.5', '0.1.11-nightly.5')).toBe(
      0,
    );
    expect(() =>
      compareNightlyVersions('0.1.11', '0.1.11-nightly.1'),
    ).toThrow();
  });

  it('points artifacts at the versioned release and the manifest at the rolling pointer', () => {
    expect(publicationLocations(REPOSITORY, '0.1.11-nightly.245600')).toEqual({
      releaseTag: 'v0.1.11-nightly.245600',
      baseUrl:
        'https://github.com/kontourai/station/releases/download/v0.1.11-nightly.245600/',
      rollingTag: ROLLING_NIGHTLY_TAG,
      manifestAsset: NIGHTLY_MANIFEST_ASSET,
      rollingManifestUrl: `https://github.com/kontourai/station/releases/download/${ROLLING_NIGHTLY_TAG}/${NIGHTLY_MANIFEST_ASSET}`,
    });
    expect(() =>
      publicationLocations('bad repo', '0.1.11-nightly.1'),
    ).toThrow();
    expect(() => publicationLocations(REPOSITORY, '0.1.11')).toThrow();
  });
});

const makeTempDir = trackTempDirs({ lifetime: 'file' });
const scratch = makeTempDir('station-portable-nightly-');
let archiveFixtures = 0;

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });
}

function writeJson(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

describe('dry-run signing through the real signer CLI', () => {
  const payload = platformPayload();
  const payloadPath = writeJson('payload.json', payload);
  const keysDir = join(scratch, 'keys');

  it('signs with a throwaway key that verifies against its own table and never the pinned one', () => {
    const keys = runNode('scripts/portable-nightly-publication.mjs', [
      'dry-run-keys',
      '--out-dir',
      keysDir,
    ]);
    expect(keys.status, keys.stderr).toBe(0);
    const manifest = join(scratch, 'dry-run-manifest.json');
    const created = runNode('scripts/ecosystem-manifest.mjs', [
      'create',
      '--payload',
      payloadPath,
      '--key-id',
      DRY_RUN_SIGNING_KEY_ID,
      '--private-key',
      join(keysDir, 'dry-run-private-key.pem'),
      '--allow-unpinned-key',
      '--output',
      manifest,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const verified = runNode('scripts/portable-nightly-publication.mjs', [
      'verify',
      '--manifest',
      manifest,
      '--keys',
      join(keysDir, 'dry-run-keys.json'),
      '--expected-payload',
      payloadPath,
    ]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('verified 0.7.0-nightly.12');
    // Against the pinned table (the default) the same envelope is refused.
    const pinned = runNode('scripts/portable-nightly-publication.mjs', [
      'verify',
      '--manifest',
      manifest,
      '--expected-payload',
      payloadPath,
    ]);
    expect(pinned.status).toBe(1);
    expect(pinned.stderr).toContain(
      `manifest signing key ${DRY_RUN_SIGNING_KEY_ID} is not pinned`,
    );
  });

  it('refuses a validly signed manifest whose payload is not the one this run signed', () => {
    const { privateKeyPem, keyTable } = createDryRunKeys();
    const keyPath = join(scratch, 'other-key.pem');
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    const other = writeJson(
      'other-payload.json',
      platformPayload({
        version: '0.7.0-nightly.13',
        releaseTag: 'v0.7.0-nightly.13',
      }),
    );
    // The fixture's artifact URLs name v0.7.0-nightly.12; the payload shape
    // does not tie them to the version, only the assembler does.
    const manifest = join(scratch, 'other-manifest.json');
    const created = runNode('scripts/ecosystem-manifest.mjs', [
      'create',
      '--payload',
      other,
      '--key-id',
      DRY_RUN_SIGNING_KEY_ID,
      '--private-key',
      keyPath,
      '--allow-unpinned-key',
      '--output',
      manifest,
    ]);
    expect(created.status, created.stderr).toBe(0);
    const envelope = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(() => verifyExpectedManifest(envelope, keyTable, payload)).toThrow(
      /not the payload this run signed/,
    );
    expect(
      verifyExpectedManifest(
        envelope,
        keyTable,
        JSON.parse(readFileSync(other, 'utf8')),
      ).version,
    ).toBe('0.7.0-nightly.13');
  });
});

describe('publication checks', () => {
  function signedWith(version: string) {
    const { privateKeyPem, keyTable } = createDryRunKeys();
    const keyPath = join(scratch, `key-${version}.pem`);
    writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
    const payloadPath = writeJson(
      `payload-${version}.json`,
      platformPayload({ version, releaseTag: `v${version}` }),
    );
    const manifest = join(scratch, `manifest-${version}.json`);
    const created = runNode('scripts/ecosystem-manifest.mjs', [
      'create',
      '--payload',
      payloadPath,
      '--key-id',
      DRY_RUN_SIGNING_KEY_ID,
      '--private-key',
      keyPath,
      '--allow-unpinned-key',
      '--output',
      manifest,
    ]);
    expect(created.status, created.stderr).toBe(0);
    return { envelope: JSON.parse(readFileSync(manifest, 'utf8')), keyTable };
  }

  it('refuses to replace the rolling manifest with an older or equal version', () => {
    const { envelope, keyTable } = signedWith('0.7.0-nightly.10');
    expect(
      assertNotRegressing({
        current: envelope,
        keys: keyTable,
        candidateVersion: '0.7.0-nightly.11',
      }),
    ).toEqual({ current: '0.7.0-nightly.10' });
    for (const candidate of ['0.7.0-nightly.10', '0.7.0-nightly.9'])
      expect(() =>
        assertNotRegressing({
          current: envelope,
          keys: keyTable,
          candidateVersion: candidate,
        }),
      ).toThrow(/not newer/);
    // The first publish has no rolling manifest yet.
    expect(
      assertNotRegressing({
        current: null,
        keys: keyTable,
        candidateVersion: '0.7.0-nightly.1',
      }),
    ).toEqual({ current: null });
    // A rolling manifest that does not verify is refused, not overwritten.
    expect(() =>
      assertNotRegressing({
        current: envelope,
        keys: createDryRunKeys().keyTable,
        candidateVersion: '0.7.0-nightly.11',
      }),
    ).toThrow(/signature did not verify/);
  });

  function archiveFixture() {
    archiveFixtures += 1;
    const dir = join(scratch, `archives-${archiveFixtures}`);
    mkdirSync(dir);
    const artifacts = ['darwin-arm64', 'win32-x64'].map((id, index) => {
      const format = id.startsWith('win32') ? 'zip' : 'tar.gz';
      const name = `station-server-${id}.${format}`;
      const bytes = Buffer.from(`archive ${index}`);
      mkdirSync(join(dir, `station-server-${id}`));
      writeFileSync(join(dir, `station-server-${id}`, name), bytes);
      return {
        name,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        url: `https://example.test/${name}`,
      };
    });
    return { dir, payload: { artifacts } };
  }

  it('uploads only archives whose bytes are the signed ones', () => {
    const { dir, payload } = archiveFixture();
    expect(checkArchives(payload, dir)).toHaveLength(2);
    writeFileSync(
      join(dir, 'station-server-win32-x64', 'station-server-win32-x64.zip'),
      'tampered',
    );
    expect(() => checkArchives(payload, dir)).toThrow(
      'station-server-win32-x64.zip is not the archive the manifest signs',
    );
    rmSync(join(dir, 'station-server-darwin-arm64'), { recursive: true });
    expect(() => checkArchives(payload, dir)).toThrow(/is missing/);
  });

  it('compares every re-downloaded asset with the manifest', async () => {
    const { payload } = archiveFixture();
    const served = new Map(
      payload.artifacts.map((artifact, index) => [
        artifact.url,
        Buffer.from(`archive ${index}`),
      ]),
    );
    const fetchImpl = async (url: string) =>
      new Response(served.get(url) ?? null, {
        status: served.has(url) ? 200 : 404,
      });
    await expect(
      verifyPublishedAssets(payload, { fetchImpl, attempts: 1 }),
    ).resolves.toBeUndefined();
    served.set(payload.artifacts[1].url, Buffer.from('swapped'));
    await expect(
      verifyPublishedAssets(payload, { fetchImpl, attempts: 1 }),
    ).rejects.toThrow(/is not the archive the manifest signs/);
  });
});
