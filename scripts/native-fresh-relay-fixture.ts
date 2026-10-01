import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createProject } from '@kontourai/station-sdk/client';
import { changeProjectAccess } from '@kontourai/station-sdk/project-access-client';
import { stationConnectionKeyConfirmationCode } from '@kontourai/station-shared/connection-proof';
import { z } from 'zod';
import { loadSelfHostedBrokerConnectorConfig } from '../src-server/runtime/bootstrap/self-hosted-connector-config.js';
import {
  localLabEnvironment,
  runLabCommand,
} from './lib/local-collaboration-process.mjs';
import {
  cleanupNativeFreshBrokerGrants,
  installNativeFreshNodeNetworkGuard,
  loadNativeFreshFixturePlan,
  nativeFreshFixtureEnvironment,
  nativeFreshOperatorRequest,
  prepareNativeFreshFixture,
  readNativeFreshPrivateJson,
} from './lib/native-fresh-relay-fixture.js';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const output = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const privateOutput = (path: string, directory: string, value: unknown) => {
  assert(
    dirname(path) === directory && resolve(path) === path,
    'fixture_output_owner_mismatch',
  );
  writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
};

async function main() {
  const [mode, path, argument, extra] = process.argv.slice(2);
  assert(mode && path, 'fixture_usage');
  if (mode === 'prepare') {
    assert(!argument && !extra, 'fixture_usage');
    const clean = (
      await runLabCommand(
        'git',
        ['status', '--porcelain'],
        resolve(import.meta.dirname, '..'),
      )
    ).stdout.trim();
    assert(clean.length === 0, 'fixture_committed_source_required');
    const sourceRevision = (
      await runLabCommand(
        'git',
        ['rev-parse', 'HEAD'],
        resolve(import.meta.dirname, '..'),
      )
    ).stdout.trim();
    const plan = await prepareNativeFreshFixture(path, sourceRevision);
    output({
      status: 'prepared',
      planPath: join(path, 'plan.json'),
      ...plan,
      signingKeyConfirmationCode: await stationConnectionKeyConfirmationCode(
        plan.stationTrust,
      ),
    });
    return;
  }
  const plan = loadNativeFreshFixturePlan(path);
  const connectorPath = join(plan.directory, 'connector.json');
  if (mode === '--child') {
    assert(!argument && !extra, 'fixture_usage');
    Object.assign(
      process.env,
      nativeFreshFixtureEnvironment(plan, connectorPath),
    );
    installNativeFreshNodeNetworkGuard(plan);
    const timer = setTimeout(
      () => process.kill(process.pid, 'SIGTERM'),
      plan.lifetimeMs,
    );
    timer.unref();
    await import('../src-server/index.js');
    return;
  }
  if (mode === 'serve') {
    assert(!argument && !extra, 'fixture_usage');
    const sourceRevision = (
      await runLabCommand(
        'git',
        ['rev-parse', 'HEAD'],
        resolve(import.meta.dirname, '..'),
      )
    ).stdout.trim();
    const clean = (
      await runLabCommand(
        'git',
        ['status', '--porcelain'],
        resolve(import.meta.dirname, '..'),
      )
    ).stdout.trim();
    assert(
      sourceRevision === plan.sourceRevision && clean.length === 0,
      'fixture_committed_source_changed',
    );
    const env = nativeFreshFixtureEnvironment(plan, connectorPath);
    for (const directory of ['os-home', 'tmp'])
      mkdirSync(join(plan.directory, directory), {
        mode: 0o700,
        recursive: true,
      });
    const dotenv = join(plan.directory, 'empty.env');
    writeFileSync(dotenv, '', { mode: 0o600, flag: 'wx' });
    const execution = executeOwnedCommand(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve(import.meta.filename),
        '--child',
        path,
      ],
      spawn,
      'fresh native public fixture',
      {
        cwd: resolve(import.meta.dirname, '..'),
        windowsHide: true,
        onSpawn: (
          _child: unknown,
          identity: { pid: number | null; pgid: number | null },
        ) => {
          privateOutput(
            join(plan.directory, 'runtime-owner.json'),
            plan.directory,
            { runId: plan.runId, ...identity },
          );
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...localLabEnvironment(),
          ...env,
          DOTENV_CONFIG_PATH: dotenv,
          HOME: join(plan.directory, 'os-home'),
          USERPROFILE: join(plan.directory, 'os-home'),
          TMPDIR: join(plan.directory, 'tmp'),
          TMP: join(plan.directory, 'tmp'),
          TEMP: join(plan.directory, 'tmp'),
          TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.json'),
        },
      },
    );
    const capture = captureOwnedProcessOutput(execution, { maxBytes: 65536 });
    let deadline: ReturnType<typeof setTimeout>;
    const stopped = new Promise<void>((resolveStop) => {
      deadline = setTimeout(resolveStop, plan.lifetimeMs - 30000);
      process.once('SIGINT', resolveStop);
      process.once('SIGTERM', resolveStop);
    });
    try {
      const finished = await Promise.race([
        execution.completion,
        stopped.then(() => undefined),
      ]);
      if (finished) assert.equal(finished.status, 0, 'fixture_runtime_failed');
    } finally {
      clearTimeout(deadline!);
      let cleanup: unknown;
      let brokerError: unknown;
      try {
        cleanup = await cleanupNativeFreshBrokerGrants(plan);
      } catch (error) {
        brokerError = error;
      }
      const terminated = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: 5000,
        terminationForceMs: 5000,
        processLabel: 'fresh native public fixture',
      });
      const receipt = {
        runId: plan.runId,
        processGroupSettled: terminated.settled,
        brokerCleanup: cleanup ?? null,
        brokerCleanupConfirmed: !brokerError,
      };
      privateOutput(
        join(plan.directory, 'cleanup.json'),
        plan.directory,
        receipt,
      );
      assert(
        terminated.settled && terminated.errors.length === 0 && !brokerError,
        'fixture_cleanup_unconfirmed',
      );
      output(receipt);
      // The bounded process capture is intentionally not printed: it may contain application diagnostics.
      void capture;
    }
    return;
  }
  if (mode === 'pending') {
    assert(!argument && !extra, 'fixture_usage');
    output(
      await nativeFreshOperatorRequest(
        plan,
        '/api/pairing/native-relay-enrollments',
        'GET',
      ),
    );
    return;
  }
  if (mode === 'approve') {
    assert(argument && !extra, 'fixture_usage');
    const approval = z
      .object({ enrollmentId: z.string().uuid(), candidate: z.unknown() })
      .strict()
      .parse(readNativeFreshPrivateJson(argument));
    output(
      await nativeFreshOperatorRequest(
        plan,
        `/api/pairing/native-relay-enrollments/${approval.enrollmentId}/approve`,
        'POST',
        { candidate: approval.candidate },
      ),
    );
    return;
  }
  if (mode === 'invite-native') {
    assert(argument && extra, 'fixture_usage');
    const env = nativeFreshFixtureEnvironment(plan, connectorPath);
    const connector = loadSelfHostedBrokerConnectorConfig({
      homeDir: env.STATION_HOME,
      env,
    });
    assert(connector, 'fixture_connector_unavailable');
    const invitation = await connector.issueNativeInvitation(
      readNativeFreshPrivateJson(argument),
      AbortSignal.timeout(15000),
    );
    const result = await nativeFreshOperatorRequest(
      plan,
      '/api/pairing/native-relay-surfaces',
      'POST',
      {
        operation: 'approve',
        tuple: { scope: invitation.scope, surface: invitation.surface },
      },
    );
    privateOutput(extra, plan.directory, invitation);
    output({
      status: 'native_invitation_written',
      outputPath: extra,
      approval: result,
    });
    return;
  }
  if (mode === 'project') {
    assert(argument && !extra, 'fixture_usage');
    const operator = z
      .object({ credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) })
      .strict()
      .parse(readNativeFreshPrivateJson(join(plan.directory, 'operator.json')));
    const base = `http://127.0.0.1:${plan.port}`;
    const options = {
      credential: operator.credential,
      credentialOrigin: base,
      requireCredential: true,
      headers: { Origin: base },
      redirect: 'error' as const,
      timeoutMs: 15000,
      maxResponseBytes: 65536,
      signal: AbortSignal.timeout(45000),
    };
    const project = z
      .object({
        id: z.string().min(1).max(128),
        slug: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
      })
      .passthrough()
      .parse(
        await createProject(
          base,
          {
            name: `Fresh native ${plan.runId.slice(0, 8)}`,
            description: 'Owned public relay fixture. Fixed small text only.',
            icon: 'folder',
          },
          options,
        ),
      );
    const enabled = await changeProjectAccess(
      base,
      project.slug,
      { kind: 'enable', localProjectId: project.id },
      options,
    );
    assert(enabled.kind === 'enabled');
    const invitation = await changeProjectAccess(
      base,
      project.slug,
      {
        kind: 'invite',
        scope: enabled.view.scope,
        email: null,
        role: 'viewer',
        expiresAt: new Date(Date.now() + plan.lifetimeMs).toISOString(),
      },
      options,
    );
    assert(invitation.kind === 'invited');
    privateOutput(argument, plan.directory, {
      projectSlug: project.slug,
      scope: enabled.view.scope,
      invitation: invitation.token,
      grantsDeviceAccess: false,
    });
    output({
      status: 'unconsumed_project_invitation_written',
      projectSlug: project.slug,
      outputPath: argument,
    });
    return;
  }
  throw new Error('fixture_usage');
}
main().catch(() => {
  process.stderr.write('native_fresh_fixture_refused\n');
  process.exitCode = 1;
});
