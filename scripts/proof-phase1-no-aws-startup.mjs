import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { findFreePortBlock, findFreePortOutside } from './lib/free-ports.mjs';

const ROOT_DIR = process.cwd();
const INSTANCE_PREFIX = 'phase1-no-aws';
const PORT_BLOCK_SIZE = 3;
const STARTUP_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const args = {
    artifactDir: join(ROOT_DIR, '.omx', 'artifacts', 'phase1-no-aws-startup'),
    keepTempHome: false,
  };

  for (const arg of argv) {
    if (arg.startsWith('--artifact-dir=')) {
      args.artifactDir = resolve(arg.slice('--artifact-dir='.length));
      continue;
    }
    if (arg === '--keep-temp-home') {
      args.keepTempHome = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function scrubAwsEnv(env) {
  const scrubbed = { ...env };
  const removed = [];
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith('AWS_') || key === 'AWS_PROFILE') {
      delete scrubbed[key];
      removed.push(key);
    }
  }
  return { env: scrubbed, removed: removed.sort() };
}

function withAwsScrubSentinels(env) {
  return {
    ...env,
    AWS_ACCESS_KEY_ID:
      env.AWS_ACCESS_KEY_ID ?? 'station-proof-should-be-scrubbed',
    AWS_SECRET_ACCESS_KEY:
      env.AWS_SECRET_ACCESS_KEY ?? 'station-proof-should-be-scrubbed',
    AWS_SESSION_TOKEN:
      env.AWS_SESSION_TOKEN ?? 'station-proof-should-be-scrubbed',
    AWS_PROFILE: env.AWS_PROFILE ?? 'station-proof-should-be-scrubbed',
  };
}

async function snapshotPath(targetPath) {
  if (!existsSync(targetPath)) {
    return { exists: false, entries: [] };
  }

  const entries = [];

  async function visit(currentPath) {
    const stat = statSync(currentPath, { throwIfNoEntry: false });
    if (!stat) return;
    const relPath = relative(targetPath, currentPath) || '.';
    const entry = {
      path: relPath,
      type: stat.isDirectory()
        ? 'directory'
        : stat.isSymbolicLink()
          ? 'symlink'
          : stat.isFile()
            ? 'file'
            : 'other',
      mode: stat.mode,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
    if (stat.isFile()) {
      entry.sha256 = createHash('sha256')
        .update(await readFile(currentPath))
        .digest('hex');
    }
    entries.push(entry);

    if (stat.isDirectory()) {
      const children = await readdir(currentPath);
      for (const child of children.sort()) {
        await visit(join(currentPath, child));
      }
    }
  }

  await visit(targetPath);

  return {
    exists: true,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function snapshotsEqual(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function summarizeSnapshotDiff(before, after) {
  const beforeMap = new Map(before.entries.map((entry) => [entry.path, entry]));
  const afterMap = new Map(after.entries.map((entry) => [entry.path, entry]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [path, entry] of afterMap) {
    if (!beforeMap.has(path)) {
      added.push(path);
      continue;
    }
    if (JSON.stringify(beforeMap.get(path)) !== JSON.stringify(entry)) {
      changed.push(path);
    }
  }

  for (const path of beforeMap.keys()) {
    if (!afterMap.has(path)) removed.push(path);
  }

  return { added, removed, changed };
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      shell: false,
      windowsHide: true,
      ...options,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      process.stderr.write(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(
        new Error(
          `${command} ${args.join(' ')} timed out after ${STARTUP_TIMEOUT_MS}ms`,
        ),
      );
    }, options.timeoutMs ?? STARTUP_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      const result = { command, args, code, stdout, stderr };
      if (code === 0) {
        resolveRun(result);
        return;
      }
      const error = new Error(
        `${command} ${args.join(' ')} exited with ${code}`,
      );
      error.result = result;
      reject(error);
    });
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}: ${body}`);
    }
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

function assertProviderNeutralStatus(status) {
  if (!status || typeof status !== 'object') {
    throw new Error('/api/system/status did not return an object');
  }
  if (!status.recommendation || typeof status.recommendation !== 'object') {
    throw new Error('/api/system/status did not include a recommendation');
  }
  if (status.providers?.detected?.bedrock !== false) {
    throw new Error(
      `Expected bedrock detection to be false with scrubbed AWS env, got ${JSON.stringify(
        status.providers?.detected,
      )}`,
    );
  }
  if (status.recommendation.detectedProviderType === 'bedrock') {
    throw new Error(
      `Expected provider-neutral recommendation, got ${JSON.stringify(
        status.recommendation,
      )}`,
    );
  }
  if (status.capabilities?.chat?.source === 'bedrock') {
    throw new Error(
      `Expected chat capability not to default to bedrock, got ${JSON.stringify(
        status.capabilities.chat,
      )}`,
    );
  }
}

function readInstanceState(instance) {
  const statePath = join(ROOT_DIR, '.station', 'instances', `${instance}.json`);
  if (!existsSync(statePath)) {
    throw new Error(`Missing instance state file: ${statePath}`);
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.artifactDir, { recursive: true });

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const instance = `${INSTANCE_PREFIX}-${runId.slice(-8)}`;
  const defaultHome = join(homedir(), '.station');
  const serverPort = await findFreePortBlock(PORT_BLOCK_SIZE);
  const uiPort = await findFreePortOutside(serverPort, PORT_BLOCK_SIZE);
  const serverLog = join(args.artifactDir, `${runId}-server.log`);
  const artifactPath = join(args.artifactDir, `${runId}.json`);
  const { env, removed } = scrubAwsEnv(withAwsScrubSentinels(process.env));

  const startArgs = [
    'start',
    `--instance=${instance}`,
    '--temp-home',
    '--clean',
    '--force',
    `--port=${serverPort}`,
    `--ui-port=${uiPort}`,
    `--log=${serverLog}`,
  ];
  const stopArgs = ['stop', `--instance=${instance}`];

  const artifact = {
    proof: 'phase1-no-aws-startup',
    runId,
    startedAt: new Date().toISOString(),
    instance,
    serverPort,
    uiPort,
    defaultHome,
    awsEnvScrubbed: true,
    awsEnvRemoved: removed,
    commands: {
      start: ['./station', ...startArgs],
      stop: ['./station', ...stopArgs],
    },
    serverLog,
    checks: {},
  };

  const beforeDefaultHome = await snapshotPath(defaultHome);
  let instanceState;
  let startResult;
  let stopResult;
  let status;
  let proofError;

  try {
    startResult = await run('./station', startArgs, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    instanceState = readInstanceState(instance);
    status = await fetchJson(
      `http://127.0.0.1:${serverPort}/api/system/status`,
    );
    assertProviderNeutralStatus(status);

    const tempHome = instanceState.baseDir;
    if (!tempHome || resolve(tempHome) === resolve(defaultHome)) {
      throw new Error(
        `Expected --temp-home to use a non-default home, got ${tempHome}`,
      );
    }
    if (!resolve(tempHome).startsWith(resolve(tmpdir()))) {
      throw new Error(`Expected temp home under ${tmpdir()}, got ${tempHome}`);
    }

    artifact.tempHome = tempHome;
    artifact.status = {
      ready: status.ready,
      recommendation: status.recommendation,
      providers: status.providers,
      capabilities: status.capabilities,
    };
    artifact.checks.providerNeutralStatus = 'PASS';
    artifact.checks.tempHome = 'PASS';
  } catch (error) {
    proofError = error;
    artifact.proofError =
      error instanceof Error ? error.message : String(error);
  } finally {
    try {
      stopResult = await run('./station', stopArgs, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      artifact.stopError =
        error instanceof Error ? error.message : String(error);
    }
  }

  const afterDefaultHome = await snapshotPath(defaultHome);
  const defaultHomeUnchanged = snapshotsEqual(
    beforeDefaultHome,
    afterDefaultHome,
  );
  artifact.checks.defaultHomeUnchanged = defaultHomeUnchanged ? 'PASS' : 'FAIL';
  artifact.defaultHomeSnapshot = {
    beforeExists: beforeDefaultHome.exists,
    afterExists: afterDefaultHome.exists,
    beforeEntryCount: beforeDefaultHome.entries.length,
    afterEntryCount: afterDefaultHome.entries.length,
    diff: defaultHomeUnchanged
      ? { added: [], removed: [], changed: [] }
      : summarizeSnapshotDiff(beforeDefaultHome, afterDefaultHome),
  };
  artifact.commands.startResult = startResult
    ? {
        code: startResult.code,
        stdoutTail: startResult.stdout.slice(-4_000),
        stderrTail: startResult.stderr.slice(-4_000),
      }
    : null;
  artifact.commands.stopResult = stopResult
    ? {
        code: stopResult.code,
        stdoutTail: stopResult.stdout.slice(-4_000),
        stderrTail: stopResult.stderr.slice(-4_000),
      }
    : null;
  artifact.completedAt = new Date().toISOString();

  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

  if (proofError) {
    throw new Error(
      `Phase 1 no-AWS startup proof failed. See artifact: ${artifactPath}. ${
        proofError instanceof Error ? proofError.message : String(proofError)
      }`,
    );
  }

  if (!defaultHomeUnchanged) {
    throw new Error(
      `Default home mutated during proof. See artifact: ${artifactPath}`,
    );
  }

  if (
    !args.keepTempHome &&
    artifact.tempHome &&
    existsSync(artifact.tempHome)
  ) {
    rmSync(artifact.tempHome, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        proof: artifact.proof,
        artifactPath,
        instance,
        serverPort,
        uiPort,
        recommendation: status.recommendation.code,
        defaultHomeUnchanged,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
