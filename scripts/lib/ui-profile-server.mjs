import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';

async function settle(execution) {
  const result = await terminateSuiteExecution(execution, {
    processLabel: 'UI journey profiler',
    terminationGraceMs: 5_000,
    terminationForceMs: 5_000,
    waitForSuiteSettlement,
  });
  if (!result.settled || result.errors.length)
    throw new Error(
      `Profile process cleanup failed: ${JSON.stringify(result)}`,
    );
  let timer;
  try {
    await Promise.race([
      execution.completion,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Profile command output did not reach EOF')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const evidence = execution.settlementEvidence?.();
  if (evidence && !evidence.barriers.receiverOutputEof)
    throw new Error('Profile command output did not reach EOF');
}

function startCommand(root, args, env, logPath) {
  let command;
  let interruption;
  let interrupt;
  let stopPromise;
  const interrupted = new Promise((accept) => {
    interrupt = accept;
  });
  const onSignal = (signal) => {
    if (interruption) return;
    interruption = new Error(`UI profiling interrupted by ${signal}`);
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    interrupt({ status: null, error: interruption });
    void command?.stop().catch((error) => {
      process.exitCode = 1;
      console.error(error);
    });
  };
  const removeSignals = ['SIGINT', 'SIGTERM'].map((signal) =>
    registerProcessSignal(signal, () => onSignal(signal)),
  );
  let execution;
  try {
    execution = executeOwnedCommand(
      process.execPath,
      args,
      undefined,
      `UI profile: ${args[0]}`,
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    for (const remove of removeSignals) remove();
    throw error;
  }
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 4 * 1024 * 1024,
    onOverflow: () => void command.stop().catch(() => {}),
  });
  command = {
    execution,
    assertNotInterrupted() {
      if (interruption) throw interruption;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        try {
          const failures = [];
          try {
            await settle(execution);
          } catch (error) {
            failures.push(error);
          }
          const output = capture.finish();
          writeFileSync(
            logPath,
            `${output.stdout.text}\n${output.stderr.text}`,
          );
          writeFileSync(
            `${logPath}.process.json`,
            JSON.stringify(
              {
                settlement: execution.settlementEvidence?.(),
                truncated: output.truncated,
                invalidUtf8: output.invalidUtf8,
              },
              null,
              2,
            ),
          );
          if (output.truncated || output.invalidUtf8)
            failures.push(new Error(`Incomplete command output: ${logPath}`));
          if (failures.length)
            throw new AggregateError(
              failures,
              `Profile command did not settle: ${logPath}`,
            );
        } finally {
          for (const remove of removeSignals) remove();
        }
      })();
      return stopPromise;
    },
    async wait(timeoutMs) {
      let timer;
      let failure;
      try {
        const result = await Promise.race([
          execution.completion,
          interrupted,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Profile command timed out: ${logPath}`)),
              timeoutMs,
            );
          }),
        ]);
        if (result.error || result.status !== 0)
          throw new Error(`Profile command failed: ${logPath}`, {
            cause: result.error,
          });
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
      }
      try {
        await this.stop();
      } catch (error) {
        throw new AggregateError(
          [...(failure ? [failure] : []), error],
          `Profile command cleanup failed: ${logPath}`,
        );
      }
      this.assertNotInterrupted();
      if (failure) throw failure;
    },
  };
  return command;
}

export async function startFixtureUi(root, output, sourceIdentity) {
  const uiDirectory = resolve(output, 'ui');
  const provenancePath = resolve(output, 'build.provenance.json');
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    STATION_JOURNEY_PROFILE_DIR: output,
    STATION_BUILD_UI_DIR: uiDirectory,
    STATION_JOURNEY_BUILD_PROVENANCE: provenancePath,
  };
  const buildArgs = [
    'node_modules/vite/bin/vite.js',
    'build',
    '--mode',
    'production',
    '--outDir',
    uiDirectory,
  ];
  await startCommand(root, buildArgs, env, join(output, 'build.log')).wait(
    300_000,
  );
  const provenance = JSON.stringify(
    {
      version: 1,
      sourceRevision: sourceIdentity.sourceRevision,
      sourceDiffSha256: sourceIdentity.sourceDiffSha256,
      executable: process.execPath,
      nodeVersion: process.version,
      nodeEnv: env.NODE_ENV,
      mode: 'production',
      outDir: uiDirectory,
      args: buildArgs,
      indexSha256: createHash('sha256')
        .update(readFileSync(join(uiDirectory, 'index.html')))
        .digest('hex'),
    },
    null,
    2,
  );
  writeFileSync(provenancePath, provenance);
  const buildProvenanceSha256 = createHash('sha256')
    .update(provenance)
    .digest('hex');
  await startCommand(
    root,
    ['scripts/ui-bundle-budget.mjs'],
    env,
    join(output, 'bundle-budget.log'),
  ).wait(30_000);
  const reservation = createServer();
  await new Promise((accept, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', accept);
  });
  const port = reservation.address().port;
  await new Promise((accept, reject) =>
    reservation.close((error) => (error ? reject(error) : accept())),
  );
  if (port === 3000 || port === 3141)
    throw new Error('Refusing a user-owned default port');
  const origin = `http://127.0.0.1:${port}`;
  const previewConfig = {
    configFile: false,
    root,
    build: { outDir: uiDirectory },
    preview: { host: '127.0.0.1', port, strictPort: true, proxy: {} },
  };
  const server = startCommand(
    root,
    [
      '--input-type=module',
      '--eval',
      `import { preview } from 'vite'; await preview(${JSON.stringify(previewConfig)});`,
    ],
    env,
    join(output, 'preview.log'),
  );
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (!server.execution.isAlive())
        throw new Error('UI profile preview exited before readiness');
      let response;
      try {
        response = await fetch(origin, {
          signal: AbortSignal.timeout(1000),
        });
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== 'TimeoutError')
          throw error;
      }
      if (response?.ok && (await response.text()).includes('/assets/')) break;
      if (Date.now() >= deadline)
        throw new Error('UI profile preview not ready');
      await new Promise((accept) => setTimeout(accept, 100));
    }
    server.assertNotInterrupted();
    return {
      buildProvenanceSha256,
      stop: async () => {
        await server.stop();
        server.assertNotInterrupted();
      },
      run: async (journey, directory) => {
        server.assertNotInterrupted();
        await startCommand(
          root,
          [
            'node_modules/@playwright/test/cli.js',
            'test',
            journey.spec,
            '--project=chromium',
            '--workers=1',
            '--retries=0',
            '--grep',
            journey.grep,
          ],
          {
            ...env,
            PW_BASE_URL: origin,
            STATION_E2E_RUNNER: '1',
            STATION_E2E_ESTABLISHED_USER: '1',
            STATION_E2E_BROWSER_SESSION_CREDENTIAL:
              randomBytes(32).toString('base64url'),
            STATION_E2E_HOST_CREDENTIAL: randomBytes(32).toString('base64url'),
            STATION_E2E_OUTPUT_DIR: join(
              directory,
              'playwright',
              journey.ids[0],
            ),
            STATION_JOURNEY_PROFILE_DIR: directory,
          },
          join(directory, `${journey.ids[0]}.log`),
        ).wait(300_000);
      },
    };
  } catch (error) {
    await server.stop();
    throw error;
  }
}
