import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { register } from '../plugin.mjs';

const dirs: string[] = [];
function validBundle() {
  const timestamp = '2026-07-19T00:00:00.000Z';
  const claim = (id: string, metadata: Record<string, unknown>) => ({
    id,
    subjectType: 'artifact',
    subjectId: 'repo:demo',
    facet: 'quality',
    claimType: 'quality.static-checks',
    fieldOrBehavior: id,
    value: 'pass',
    status: 'verified',
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata,
  });
  return {
    schemaVersion: 5,
    source: 'station-test',
    claims: [
      claim('check', { origin: 'check' }),
      claim('critique', { origin: 'critique' }),
      claim('gate', { gate_claim: true }),
    ],
    evidence: [
      {
        id: 'evidence',
        claimId: 'check',
        evidenceType: 'test_output',
        method: 'validation',
        sourceRef: 'command:verify-static',
        excerptOrSummary: 'passed',
        observedAt: timestamp,
        collectedBy: 'station',
        passing: true,
      },
    ],
    policies: [],
    events: [],
  };
}
function fixture() {
  const root = join(
    tmpdir(),
    `bdv-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  dirs.push(root);
  mkdirSync(join(home, 'projects', 'demo'), { recursive: true });
  writeFileSync(
    join(home, 'projects', 'demo', 'project.json'),
    JSON.stringify({ workingDirectory: workspace }),
  );
  mkdirSync(join(workspace, '.kontourai', 'flow-agents', 'demo'), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, '.kontourai', 'flow-agents', 'demo', 'trust.bundle'),
    JSON.stringify(validBundle()),
  );
  const delivery = join(workspace, 'delivery', 'demo');
  mkdirSync(delivery, { recursive: true });
  for (const file of [
    'trust.bundle',
    'trust.checkpoint.json',
    'trust.checkpoint.intoto.json',
    'trust.checkpoint.sig.json',
    'trust.checkpoint.attestation.json',
  ])
    writeFileSync(join(delivery, file), '{}');
  writeFileSync(
    join(workspace, '.kontourai', 'flow-agents', 'demo', 'state.json'),
    JSON.stringify({
      schema_version: '1.0',
      task_slug: 'demo',
      status: 'in_progress',
      phase: 'execution',
      updated_at: '2026-07-19T00:00:00Z',
      next_action: { status: 'continue', summary: 'run checks' },
    }),
  );
  writeFileSync(
    join(workspace, '.kontourai', 'flow-agents', 'demo', 'acceptance.json'),
    JSON.stringify({
      schema_version: '1.0',
      task_slug: 'demo',
      criteria: [
        { id: 'read-only', description: 'does not write', status: 'pass' },
      ],
      goal_fit: { status: 'pass', summary: 'yes' },
    }),
  );
  return { home, workspace };
}
function app(home: string) {
  const instance = new Hono();
  register(instance, {
    projectHomeDir: home,
    telemetry: { recordRoutingDecision() {} },
  });
  return instance;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('Builder Delivery Viewer server', () => {
  it('lists valid published state without writing workspace files', async () => {
    const { home, workspace } = fixture();
    mkdirSync(join(workspace, '.kontourai', 'flow-agents', 'not-a-session'));
    const response = await app(home).request('/projects/demo/builder-sessions');
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].slug).toBe('demo');
    expect(body.sessions[0].validation.state.valid).toBe(true);
  });
  it('bounds oversized artifacts and rejects FIFOs without opening them', async () => {
    const oversized = fixture();
    writeFileSync(
      join(
        oversized.workspace,
        '.kontourai',
        'flow-agents',
        'demo',
        'state.json',
      ),
      'x'.repeat(1024 * 1024 + 1),
    );
    const oversizedBody = await (
      await app(oversized.home).request('/projects/demo/builder-sessions')
    ).json();
    expect(oversizedBody.sessions[0].validation.state).toEqual({
      valid: false,
      warning: 'artifact exceeds read limit',
    });

    if (process.platform === 'win32') return;
    const fifo = fixture();
    const state = join(
      fifo.workspace,
      '.kontourai',
      'flow-agents',
      'demo',
      'state.json',
    );
    rmSync(state);
    execFileSync('mkfifo', [state], { windowsHide: true });
    const fifoBody = await (
      await app(fifo.home).request('/projects/demo/builder-sessions')
    ).json();
    expect(fifoBody.sessions[0].validation.state).toEqual({
      valid: false,
      warning: 'artifact must be a regular file',
    });
  });
  it('stops directory discovery at the published session cap', async () => {
    const { home, workspace } = fixture();
    const base = join(workspace, '.kontourai', 'flow-agents');
    const addSession = (index: number) => {
      const directory = join(base, `extra-${index}`);
      mkdirSync(directory);
      writeFileSync(
        join(directory, 'state.json'),
        JSON.stringify({
          schema_version: '1.0',
          task_slug: `extra-${index}`,
          status: 'in_progress',
          phase: 'execution',
          updated_at: '2026-07-19T00:00:00Z',
          next_action: { status: 'continue', summary: 'bounded' },
        }),
      );
    };
    for (let index = 0; index < 99; index += 1) addSession(index);
    const exactBody = await (
      await app(home).request('/projects/demo/builder-sessions')
    ).json();
    expect(exactBody.sessions).toHaveLength(100);
    expect(exactBody.truncated).toBe(false);
    for (let index = 99; index < 105; index += 1) addSession(index);
    const body = await (
      await app(home).request('/projects/demo/builder-sessions')
    ).json();
    expect(body.sessions).toHaveLength(100);
    expect(body.truncated).toBe(true);
  });
  it('awaits the public validator, derives Surface trust, classifies claim metadata, and reads only published delivery companions', async () => {
    const { home } = fixture();
    const response = await app(home).request(
      '/projects/demo/builder-sessions/demo',
    );
    const body = await response.json();
    expect(body.session.validation.trust).toEqual({ valid: true });
    expect(body.session.report.claims).toHaveLength(3);
    expect(body.session.claims.checks).toHaveLength(1);
    expect(body.session.claims.critiques).toHaveLength(1);
    expect(body.session.claims.gates).toHaveLength(1);
    expect(body.session.seal.companions).toEqual([
      'trust.bundle',
      'trust.checkpoint.json',
      'trust.checkpoint.intoto.json',
      'trust.checkpoint.sig.json',
      'trust.checkpoint.attestation.json',
    ]);
  });
  it('keeps an invalid acceptance artifact explicitly unavailable', async () => {
    const { home, workspace } = fixture();
    writeFileSync(
      join(workspace, '.kontourai', 'flow-agents', 'demo', 'acceptance.json'),
      '{bad',
    );
    const response = await app(home).request(
      '/projects/demo/builder-sessions/demo',
    );
    const body = await response.json();
    expect(body.session.validation.acceptance.valid).toBe(false);
    expect(body.session.validation.trust.valid).toBe(true);
    expect(body.session.report).toBeTruthy();
  });
  it('reports an invalid published trust bundle rather than deriving it', async () => {
    const { home, workspace } = fixture();
    writeFileSync(
      join(workspace, '.kontourai', 'flow-agents', 'demo', 'trust.bundle'),
      JSON.stringify({ schemaVersion: 5, claims: [] }),
    );
    const response = await app(home).request(
      '/projects/demo/builder-sessions/demo',
    );
    const body = await response.json();
    expect(body.session.validation.trust.valid).toBe(false);
    expect(body.session.validation.trust.warning).toBeTruthy();
    expect(body.session.report).toBeNull();
  });
  it('rejects symlinked artifacts and does not count symlinked seal companions', async () => {
    const { home, workspace } = fixture();
    const outside = join(workspace, 'outside.json');
    writeFileSync(outside, JSON.stringify(validBundle()));
    const trust = join(
      workspace,
      '.kontourai',
      'flow-agents',
      'demo',
      'trust.bundle',
    );
    rmSync(trust);
    symlinkSync(outside, trust);
    const companion = join(
      workspace,
      'delivery',
      'demo',
      'trust.checkpoint.sig.json',
    );
    rmSync(companion);
    symlinkSync(outside, companion);
    const body = await (
      await app(home).request('/projects/demo/builder-sessions/demo')
    ).json();
    expect(body.session.validation.trust).toEqual({
      valid: false,
      warning: 'artifact must be a regular file',
    });
    expect(body.session.seal.companions).not.toContain(
      'trust.checkpoint.sig.json',
    );
  });
  it('only registers GET read routes', async () => {
    const { home } = fixture();
    const response = await app(home).request(
      '/projects/demo/builder-sessions',
      { method: 'POST' },
    );
    expect(response.status).toBe(404);
  });
  it('rejects unsafe slugs', async () => {
    const { home } = fixture();
    expect(
      (await app(home).request('/projects/bad!/builder-sessions')).status,
    ).toBe(400);
  });
});
