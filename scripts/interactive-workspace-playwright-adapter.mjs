#!/usr/bin/env node

/**
 * Reference adapter for station#2892. It owns browser/build attestation only;
 * product code (currently #2890) owns the in-page measurement bridge.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { cpus, platform, release, totalmem } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReceiptMatches,
  PRODUCTION_BRIDGE_GLOBAL,
  PRODUCTION_BRIDGE_VERSION,
  unavailableBridgeObservations,
  validateProductionBridgeEvidence,
} from './lib/interactive-workspace-production-bridge.mjs';

const ADAPTER = 'station-playwright-production-v1';
const REFERENCE_MODE_PARAM = 'station-performance-reference';
const REFERENCE_MODE_VALUE = 'interactive-workspace-v3';
const MAX_STORAGE_STATE_BYTES = 1024 * 1024;
const MAX_CONTROL_RECEIPT_BYTES = 32 * 1024;
// The real 10k reconnect seed can legitimately keep the private control
// request open for much longer than ordinary browser actions. Keep that
// exception bounded and local to this reference-only socket.
export const REFERENCE_CONTROL_SOCKET_RESPONSE_TIMEOUT_MS = 30 * 60 * 1000;
const RECONNECT_RELEASE_BINDING =
  '__stationInteractiveWorkspaceReconnectRelease';
export const WORK_BOARD_DRIVER_READY_TIMEOUT_MS = 30_000;
export const RECONNECT_POOL_BATCH_SIZE = 1;
export const RECONNECT_EDITOR_READY_TIMEOUT_MS = 60_000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const now = () =>
  process.env.STATION_PERFORMANCE_NOW ?? new Date().toISOString();

function revision(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function powerShell(command) {
  if (process.platform !== 'win32') return null;
  try {
    return (
      execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

export function productionBuildReceipt(
  cwd,
  expectedRevision,
  buildDir = 'dist-ui',
) {
  const absoluteBuildDir = resolve(cwd, buildDir);
  const index = resolve(absoluteBuildDir, 'index.html');
  if (!existsSync(index)) return null;
  const content = readFileSync(index, 'utf8');
  const uiCommit = /name="station-build-commit" content="([^"]+)"/.exec(
    content,
  )?.[1];
  if (!uiCommit || !expectedRevision.startsWith(uiCommit)) return null;
  return { kind: 'vite-production-bundle', sha256: hash(content), uiCommit };
}

export function normalizeAttachedStationHtml(value) {
  // Station's bootstrap script carries a per-response CSP nonce, so it has to
  // be normalized out or the attached build receipt hashes differently on
  // every response. The shape changed in station#4287: the old bootstrap
  // published `window.__STATION_CSP_NONCE__`, which no longer exists; the
  // current one sets `window.__API_BASE__` and is emitted only under an
  // explicit override. Both are matched so historical captures keep
  // normalizing.
  const pattern =
    /<script nonce="[A-Za-z0-9+/=]+">window\.(?:__STATION_CSP_NONCE__=document\.currentScript\.nonce|__API_BASE__=[^<]*)<\/script>/g;
  const matches = value.match(pattern) ?? [];
  if (matches.length > 1) return null;
  return matches.length === 1 ? value.replace(pattern, '') : value;
}

function runtimeMetadata(cwd, build) {
  return {
    cpu: cpus()[0]?.model ?? null,
    ramBytes: totalmem(),
    gpu: powerShell(
      '(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)',
    ),
    display: powerShell(
      '(Get-CimInstance Win32_DesktopMonitor | Select-Object -First 1 -ExpandProperty Name)',
    ),
    os: `${platform()} ${release()}`,
    platform: platform(),
    buildMode: build ? 'production' : 'unverified',
    revision: revision(cwd),
    build,
  };
}

export function referenceAuthContext(env = process.env) {
  const storageState = env.STATION_PERFORMANCE_STORAGE_STATE;
  const bearer = env.STATION_PERFORMANCE_AUTHORIZATION;
  if ((storageState && bearer) || (!storageState && !bearer)) return null;
  if (storageState) {
    try {
      if (
        !isAbsolute(storageState) ||
        Buffer.byteLength(storageState, 'utf8') > 4096 ||
        realpathSync(storageState) !== resolve(storageState)
      )
        return null;
      const stat = lstatSync(storageState);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 2 ||
        stat.size > MAX_STORAGE_STATE_BYTES ||
        (process.platform !== 'win32' &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
      )
        return null;
      const parsed = JSON.parse(readFileSync(storageState, 'utf8'));
      if (
        !plainRecord(parsed) ||
        !exactKeys(parsed, ['cookies', 'origins']) ||
        !Array.isArray(parsed.cookies) ||
        parsed.cookies.length > 512 ||
        !Array.isArray(parsed.origins) ||
        parsed.origins.length > 128
      )
        return null;
      return { kind: 'storage-state', storageState };
    } catch {
      return null;
    }
  }
  return typeof bearer === 'string' &&
    bearer.length >= 16 &&
    bearer.length <= 4096 &&
    /^[A-Za-z0-9._~-]+$/.test(bearer)
    ? { kind: 'authorization', authorization: `Bearer ${bearer}` }
    : null;
}

export function referencePeerAuthContext(env = process.env) {
  return referenceAuthContext({
    STATION_PERFORMANCE_STORAGE_STATE:
      env.STATION_PERFORMANCE_PEER_STORAGE_STATE,
    STATION_PERFORMANCE_AUTHORIZATION:
      env.STATION_PERFORMANCE_PEER_AUTHORIZATION,
  });
}

function plainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function performanceControlSocket(env = process.env) {
  const value = env.STATION_PERFORMANCE_CONTROL_SOCKET;
  return typeof value === 'string' &&
    isAbsolute(value) &&
    Buffer.byteLength(value, 'utf8') <= 100
    ? value
    : null;
}

function controlCommand(socketPath, command) {
  return new Promise((resolveCommand, reject) => {
    const socket = createConnection(socketPath);
    const chunks = [];
    let bytes = 0;
    socket.setTimeout(REFERENCE_CONTROL_SOCKET_RESPONSE_TIMEOUT_MS, () =>
      socket.destroy(new Error('control timed out')),
    );
    socket.on('connect', () => socket.end(`${JSON.stringify(command)}\n`));
    socket.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CONTROL_RECEIPT_BYTES)
        return socket.destroy(new Error('control receipt exceeded budget'));
      chunks.push(chunk);
    });
    socket.on('error', reject);
    socket.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.endsWith('\n') || raw.indexOf('\n') !== raw.length - 1)
          throw new Error('control receipt framing is invalid');
        resolveCommand(JSON.parse(raw.slice(0, -1)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function taskIdFromTarget(target) {
  const match = /^\/tasks\/([^/]+)$/.exec(target.pathname);
  if (!match) return null;
  try {
    const taskId = decodeURIComponent(match[1]);
    return taskId && taskId.length <= 256 && taskId === taskId.trim()
      ? taskId
      : null;
  } catch {
    return null;
  }
}

function boardOnlyFixture(config) {
  return (
    Array.isArray(config?.fixtures) &&
    config.fixtures.length > 0 &&
    config.fixtures.every(
      (fixture) =>
        fixture?.id === 'work-board-200-pins-v1' ||
        fixture?.id === 'work-board-one-hour-v1',
    )
  );
}

function projectRouteTarget(target) {
  return /^\/projects\/[^/]+(?:\/|$)/.test(target.pathname);
}

async function authenticatedTaskAvailable(page, taskId) {
  return page.evaluate(async (expectedTaskId) => {
    try {
      const response = await fetch(
        `/api/tasks/${encodeURIComponent(expectedTaskId)}/room`,
      );
      const value = await response.json();
      return (
        response.status === 200 &&
        value?.success === true &&
        value?.data?.scope?.taskId === expectedTaskId
      );
    } catch {
      return false;
    }
  }, taskId);
}

export function unavailable(config, reason, details = {}) {
  return {
    adapter: ADAPTER,
    generatedAt: now(),
    provenance: { source: 'adapter-probe', ...details },
    observations: unavailableBridgeObservations(config, reason),
  };
}

export async function bridgeEvidence(page, config) {
  await page
    .waitForFunction(
      ({ globalName, version }) =>
        window[globalName]?.version === version &&
        typeof window[globalName]?.measure === 'function',
      {
        globalName: PRODUCTION_BRIDGE_GLOBAL,
        version: PRODUCTION_BRIDGE_VERSION,
      },
      { timeout: 30_000 },
    )
    .catch(() => {});
  if (boardOnlyFixture(config)) {
    const driverReady = await page.evaluate(
      async ({ globalName, timeoutMs }) => {
        const bridge = window[globalName];
        if (!bridge || typeof bridge.waitForBoardDriver !== 'function')
          return false;
        return Promise.race([
          bridge.waitForBoardDriver().then(() => true),
          new Promise((resolve) =>
            window.setTimeout(() => resolve(false), timeoutMs),
          ),
        ]);
      },
      {
        globalName: PRODUCTION_BRIDGE_GLOBAL,
        timeoutMs: WORK_BOARD_DRIVER_READY_TIMEOUT_MS,
      },
    );
    if (driverReady !== true)
      return {
        version: PRODUCTION_BRIDGE_VERSION,
        source: 'station-ui-production-bridge',
        observations: unavailableBridgeObservations(
          config,
          'WORK_BOARD_PERFORMANCE_DRIVER_UNAVAILABLE',
        ),
      };
  }
  return page.evaluate(
    async ({ globalName, version, sampling, fixtureCorpus, fixtures }) => {
      const bridge = window[globalName];
      if (
        !bridge ||
        bridge.version !== version ||
        typeof bridge.measure !== 'function'
      )
        return null;
      return bridge.measure({ sampling, fixtureCorpus, fixtures });
    },
    {
      globalName: PRODUCTION_BRIDGE_GLOBAL,
      version: PRODUCTION_BRIDGE_VERSION,
      sampling: config.sampling,
      fixtureCorpus: config.fixtureCorpus,
      fixtures: config.fixtures,
    },
  );
}

export async function measure(
  config,
  cwd,
  {
    env = process.env,
    target = env.STATION_PERFORMANCE_UI_URL,
    buildDir = env.STATION_PERFORMANCE_UI_BUILD_DIR || 'dist-ui',
    resolveRevision = revision,
    readBuildReceipt = productionBuildReceipt,
    loadChromium = () => import('playwright'),
    metadata = runtimeMetadata,
  } = {},
) {
  if (!target)
    return unavailable(config, 'REAL_STATION_BROWSER_TARGET_UNAVAILABLE');
  let targetUrl;
  try {
    targetUrl = new URL(target);
  } catch {
    return unavailable(config, 'REAL_STATION_BROWSER_TARGET_INVALID');
  }
  const taskId = taskIdFromTarget(targetUrl);
  const isBoardTarget = boardOnlyFixture(config);
  if (
    targetUrl.username ||
    targetUrl.password ||
    targetUrl.hash ||
    (!taskId && !(isBoardTarget && projectRouteTarget(targetUrl))) ||
    [...targetUrl.searchParams].some(
      ([key, value]) =>
        key !== REFERENCE_MODE_PARAM || value !== REFERENCE_MODE_VALUE,
    )
  )
    return unavailable(config, 'REAL_STATION_BROWSER_TARGET_INVALID');
  if (targetUrl.searchParams.get(REFERENCE_MODE_PARAM) !== REFERENCE_MODE_VALUE)
    return unavailable(config, 'PRODUCTION_MEASUREMENT_MODE_UNAVAILABLE');
  const auth = referenceAuthContext(env);
  if (!auth)
    return unavailable(config, 'REFERENCE_BROWSER_AUTH_CONTEXT_UNAVAILABLE');
  const peerAuth = referencePeerAuthContext(env);
  const build = readBuildReceipt(cwd, resolveRevision(cwd), buildDir);
  if (!build)
    return unavailable(config, 'PRODUCTION_BUILD_RECEIPT_UNAVAILABLE');
  let chromium;
  try {
    ({ chromium } = await loadChromium());
  } catch {
    return unavailable(config, 'PLAYWRIGHT_RUNTIME_UNAVAILABLE');
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const controlSocket = performanceControlSocket(env);
    const observations = [];
    let bridgeSource;
    let currentAuth = auth;
    let currentPeerAuth = peerAuth;
    const fixtureOrder = new Map(
      config.fixtures.map((fixture, index) => [fixture.id, index]),
    );
    const isolatedFixtures = [...config.fixtures].sort(
      (left, right) =>
        Number(right.id === 'synthetic-collaboration') -
        Number(left.id === 'synthetic-collaboration'),
    );
    for (const fixture of isolatedFixtures) {
      const result = await measureIsolatedFixture({
        browser,
        auth: currentAuth,
        peerAuth: currentPeerAuth,
        build,
        baseTarget: targetUrl,
        baseTaskId: taskId,
        controlSocket,
        env,
        config: { ...config, fixtures: [fixture] },
      });
      currentAuth = result.auth;
      currentPeerAuth = result.peerAuth;
      bridgeSource ??= result.evidence.source;
      observations.push(...result.evidence.observations);
    }
    observations.sort(
      (left, right) =>
        (fixtureOrder.get(left.fixtureId) ?? Number.MAX_SAFE_INTEGER) -
        (fixtureOrder.get(right.fixtureId) ?? Number.MAX_SAFE_INTEGER),
    );
    const evidence = {
      version: PRODUCTION_BRIDGE_VERSION,
      source: bridgeSource ?? 'station-ui-production-bridge',
      observations,
    };
    const rawOutput = env.STATION_PERFORMANCE_RAW_BRIDGE_OUTPUT;
    if (
      typeof rawOutput === 'string' &&
      isAbsolute(rawOutput) &&
      Buffer.byteLength(rawOutput, 'utf8') <= 4096 &&
      realpathSync(dirname(rawOutput)) === dirname(resolve(rawOutput))
    )
      writeFileSync(rawOutput, `${JSON.stringify(evidence)}\n`, {
        mode: 0o600,
      });
    const validated = validateProductionBridgeEvidence(config, evidence);
    return {
      adapter: ADAPTER,
      // A long reference run must be fresh at completion, not at child spawn.
      generatedAt: new Date().toISOString(),
      provenance: {
        source: 'executed-in-run',
        metadata: metadata(cwd, build),
        bridge: {
          version: PRODUCTION_BRIDGE_VERSION,
          source: evidence.source,
        },
      },
      observations: validated.observations,
    };
  } finally {
    await browser.close();
  }
}

async function measureIsolatedFixture({
  browser,
  auth,
  peerAuth,
  build,
  baseTarget,
  baseTaskId,
  controlSocket,
  env,
  config,
}) {
  const fixture = config.fixtures[0];
  const isBoardFixture =
    fixture.id === 'work-board-200-pins-v1' ||
    fixture.id === 'work-board-one-hour-v1';
  const taskId = isBoardFixture
    ? undefined
    : fixtureTaskId(fixture.id, baseTaskId, env);
  if (!isBoardFixture && !taskId)
    return {
      auth,
      peerAuth,
      evidence: {
        source: 'station-ui-production-bridge',
        observations: unavailableBridgeObservations(
          config,
          `ISOLATED_FIXTURE_TASK_UNAVAILABLE_${fixture.id}`,
        ),
      },
    };
  const targetUrl = new URL(baseTarget);
  if (taskId) targetUrl.pathname = `/tasks/${encodeURIComponent(taskId)}`;
  const context = await authenticatedContext(browser, auth);
  let peerContext;
  let reconnectHarness;
  let refreshedAuth = auth;
  let refreshedPeerAuth = peerAuth;
  try {
    const page = await context.newPage();
    const peer =
      (fixture.id === 'synthetic-collaboration' ||
        fixture.id === 'long-session-bounded-growth') &&
      peerAuth
        ? await (async () => {
            peerContext = await authenticatedContext(browser, peerAuth);
            const candidate = await peerContext.newPage();
            await candidate.route('**/room/live', async (route) => {
              await route.continue({
                headers: {
                  ...route.request().headers(),
                  'x-station-performance-reference': 'interactive-workspace-v3',
                },
              });
            });
            return candidate;
          })()
        : null;
    if (controlSocket || peer || isBoardFixture)
      await page.exposeBinding(
        '__stationInteractiveWorkspacePerformanceDriver',
        async (_source, command) => {
          if (!plainRecord(command) || !validDriverIteration(command.iteration))
            throw new Error('performance driver command is invalid');
          if (command.kind === 'prepare-100k-corpus') {
            if (
              !controlSocket ||
              !exactKeys(command, ['kind', 'phase', 'iteration']) ||
              (command.phase !== 'warm' && command.phase !== 'cold')
            )
              throw new Error('performance corpus driver is unavailable');
            try {
              return await controlCommand(controlSocket, {
                command: 'prepare-performance-corpus',
                taskId,
                phase: command.phase,
                iteration: command.iteration,
              });
            } catch (error) {
              return {
                kind: 'unavailable',
                reason: closedControlReason(error),
              };
            }
          }
          if (command.kind === 'reconnect-cycle') {
            if (
              !controlSocket ||
              !reconnectHarness ||
              !exactKeys(command, ['kind', 'iteration'])
            )
              throw new Error('reconnect driver is unavailable');
            return reconnectHarness.run(command.iteration);
          }
          if (
            isBoardFixture &&
            exactKeys(command, ['kind', 'iteration']) &&
            (command.kind === 'work-board-keyboard-move-resize' ||
              command.kind === 'work-board-pointer-move-resize')
          )
            return performWorkBoardInteraction(page, command.kind);
          if (
            !peer ||
            !exactKeys(command, ['kind', 'iteration']) ||
            (command.kind !== 'collaboration-presence' &&
              command.kind !== 'collaboration-cursor')
          )
            throw new Error('collaboration driver is unavailable');
          return command.kind === 'collaboration-presence'
            ? publishPeerPresence(
                peer,
                page,
                command.iteration,
                targetUrl.href,
                taskId,
              )
            : publishPeerCursor(peer, page, taskId, command.iteration);
        },
      );
    const response = await page.goto(targetUrl.href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const attachedHtml = response ? await response.text() : null;
    const attached = attachedHtml
      ? {
          sha256: (() => {
            const normalized = normalizeAttachedStationHtml(attachedHtml);
            return normalized ? hash(normalized) : null;
          })(),
          uiCommit: await page
            .locator('meta[name="station-build-commit"]')
            .getAttribute('content'),
        }
      : null;
    if (!buildReceiptMatches(build, attached))
      throw new Error('attached build receipt mismatch');
    if (taskId && !(await authenticatedTaskAvailable(page, taskId)))
      throw new Error('authenticated Task unavailable');
    if (fixture.id === 'reconnect-10k-operations') {
      if (!controlSocket)
        throw new Error('reconnect fixture control is unavailable');
      reconnectHarness = await createReconnectHarness({
        browser,
        auth,
        retainedContext: context,
        retainedPage: page,
        targetUrl,
        retainedTaskId: taskId,
        controlSocket,
        operationCount:
          env.STATION_PERFORMANCE_RECONNECT_DIAGNOSTIC_SEED_COUNT === '10'
            ? 10
            : 10_000,
        totalIterations: config.sampling.warmups + config.sampling.samples,
      });
    }
    const evidence = await bridgeEvidence(page, config);
    if (!evidence) {
      refreshedAuth = await refreshedStorageAuth(context, auth);
      refreshedPeerAuth = peerContext
        ? await refreshedStorageAuth(peerContext, peerAuth)
        : peerAuth;
      return {
        auth: refreshedAuth,
        peerAuth: refreshedPeerAuth,
        evidence: {
          source: 'station-ui-production-bridge',
          observations: unavailableBridgeObservations(
            config,
            'PRODUCTION_MEASUREMENT_BRIDGE_UNAVAILABLE',
          ),
        },
      };
    }
    refreshedAuth = await refreshedStorageAuth(context, auth);
    refreshedPeerAuth = peerContext
      ? await refreshedStorageAuth(peerContext, peerAuth)
      : peerAuth;
    return { auth: refreshedAuth, peerAuth: refreshedPeerAuth, evidence };
  } catch (error) {
    refreshedAuth = await refreshedStorageAuth(context, auth);
    refreshedPeerAuth = peerContext
      ? await refreshedStorageAuth(peerContext, peerAuth)
      : peerAuth;
    return {
      auth: refreshedAuth,
      peerAuth: refreshedPeerAuth,
      evidence: {
        source: 'station-ui-production-bridge',
        observations: unavailableBridgeObservations(
          config,
          isolatedFixtureFailureReason(fixture.id, error),
        ),
      },
    };
  } finally {
    await reconnectHarness?.close();
    await peerContext?.close();
    await context.close();
  }
}

/**
 * Use Playwright's browser-owned input path. Synthetic DOM PointerEvents do
 * not join Chromium's active-pointer registry and therefore cannot legitimately
 * satisfy the Pane's setPointerCapture contract.
 */
export async function performWorkBoardInteraction(page, kind) {
  const move = page.locator('.spatial-board__move:not([disabled])').first();
  await move.scrollIntoViewIfNeeded();
  if (kind === 'work-board-keyboard-move-resize') {
    await move.focus();
    await page.keyboard.press('Shift+ArrowRight');
  } else {
    const box = await move.boundingBox();
    if (!box) throw new Error('Work Board pointer target has no box');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 20, y + 20);
    await page.mouse.up();
  }
  return { kind: 'work-board-interaction-completed' };
}

export function closedControlReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'control timed out') return 'CONTROL_TIMEOUT';
  if (message === 'control receipt framing is invalid')
    return 'CONTROL_FRAMING';
  if (message === 'control receipt exceeded budget')
    return 'CONTROL_RECEIPT_TOO_LARGE';
  if (error instanceof SyntaxError) return 'CONTROL_INVALID_JSON';
  if (
    error &&
    typeof error === 'object' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOENT', 'EPIPE'].includes(error.code)
  )
    return 'CONTROL_CONNECTION';
  return 'CONTROL_UNKNOWN';
}

function isolatedFixtureFailureReason(fixtureId, error) {
  const message = error instanceof Error ? error.message : '';
  const reconnectStage = /Reconnect stage ([A-Z0-9_]+) failed/.exec(message);
  if (reconnectStage) {
    const clientStage = /Reconnect client ([A-Z_]+) failed/.exec(message);
    return `ISOLATED_FIXTURE_RECONNECT_${reconnectStage[1]}${clientStage ? `_${clientStage[1]}` : ''}_FAILED_${fixtureId}`;
  }
  const boundary = message.includes('attached build receipt')
    ? 'BUILD_RECEIPT'
    : message.includes('authenticated Task') ||
        message.includes('Task contexts')
      ? 'TASK_AUTHORITY'
      : message.includes('fallback authority')
        ? 'FALLBACK_AUTHORITY'
        : message.includes('browser authority refresh')
          ? 'AUTHORITY_REFRESH'
          : message.includes('bridge') ||
              message.includes('page.evaluate') ||
              message.includes('prepareReconnectCycle')
            ? 'PRODUCT_BRIDGE'
            : message.includes('page.goto') || message.includes('navigation')
              ? 'NAVIGATION'
              : message.includes('closed') || message.includes('context')
                ? 'CONTEXT'
                : message.includes('Timeout') || message.includes('timed out')
                  ? 'TIMEOUT'
                  : 'UNCLASSIFIED';
  return `ISOLATED_FIXTURE_${boundary}_FAILED_${fixtureId}`;
}

async function refreshedStorageAuth(context, auth) {
  if (auth.kind !== 'storage-state') return auth;
  try {
    return {
      kind: 'storage-state',
      storageState: await context.storageState(),
    };
  } catch {
    return auth;
  }
}

function boundedTaskId(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
    ? value
    : null;
}

function fixtureTaskId(fixtureId, baseTaskId, env) {
  const configured = {
    'remote-apply': env.STATION_PERFORMANCE_REMOTE_TASK_ID,
    'synthetic-collaboration': env.STATION_PERFORMANCE_COLLABORATION_TASK_ID,
    'open-100k-lines': env.STATION_PERFORMANCE_FILE_TASK_ID,
    'reconnect-10k-operations': env.STATION_PERFORMANCE_RETAINED_TASK_ID,
  }[fixtureId];
  return configured === undefined ? baseTaskId : boundedTaskId(configured);
}

async function authenticatedContext(browser, auth) {
  return browser.newContext(
    auth.kind === 'storage-state'
      ? { storageState: auth.storageState }
      : { extraHTTPHeaders: { Authorization: auth.authorization } },
  );
}

async function createReconnectHarness({
  browser,
  auth,
  retainedContext,
  retainedPage,
  targetUrl,
  retainedTaskId,
  controlSocket,
  operationCount,
  totalIterations,
}) {
  if (
    !Number.isSafeInteger(totalIterations) ||
    totalIterations < 1 ||
    totalIterations > 105
  )
    throw new Error('Reconnect sample pool is invalid');
  const retainedTarget = new URL(targetUrl);
  retainedTarget.pathname = `/tasks/${encodeURIComponent(retainedTaskId)}`;
  if (new URL(retainedPage.url()).pathname !== retainedTarget.pathname)
    throw new Error('Reconnect retained Task identity changed');
  const clientStage = async (name, work) => {
    try {
      return await work();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      throw new Error(
        `Reconnect client ${name} failed: ${message.slice(0, 96)}`,
      );
    }
  };
  async function initializeClient(context, existingPage) {
    const page = existingPage ?? (await context.newPage());
    const documentGate = reconnectDocumentGate(retainedTaskId);
    const requestFence = reconnectRequestFence();
    const abortFence = reconnectAbortFence();
    let lastDocumentStatus;
    let phase = 'continue';
    let releaseResume;
    let resume = Promise.resolve();
    const armResume = () => {
      resume = new Promise((resolve) => {
        releaseResume = resolve;
      });
      phase = 'held';
    };
    const continueResume = () => {
      phase = 'continue';
      const release = releaseResume;
      releaseResume = undefined;
      release?.();
    };
    await page.exposeBinding(RECONNECT_RELEASE_BINDING, (_source, input) =>
      documentGate.release(input),
    );
    if (new URL(page.url()).pathname !== retainedTarget.pathname)
      await clientStage('NAVIGATION', () =>
        page.goto(retainedTarget.href, { waitUntil: 'domcontentloaded' }),
      );
    if (
      !(await clientStage('AUTHORITY', () =>
        authenticatedTaskAvailable(page, retainedTaskId),
      ))
    )
      throw new Error('Reconnect Task context is unavailable');
    // The direct probe may be the request that opens the room after the fresh
    // React query cached `unavailable`. Reload before taking the checkpoint.
    await clientStage('RELOAD', () =>
      page.reload({ waitUntil: 'domcontentloaded' }),
    );
    await clientStage('EDITOR', () =>
      page.waitForSelector('textarea[data-station-working-revision]', {
        state: 'visible',
        timeout: RECONNECT_EDITOR_READY_TIMEOUT_MS,
      }),
    );
    await clientStage('BRIDGE', () => bridgeReady(page));
    const checkpoint = await clientStage('CHECKPOINT', () =>
      reconnectCheckpoint(page),
    );
    page.on('response', (response) => {
      if (/\/room\/document(?:\?|$)/.test(new URL(response.url()).pathname))
        lastDocumentStatus = response.status();
    });
    await Promise.all([
      page.route('**/room/events', async (route) => {
        if (phase === 'abort-online') {
          abortFence.observe(route.request().headers()['last-event-id']);
          await route.abort('internetdisconnected');
          return;
        }
        if (phase === 'held') await resume;
        requestFence.observe(route.request().headers()['last-event-id']);
        await route.continue();
      }),
      page.route('**/room/document*', async (route) => {
        await documentGate.wait();
        await route.continue();
      }),
    ]);
    return {
      page,
      checkpoint,
      documentGate,
      requestFence,
      abortFence,
      armDocument: (strategy) => documentGate.arm(strategy),
      abort: async () => {
        const closed = abortFence.next(checkpoint);
        phase = 'abort-online';
        await page.evaluate(
          (globalName) => window[globalName].restartStream(),
          PRODUCTION_BRIDGE_GLOBAL,
        );
        await closed;
        armResume();
      },
      resume: async (strategy, expectedRevision, baseRevision) => {
        lastDocumentStatus = undefined;
        const startedEpochMs = await epoch(page);
        const observation = reconnectStage(
          `${strategy.toUpperCase()}_OBSERVE`,
          () =>
            page.evaluate(
              ({
                globalName,
                afterEpochMs,
                expectedRevision: revision,
                strategy: expectedStrategy,
              }) =>
                window[globalName].observeReconnect({
                  strategy: expectedStrategy,
                  afterEpochMs,
                  expectedRevision: revision,
                }),
              {
                globalName: PRODUCTION_BRIDGE_GLOBAL,
                afterEpochMs: startedEpochMs,
                expectedRevision,
                strategy,
              },
            ),
        );
        const request = requestFence.next(baseRevision);
        await page.evaluate(
          (globalName) => window[globalName].restartStream(),
          PRODUCTION_BRIDGE_GLOBAL,
        );
        continueResume();
        await request;
        let settledObservation;
        try {
          settledObservation = await observation;
        } catch (error) {
          const editor = await page.evaluate(() => {
            const value = document.querySelector(
              'textarea[data-station-working-revision]',
            );
            return value instanceof HTMLTextAreaElement
              ? value.dataset.stationWorkingRevision
              : null;
          });
          const message = error instanceof Error ? error.message : 'unknown';
          throw new Error(
            `document status ${lastDocumentStatus ?? 'none'}; ${editor ? `editor revision ${editor.slice(-12)} expected ${expectedRevision.slice(-12)}` : 'editor missing after reconnect'}; ${message}`,
          );
        }
        return {
          startedEpochMs,
          observation: settledObservation,
        };
      },
      close: async () => {
        documentGate.close();
        continueResume();
        if (page !== retainedPage) await page.close();
      },
    };
  }

  const ownedContexts = [];
  const createOwnedContext = async () => {
    const context = await authenticatedContext(browser, auth);
    ownedContexts.push(context);
    return context;
  };
  let retainedEntries;
  let fallbackEntries;
  try {
    retainedEntries = [];
    for (
      let offset = 0;
      offset < totalIterations;
      offset += RECONNECT_POOL_BATCH_SIZE
    ) {
      const batch = await Promise.all(
        Array.from(
          {
            length: Math.min(
              RECONNECT_POOL_BATCH_SIZE,
              totalIterations - offset,
            ),
          },
          async (_, index) => {
            const clientIndex = offset + index;
            const context =
              clientIndex === 0 ? retainedContext : await createOwnedContext();
            return {
              context,
              closed: false,
              client: await reconnectStage(`RETAINED_POOL_${clientIndex}`, () =>
                initializeClient(
                  context,
                  clientIndex === 0 ? retainedPage : undefined,
                ),
              ),
            };
          },
        ),
      );
      await Promise.all(
        batch.map(async (entry) => {
          await entry.client.abort();
          await entry.context.setOffline(true);
        }),
      );
      retainedEntries.push(...batch);
    }
    fallbackEntries = [];
    for (
      let offset = 0;
      offset < totalIterations;
      offset += RECONNECT_POOL_BATCH_SIZE
    ) {
      const batch = await Promise.all(
        Array.from(
          {
            length: Math.min(
              RECONNECT_POOL_BATCH_SIZE,
              totalIterations - offset,
            ),
          },
          async (_, index) => {
            const context = await createOwnedContext();
            return {
              context,
              closed: false,
              client: await reconnectStage(
                `FALLBACK_POOL_${offset + index}`,
                () => initializeClient(context),
              ),
            };
          },
        ),
      );
      await Promise.all(
        batch.map(async (entry) => {
          await entry.client.abort();
          await entry.context.setOffline(true);
        }),
      );
      fallbackEntries.push(...batch);
    }
  } catch (error) {
    await Promise.allSettled(ownedContexts.map((context) => context.close()));
    throw error;
  }
  const retainedClients = retainedEntries.map((entry) => entry.client);
  const fallbackClients = fallbackEntries.map((entry) => entry.client);
  const checkpoints = new Set(
    [...retainedClients, ...fallbackClients].map((client) => client.checkpoint),
  );
  if (checkpoints.size !== 1) {
    await Promise.allSettled(ownedContexts.map((context) => context.close()));
    throw new Error('Reconnect clients do not share one base checkpoint');
  }
  const [baseRevision] = checkpoints;
  let receipts;
  let preparePromise;

  async function prepareReceipts() {
    const retainedSeed = await reconnectStage('RETAINED_SEED', () =>
      controlCommand(controlSocket, {
        command: 'seed-performance-operations',
        taskId: retainedTaskId,
        count: operationCount,
      }),
    );
    if (
      retainedSeed?.kind !== 'seeded' ||
      retainedSeed.operationCount !== operationCount ||
      retainedSeed.baseRevision !== baseRevision
    )
      throw new Error('Reconnect retained seed receipt is invalid');
    for (const client of retainedClients) client.armDocument('delta');
    const retained = [];
    for (const [index, entry] of retainedEntries.entries()) {
      await reconnectStage(`RETAINED_SET_ONLINE_${index}`, () =>
        entry.context.setOffline(false),
      );
      retained.push(
        await reconnectStage(`RETAINED_SAMPLE_${index}`, () =>
          entry.client.resume(
            'delta',
            retainedSeed.revision,
            retainedSeed.baseRevision,
          ),
        ),
      );
      if (entry.context !== retainedContext) {
        await entry.client.close();
        await entry.context.close();
        entry.closed = true;
      }
    }

    const fallbackBeyond = await reconnectStage('FALLBACK_BEYOND_SEED', () =>
      controlCommand(controlSocket, {
        command: 'seed-performance-operations',
        taskId: retainedTaskId,
        count: 1,
      }),
    );
    if (fallbackBeyond?.kind !== 'seeded')
      throw new Error('Reconnect fallback seed receipt is invalid');
    for (const client of fallbackClients) client.armDocument('gap');
    const fallback = [];
    for (const [index, entry] of fallbackEntries.entries()) {
      await reconnectStage(`FALLBACK_SET_ONLINE_${index}`, () =>
        entry.context.setOffline(false),
      );
      fallback.push(
        await reconnectStage(`FALLBACK_SAMPLE_${index}`, () =>
          entry.client.resume(
            'gap',
            fallbackBeyond.revision,
            retainedSeed.baseRevision,
          ),
        ),
      );
      await entry.client.close();
      await entry.context.close();
      entry.closed = true;
    }
    receipts = retained.map((retainedReceipt, index) => ({
      kind: 'reconnect-observed',
      operationCount,
      baseRevision: retainedSeed.baseRevision,
      revision: retainedSeed.revision,
      fallbackRevision: fallbackBeyond.revision,
      retainedStartedEpochMs: retainedReceipt.startedEpochMs,
      retained: retainedReceipt.observation,
      fallbackStartedEpochMs: fallback[index].startedEpochMs,
      fallback: fallback[index].observation,
    }));
  }
  return {
    run: async (iteration) => {
      if (
        !Number.isSafeInteger(iteration) ||
        iteration < 0 ||
        iteration >= totalIterations
      )
        throw new Error('Reconnect sample iteration is invalid');
      preparePromise ??= prepareReceipts();
      await preparePromise;
      return receipts[iteration];
    },
    close: async () => {
      await Promise.all(
        [...retainedEntries, ...fallbackEntries]
          .filter((entry) => !entry.closed)
          .map((entry) => entry.client.close()),
      );
      await Promise.all(
        fallbackEntries
          .filter((entry) => !entry.closed)
          .map((entry) => entry.context.close()),
      );
      await Promise.all(
        retainedEntries
          .filter((entry) => !entry.closed && entry.context !== retainedContext)
          .map((entry) => entry.context.close()),
      );
    },
  };
}

async function reconnectStage(name, work) {
  try {
    return await work();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    throw new Error(`Reconnect stage ${name} failed: ${message.slice(0, 160)}`);
  }
}

export function reconnectRequestFence() {
  const queued = [];
  const waiters = [];
  return {
    observe(value) {
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queued.push(value);
    },
    next(expected) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Reconnect request boundary timed out')),
          30_000,
        );
        const settle = (value) => {
          clearTimeout(timer);
          if (typeof value !== 'string' || value.length === 0)
            reject(new Error('Reconnect request is missing Last-Event-ID'));
          else if (value !== expected)
            reject(new Error('Reconnect request identity changed'));
          else resolve();
        };
        if (queued.length) settle(queued.shift());
        else waiters.push(settle);
      });
    },
  };
}

function reconnectAbortFence() {
  const queued = [];
  const waiters = [];
  return {
    observe(lastEventId) {
      const waiter = waiters.shift();
      if (waiter) waiter(lastEventId);
      else queued.push(lastEventId);
    },
    next(expected) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Reconnect old stream was not aborted')),
          30_000,
        );
        const settle = (lastEventId) => {
          clearTimeout(timer);
          if (lastEventId !== expected)
            reject(new Error('Reconnect active stream cursor changed'));
          else resolve();
        };
        if (queued.length) {
          settle(queued.shift());
        } else waiters.push(settle);
      });
    },
  };
}

export function reconnectDocumentGate(taskId) {
  let expected;
  let promise = Promise.resolve();
  let release;
  return {
    arm(strategy) {
      expected = strategy;
      promise = new Promise((resolve) => {
        release = resolve;
      });
    },
    release(input) {
      if (
        !input ||
        input.taskId !== taskId ||
        input.strategy !== expected ||
        !release
      )
        throw new Error('Reconnect document release identity changed');
      expected = undefined;
      const current = release;
      release = undefined;
      current();
    },
    wait() {
      return promise;
    },
    close() {
      release?.();
      release = undefined;
      expected = undefined;
    },
  };
}

async function bridgeReady(page) {
  try {
    await page.waitForFunction(
      ({ globalName, version }) =>
        window[globalName]?.version === version &&
        typeof window[globalName]?.observeReconnect === 'function' &&
        typeof window[globalName]?.restartStream === 'function',
      {
        globalName: PRODUCTION_BRIDGE_GLOBAL,
        version: PRODUCTION_BRIDGE_VERSION,
      },
      { timeout: 30_000 },
    );
  } catch {
    throw new Error('Reconnect product bridge readiness failed');
  }
}

async function reconnectCheckpoint(page) {
  try {
    const handle = await page.waitForFunction(
      (globalName) => window[globalName]?.reconnectCheckpoint?.(),
      PRODUCTION_BRIDGE_GLOBAL,
      { timeout: 30_000 },
    );
    return handle.jsonValue();
  } catch {
    throw new Error('Reconnect initial checkpoint is unavailable');
  }
}

function validDriverIteration(value) {
  // The 200-pin fixture drives a keyboard and pointer action per iteration.
  return Number.isSafeInteger(value) && value >= 0 && value <= 209;
}

async function epoch(page) {
  return page.evaluate(() => performance.timeOrigin + performance.now());
}

async function clickWhenEnabled(page, name) {
  const button = page.getByRole('button', { name });
  await button.waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(
    (label) =>
      [...document.querySelectorAll('button')].some(
        (candidate) =>
          candidate.textContent?.trim() === label && !candidate.disabled,
      ),
    name,
    { timeout: 15_000 },
  );
  await button.click();
}

async function clickLiveCommand(page, name) {
  const command = {
    'Leave room': 'depart',
    'Join room': 'join',
    'Announce work': 'announce',
  }[name];
  if (!command) throw new Error('live command label is invalid');
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith('/room/live') &&
      liveCommandRequestMatches(candidate.request(), command),
  );
  await clickWhenEnabled(page, name);
  const settled = await response;
  const body = await settled.json();
  if (
    settled.status() !== 200 ||
    body?.success !== true ||
    body?.data?.kind !== 'available'
  )
    throw new Error(
      `Live command ${name} status ${settled.status()} outcome ${closedLiveOutcome(body?.data?.result?.outcome)}`,
    );
}

function closedLiveOutcome(value) {
  const outcome = typeof value === 'string' ? value.toUpperCase() : 'UNKNOWN';
  return [
    'DEPARTED',
    'JOINED',
    'UPDATED',
    'REFRESHED',
    'DEGRADED',
    'REFUSED',
    'UNAVAILABLE',
  ].includes(outcome)
    ? outcome
    : 'UNKNOWN';
}

export function liveCommandRequestMatches(request, expectedCommand) {
  try {
    const body = JSON.parse(request.postData() ?? '');
    return body?.command === expectedCommand;
  } catch {
    return false;
  }
}

async function publishPeerPresence(peer, owner, iteration, target, taskId) {
  const stage = async (name, work) => {
    try {
      return await work();
    } catch (error) {
      const diagnostic = closedLiveCommandDiagnostic(error);
      throw new Error(
        `Collaboration presence ${name} failed${diagnostic ? `: ${diagnostic}` : ''}`,
      );
    }
  };
  if (new URL(peer.url()).pathname !== `/tasks/${encodeURIComponent(taskId)}`) {
    await stage('navigation', () =>
      peer.goto(target, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      }),
    );
    if (!(await authenticatedTaskAvailable(peer, taskId)))
      throw new Error('peer Task context is unavailable');
  }
  const peerActorId = await stage('identity', () => peerActorIdentity(peer));
  if (!peerActorId) throw new Error('peer actor identity is unavailable');
  const leave = peer.getByRole('button', { name: 'Leave room' });
  if (await leave.isEnabled()) {
    await stage('leave', () => clickLiveCommand(peer, 'Leave room'));
    await stage('owner-absence', () =>
      owner
        .locator(`[data-actor-id="${peerActorId}"]`)
        .waitFor({ state: 'detached', timeout: 15_000 }),
    );
  }
  await stage('join', () => clickLiveCommand(peer, 'Join room'));
  const ingressStartedEpochMs = await epoch(peer);
  // Fence the authoritative peer publish before the command that can make the
  // owner's SSE/layout commit observable. Recording this after the awaited
  // command response races a legitimate faster owner commit.
  const sentEpochMs = await epoch(peer);
  await stage('announce', () => clickLiveCommand(peer, 'Announce work'));
  return {
    kind: 'presence-published',
    peerActorId,
    ingressStartedEpochMs,
    sentEpochMs,
    iteration,
  };
}

export async function peerActorIdentity(page) {
  const handle = await page.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      const value = element?.getAttribute('data-viewer-actor-id');
      const style = element ? getComputedStyle(element) : undefined;
      return (
        element &&
        element.getClientRects().length > 0 &&
        style?.display !== 'none' &&
        style?.visibility !== 'hidden' &&
        typeof value === 'string' &&
        value.length > 0 &&
        value
      );
    },
    '[data-station-performance-surface="task-room-presence"]',
    { timeout: 30_000 },
  );
  try {
    const actorId = await handle.jsonValue();
    if (typeof actorId !== 'string' || actorId.length === 0)
      throw new Error('peer actor identity is unavailable');
    return actorId;
  } finally {
    await handle.dispose();
  }
}

export function closedLiveCommandDiagnostic(error) {
  const message = error instanceof Error ? error.message : '';
  return /^Live command (Leave room|Join room|Announce work) status [1-5][0-9][0-9] outcome (DEPARTED|JOINED|UPDATED|REFRESHED|DEGRADED|REFUSED|UNAVAILABLE|UNKNOWN)$/.test(
    message,
  )
    ? message
    : undefined;
}

async function publishPeerCursor(peer, owner, taskId, iteration) {
  const editor = peer.getByRole('textbox', { name: 'Task document' });
  let workingRevision = await editor.getAttribute(
    'data-station-working-revision',
  );
  if (!workingRevision) throw new Error('peer working revision is unavailable');
  let length = await editor.evaluate((element) => element.value.length);
  if (length === 0) {
    // Fixture setup, outside the measured cursor sample: a real non-empty
    // document lets every bounded nonce select a distinct shipped cursor
    // state. The nonce itself never carries document content.
    await editor.fill('performance cursor reference');
    await clickWhenEnabled(peer, 'Save shared document');
    await peer.waitForFunction(
      ({ previousRevision }) => {
        const current = document.querySelector(
          'textarea[data-station-performance-surface="task-editor"]',
        )?.dataset.stationWorkingRevision;
        return !!current && current !== previousRevision;
      },
      { previousRevision: workingRevision },
      { timeout: 15_000 },
    );
    workingRevision = await editor.getAttribute(
      'data-station-working-revision',
    );
    length = await editor.evaluate((element) => element.value.length);
  }
  if (!workingRevision) throw new Error('peer working revision is unavailable');
  if (length === 0) throw new Error('peer working document is too short');
  // These are real browser selection gestures, not a synthetic DOM event.
  // Alternating selection/caret makes adjacent samples distinguishable even
  // when the server coalesces equal cursor payloads.
  const selection =
    iteration % 2 === 0
      ? { anchor: 0, focus: length }
      : { anchor: length, focus: length };
  const peerActorId = await peer
    .locator('[data-station-performance-surface="task-room-presence"]')
    .getAttribute('data-viewer-actor-id');
  if (!peerActorId) throw new Error('peer actor identity is unavailable');
  const sampleNonce = `cursor-${randomUUID().replaceAll('-', '')}`;
  await owner.evaluate(
    ({ taskId, actorId, workingRevision, anchor, focus, nonce }) =>
      window.dispatchEvent(
        new CustomEvent('station:performance:remote-cursor-nonce', {
          detail: { taskId, actorId, workingRevision, anchor, focus, nonce },
        }),
      ),
    {
      taskId,
      actorId: peerActorId,
      workingRevision,
      ...selection,
      nonce: sampleNonce,
    },
  );
  const startedEpochMs = await epoch(peer);
  const response = peer.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith('/room/live') &&
      liveCommandRequestMatches(candidate.request(), 'cursor'),
  );
  await editor.click();
  await editor.press('ControlOrMeta+A');
  if (iteration % 2 !== 0) await editor.press('ArrowRight');
  const settled = await response;
  const body = await settled.json();
  if (
    settled.status() !== 200 ||
    body?.success !== true ||
    body?.data?.kind !== 'available'
  )
    throw new Error(`Cursor command status ${settled.status()}`);
  return {
    kind: 'cursor-published',
    peerActorId,
    workingRevision,
    anchor: selection.anchor,
    focus: selection.focus,
    startedEpochMs,
    sampleNonce,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const configIndex = process.argv.indexOf('--config');
  const configPath =
    configIndex >= 0
      ? process.argv[configIndex + 1]
      : 'scripts/fixtures/interactive-workspace/performance-contract.json';
  try {
    process.stdout.write(
      `${JSON.stringify(await measure(readJson(configPath), process.cwd()))}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(
        unavailable(
          readJson(configPath),
          'REAL_STATION_BROWSER_ADAPTER_ERROR',
          {
            adapterError:
              error instanceof Error ? error.message : String(error),
          },
        ),
      )}\n`,
    );
  }
}
