import {
  cpSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  inspectDesktopServerRuntime,
  stageDesktopServerRuntime,
} from './lib/desktop-server-runtime.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'station-cedar-package-'));
const staged = join(scratch, 'installed');
let retainScratch = false;
try {
  // Exercise the production desktop/portable stager and its pruning rules.
  stageDesktopServerRuntime({
    projectRoot: root,
    outputRoot: staged,
    packages: ['@cedar-policy/cedar-wasm'],
  });
  cpSync(
    resolve('dist-server/cedar-policy-probe.js'),
    join(staged, 'probe.mjs'),
  );
  cpSync(resolve('dist-server/third-party'), join(staged, 'third-party'), {
    recursive: true,
  });
  writeFileSync(
    join(staged, 'offline.cjs'),
    "const net = require('node:net'); net.connect = net.createConnection = () => { throw new Error('network forbidden'); }; globalThis.fetch = () => { throw new Error('network forbidden'); };\n",
  );
  const env = {
    ...process.env,
    NODE_PATH: '',
    NODE_OPTIONS: '',
    HOME: scratch,
    STATION_HOME: join(scratch, 'home'),
    STATION_INSTANCE: 'cedar-package-probe',
  };
  async function run() {
    const execution = executeOwnedCommand(
      process.execPath,
      ['--require', join(staged, 'offline.cjs'), join(staged, 'probe.mjs')],
      undefined,
      'Cedar packaged probe',
      {
        cwd: staged,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = captureOwnedProcessOutput(execution);
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cedar probe timeout')), 30000);
    });
    let result;
    try {
      result = await Promise.race([execution.completion, timeout]);
    } catch (error) {
      result = { error };
    } finally {
      clearTimeout(timer);
      const settlement = await terminateSuiteExecution(execution, {
        processLabel: 'Cedar packaged probe',
        terminationGraceMs: 1000,
        terminationForceMs: 5000,
        waitForSuiteSettlement,
      });
      retainScratch = !settlement.settled;
    }
    if (retainScratch)
      throw new Error(`Unsettled Cedar probe; retaining ${scratch}`);
    const captured = output.finish();
    if (
      captured.truncated ||
      captured.invalidUtf8 ||
      result.error ||
      result.signal
    )
      throw new Error('Packaged probe did not complete cleanly');
    return {
      status: result.status,
      stdout: captured.stdout.text,
      stderr: captured.stderr.text,
    };
  }

  const positive = await run();
  if (positive.status !== 0)
    throw new Error(`Packaged probe failed: ${positive.stderr}`);
  const wasm = join(
    staged,
    'node_modules/@cedar-policy/cedar-wasm/nodejs/cedar_wasm_bg.wasm',
  );
  renameSync(wasm, `${wasm}.held`);
  const missingAsset = await run();
  if (
    missingAsset.status === 0 ||
    !missingAsset.stderr.includes('initialization')
  )
    throw new Error('Missing WASM did not fail closed at initialization');
  renameSync(`${wasm}.held`, wasm);
  const restored = await run();
  if (restored.status !== 0)
    throw new Error(`Restored package failed: ${restored.stderr}`);
  process.stdout.write(
    `${JSON.stringify({ sourceRevision: process.env.STATION_PROBE_REVISION ?? 'NOT_RECORDED', receipt: JSON.parse(positive.stdout), restored: JSON.parse(restored.stdout), missingAsset: 'deny:initialization', runtimeClosure: inspectDesktopServerRuntime(staged), wasmBytes: statSync(wasm).size, probeBytes: statSync(join(staged, 'probe.mjs')).size, licenseBytes: readFileSync(join(staged, 'third-party/cedar/LICENSE')).length })}\n`,
  );
} finally {
  if (!retainScratch) rmSync(scratch, { recursive: true, force: true });
}
