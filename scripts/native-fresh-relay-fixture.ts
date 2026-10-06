import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createProject } from '@kontourai/station-sdk/client';
import { changeProjectAccess } from '@kontourai/station-sdk/project-access-client';
import {
  readProjectSharedTaskDocument,
  shareProjectTask,
} from '@kontourai/station-sdk/project-shared-tasks';
import { stationConnectionKeyConfirmationCode } from '@kontourai/station-shared/connection-proof';
import { z } from 'zod';
import { loadSelfHostedBrokerConnectorConfig } from '../src-server/runtime/bootstrap/self-hosted-connector-config.js';
import {
  localLabEnvironment,
  runLabCommand,
} from './lib/local-collaboration-process.mjs';
import {
  assertNativeFreshBrokerLeaseCommitted,
  cleanupNativeFreshBrokerGrants,
  confirmNativeFreshRecoveredCleanup,
  installNativeFreshNodeNetworkGuard,
  loadNativeFreshFixturePlan,
  nativeFreshFixtureEnvironment,
  nativeFreshOperatorRequest,
  prepareNativeFreshFixture,
  prepareNativeFreshFixtureSuccessor,
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
  if (mode === 'confirm-recovered-cleanup') {
    assert(
      argument && !extra && /^[1-9][0-9]*$/u.test(argument),
      'fixture_usage',
    );
    const receiptPath = confirmNativeFreshRecoveredCleanup(
      path,
      Number(argument),
    );
    output({ status: 'recovered_cleanup_confirmed', receiptPath });
    return;
  }
  if (mode === 'prepare' || mode === 'prepare-successor') {
    assert(
      mode === 'prepare'
        ? !argument && !extra
        : argument && extra && /^[1-9][0-9]*$/u.test(extra),
      'fixture_usage',
    );
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
    const plan =
      mode === 'prepare'
        ? await prepareNativeFreshFixture(path, sourceRevision)
        : await prepareNativeFreshFixtureSuccessor(
            path,
            argument!,
            Number(extra),
            sourceRevision,
          );
    output({
      status:
        mode === 'prepare' ? 'prepared' : 'successor_prepared_not_provisioned',
      planPath: join(plan.directory, 'plan.json'),
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
    assertNativeFreshBrokerLeaseCommitted(plan);
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
    let primaryFailure: unknown;
    let childOutcome: unknown;
    const failures: unknown[] = [];
    let receipt: unknown;
    try {
      const finished = await Promise.race([
        execution.completion,
        stopped.then(() => undefined),
      ]);
      childOutcome = finished ?? { interrupted: true };
      if (finished) assert.equal(finished.status, 0, 'fixture_runtime_failed');
    } catch (error) {
      primaryFailure = error;
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
      }).catch((error) => {
        failures.push(error);
        return { settled: false, errors: [error] };
      });
      const runtimeOutput = capture.finish();
      try {
        privateOutput(
          join(plan.directory, 'runtime-output.json'),
          plan.directory,
          {
            runId: plan.runId,
            outcome: childOutcome ?? null,
            primaryFailure:
              primaryFailure instanceof Error
                ? { name: primaryFailure.name, message: primaryFailure.message }
                : (primaryFailure ?? null),
            ...runtimeOutput,
          },
        );
      } catch (error) {
        failures.push(error);
      }
      receipt = {
        runId: plan.runId,
        primaryRuntimeFailed: primaryFailure !== undefined,
        outputTruncated: runtimeOutput.truncated,
        outputInvalidUtf8: runtimeOutput.invalidUtf8,
        processGroupSettled: terminated.settled,
        brokerCleanup: cleanup ?? null,
        brokerCleanupConfirmed: !brokerError,
      };
      try {
        privateOutput(
          join(plan.directory, 'cleanup.json'),
          plan.directory,
          receipt,
        );
      } catch (error) {
        failures.push(error);
      }
      if (primaryFailure !== undefined) failures.push(primaryFailure);
      if (brokerError !== undefined) failures.push(brokerError);
      if (!terminated.settled || terminated.errors.length)
        failures.push(new Error('fixture_process_cleanup_unconfirmed'));
      if (runtimeOutput.truncated || runtimeOutput.invalidUtf8)
        failures.push(new Error('fixture_runtime_output_incomplete'));
    }
    if (failures.length)
      throw new AggregateError(failures, 'fixture_runtime_or_cleanup_failed');
    output(receipt);
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
      .object({
        enrollmentId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
        candidate: z.unknown(),
      })
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
    const task = z
      .object({
        success: z.literal(true),
        data: z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
            createdAt: z.string().datetime(),
            status: z.literal('todo'),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(
        await nativeFreshOperatorRequest(plan, '/api/tasks', 'POST', {
          projectId: project.slug,
          title: `Native shared task ${plan.runId.slice(0, 8)}`,
        }),
      ).data;
    const room = `/api/tasks/${task.id}/room`;
    z.object({
      success: z.literal(true),
      data: z.object({ kind: z.enum(['opened', 'existing']) }).passthrough(),
    })
      .passthrough()
      .parse(await nativeFreshOperatorRequest(plan, room, 'GET'));
    const message = `Native fixed human message ${plan.runId}`;
    const documentText = `Native fixed shared document ${plan.runId}`;
    z.object({
      success: z.literal(true),
      data: z.object({ kind: z.literal('committed') }).passthrough(),
    })
      .passthrough()
      .parse(
        await nativeFreshOperatorRequest(plan, `${room}/messages`, 'POST', {
          proposalId: `native-message-${plan.runId}`,
          text: message,
        }),
      );
    const edit = z
      .object({
        success: z.literal(true),
        data: z
          .object({
            kind: z.literal('planned'),
            intentId: z.string().min(1).max(256),
            digest: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .passthrough(),
      })
      .passthrough()
      .parse(
        await nativeFreshOperatorRequest(plan, `${room}/edit-plan`, 'POST', {
          intentId: `native-document-${plan.runId}`,
          desiredText: documentText,
          selection: { anchor: 0, focus: 0 },
        }),
      ).data;
    z.object({
      success: z.literal(true),
      data: z.object({ kind: z.literal('committed') }).passthrough(),
    })
      .passthrough()
      .parse(
        await nativeFreshOperatorRequest(plan, `${room}/batches`, 'POST', {
          intentId: edit.intentId,
          intentDigest: edit.digest,
        }),
      );
    const publication = await shareProjectTask(
      base,
      project.slug,
      {
        project: enabled.view.scope,
        task: { id: task.id, createdAt: task.createdAt },
      },
      options,
    );
    assert(publication.kind === 'shared', 'fixture_shared_task_not_published');
    const document = await readProjectSharedTaskDocument(
      base,
      project.slug,
      task.id,
      options,
    );
    assert(
      document.kind === 'snapshot' &&
        document.text === documentText &&
        document.task.id === task.id &&
        document.task.createdAt === task.createdAt,
      'fixture_published_document_mismatch',
    );
    const privateProject = z
      .object({ slug: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) })
      .passthrough()
      .parse(
        await createProject(
          base,
          {
            name: `Native private ${plan.runId.slice(0, 8)}`,
            description: 'Unshared negative control.',
          },
          options,
        ),
      );

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
      privateProjectSlug: privateProject.slug,
      sharedTask: {
        id: task.id,
        createdAt: task.createdAt,
        message,
        documentText,
        shareId: publication.publication.shareId,
      },
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
