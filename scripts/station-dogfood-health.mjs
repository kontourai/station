#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

function readInstanceRecord(file, { allowWildcardHost = false } = {}) {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile())
      throw new Error('instance state must be a regular file');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw new Error('instance state must be owned by the current user');
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error('instance state permissions must be 0600');
    }
    const record = JSON.parse(readFileSync(fd, 'utf8'));
    const allowedHost = allowWildcardHost ? '0.0.0.0' : '127.0.0.1';
    if (
      !record.instanceId ||
      !record.bootId ||
      !record.build?.sha ||
      !Number.isInteger(record.serverPid) ||
      record.serverPid < 1 ||
      record.serverFingerprint?.pid !== record.serverPid ||
      typeof record.serverFingerprint?.startToken !== 'string' ||
      record.serverFingerprint.startToken.length === 0 ||
      !/^[a-f0-9]{64}$/.test(record.serverFingerprint?.commandDigest ?? '') ||
      !Number.isInteger(record.uiPid) ||
      record.uiPid < 1 ||
      record.uiFingerprint?.pid !== record.uiPid ||
      typeof record.uiFingerprint?.startToken !== 'string' ||
      record.uiFingerprint.startToken.length === 0 ||
      !/^[a-f0-9]{64}$/.test(record.uiFingerprint?.commandDigest ?? '') ||
      record.host !== allowedHost
    ) {
      throw new Error('instance state lacks managed boot identity');
    }
    return record;
  } finally {
    closeSync(fd);
  }
}

function remainingMs(deadline) {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error('probe deadline exceeded');
  return remaining;
}

export function inspectProcessFingerprints(
  pids,
  deadline,
  runSync = execFileSync,
) {
  try {
    const output = runSync(
      'ps',
      [
        '-o',
        'pid=',
        '-o',
        'lstart=',
        '-o',
        'command=',
        '-p',
        [...new Set(pids)].join(','),
      ],
      {
        encoding: 'utf8',
        // lstart is locale- and TZ-shaped; pin both so the fixed-width
        // parse below is safe and tokens are env-independent (#3049).
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: remainingMs(deadline),
        windowsHide: true,
      },
    ).trim();
    const fingerprints = new Map();
    for (const line of output.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      fingerprints.set(pid, {
        pid,
        startToken: match[2].trim(),
        commandDigest: createHash('sha256')
          .update(match[3].trim())
          .digest('hex'),
      });
    }
    return fingerprints;
  } catch {
    return new Map();
  }
}

function assertProcessOwnership(record, deadline) {
  const expected = [
    [record.serverPid, record.serverFingerprint, 'server'],
    [record.uiPid, record.uiFingerprint, 'ui'],
  ];
  const actualByPid = inspectProcessFingerprints(
    expected.map(([pid]) => pid),
    deadline,
  );
  for (const [pid, fingerprint, label] of expected) {
    const actual = actualByPid.get(pid);
    if (!processFingerprintMatches(actual, fingerprint)) {
      throw new Error(`${label} process fingerprint mismatch`);
    }
  }
}

function boundedProbeReason(tool, error) {
  const code = typeof error?.code === 'string' ? ` ${error.code}` : '';
  const message = String(error?.message ?? error ?? 'unknown failure')
    .replace(/\s+/g, ' ')
    .slice(0, 160);
  return `${tool}${code}: ${message}`.slice(0, 200);
}

/**
 * Observe listener ownership without conflating a missing host probe with an
 * empty listener set.  Callers that need only the historic Map contract can
 * use listeningPidsByPort; health reporting uses the source/reason envelope.
 */
export function observeListeningPidsByPort(
  ports,
  deadline,
  runSync = execFileSync,
) {
  const uniquePorts = [...new Set(ports)];
  const emptyOwners = () => new Map(ports.map((port) => [port, new Set()]));
  const failures = [];
  /** Records from a non-authoritative lsof run, kept only to name ports. */
  let lsofPartialOwners;
  try {
    const output = runSync(
      'lsof',
      [
        '-nP',
        ...uniquePorts.map((port) => `-iTCP:${port}`),
        '-sTCP:LISTEN',
        '-Fpn',
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: remainingMs(deadline),
        windowsHide: true,
      },
    );
    const owners = parseLsofOwners(output, ports);
    if (hasOwnersForAllPorts(owners, uniquePorts)) {
      return { owners, source: 'lsof', reason: undefined, authoritative: true };
    }
    lsofPartialOwners = owners;
    failures.push('lsof: incomplete listener ownership');
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') throw new Error('probe deadline exceeded');
    // lsof exits 1 when ANY requested port has no match, and it still writes
    // the ports it DID find to stdout (station#3754, verified directly:
    // querying one listening port plus one free port exits 1 with the
    // listening port present in the output). Discarding that output made
    // every genuinely missing listener read as "no listeners anywhere", so
    // `assertListenerOwnership` blamed whichever port it checks FIRST: a
    // Station whose consent listener was down reported "api listener
    // ownership mismatch" while the api was serving fine.
    //
    // So keep those records — but only as DIAGNOSTICS. Exit 1 means "any
    // error was detected" (lsof(8)), not specifically "a selector matched
    // nothing", and stderr is discarded here, so a permission-limited
    // listing that happens to contain every expected pid is
    // indistinguishable from a complete one. Trusting it would let an
    // unobserved co-owner read as exclusive ownership — uncertainty
    // reported as health (review round 1, BLOCKING). Corroborate with `ss`
    // below; if that fails too, the caller fails closed with these ports as
    // context for WHICH listener looked absent.
    if (error?.status === 1) {
      lsofPartialOwners = parseLsofOwners(
        typeof error.stdout === 'string' ? error.stdout : '',
        ports,
      );
      failures.push('lsof: incomplete observation (exit 1)');
    } else {
      failures.push(boundedProbeReason('lsof', error));
    }
  }
  try {
    const output = runSync('ss', ['-H', '-ltnp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: remainingMs(deadline),
      windowsHide: true,
    });
    return {
      owners: parseSsOwners(output, ports),
      source: 'ss',
      reason:
        failures.length === 0 ? undefined : failures.join('; ').slice(0, 240),
      authoritative: true,
    };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') throw new Error('probe deadline exceeded');
    failures.push(boundedProbeReason('ss', error));
    // No tool produced an observation this function will vouch for. Any lsof
    // records ride along ONLY so the caller can say which listener looked
    // absent; `authoritative: false` is what stops them counting as proof.
    return {
      owners: lsofPartialOwners ?? emptyOwners(),
      source: lsofPartialOwners ? 'lsof' : 'none',
      reason: failures.join('; ').slice(0, 240),
      authoritative: false,
    };
  }
}

export function listeningPidsByPort(ports, deadline, runSync = execFileSync) {
  return observeListeningPidsByPort(ports, deadline, runSync).owners;
}

function parseLsofOwners(output, ports) {
  const owners = new Map(ports.map((port) => [port, new Set()]));
  let currentPid;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      // A process record must be exactly `p<digits>`. `parseInt` accepted
      // `p41garbage` as 41, and a malformed record boundary would then
      // attribute the NEXT process's sockets to this pid — unsafe now that
      // failure-path output is parsed at all (station#3754 review).
      const match = /^p(\d+)$/.exec(line);
      currentPid = match ? Number.parseInt(match[1], 10) : undefined;
      continue;
    }
    if (!line.startsWith('n') || !Number.isInteger(currentPid)) continue;
    const port = Number.parseInt(line.match(/:(\d+)$/)?.[1] ?? '', 10);
    owners.get(port)?.add(currentPid);
  }
  return owners;
}

function parseSsOwners(output, ports) {
  const owners = new Map(ports.map((port) => [port, new Set()]));
  for (const line of output.split('\n')) {
    const localPort = Number.parseInt(
      line.match(/\s(?:\[?[0-9a-fA-F:.%*]+\]?):(\d+)\s/)?.[1] ?? '',
      10,
    );
    const portOwners = owners.get(localPort);
    if (!portOwners) continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) {
      portOwners.add(Number.parseInt(match[1], 10));
    }
  }
  return owners;
}

function hasOwnersForAllPorts(owners, ports) {
  return ports.every((port) => (owners.get(port)?.size ?? 0) > 0);
}

/**
 * Exported for the contract test that proves a non-authoritative observation
 * cannot satisfy health even when every expected port looks correctly owned
 * (station#3754 review). Production callers use it through
 * {@link probeDogfoodHealth}.
 */
export function assertListenerOwnership(
  record,
  deadline,
  observe = observeListeningPidsByPort,
) {
  const expected = [
    ['api', record.serverPort, record.serverPid],
    ['terminal', record.serverPort + 1, record.serverPid],
    ['voice', record.serverPort + 2, record.serverPid],
    ['consent', record.serverPort + 3, record.serverPid],
    ['ui', record.uiPort, record.uiPid],
  ];
  const listenerObservation = observe(
    expected.map(([, port]) => port),
    deadline,
  );
  const {
    owners: ownersByPort,
    source,
    reason,
    authoritative = true,
  } = listenerObservation;
  const diagnostic = reason ? `; reason=${reason}` : '';
  for (const [name, port, expectedPid] of expected) {
    const owners = ownersByPort.get(port) ?? new Set();
    if (owners.size !== 1 || !owners.has(expectedPid)) {
      throw new Error(
        `${name} listener ownership mismatch (source=${source}${diagnostic})`,
      );
    }
  }
  // Every expected port looked right — but if no tool vouched for the
  // observation, that agreement proves nothing: a listing that omitted a
  // co-owner looks exactly like exclusive ownership. Fail closed rather than
  // report uncertainty as health (review round 1, BLOCKING).
  if (!authoritative) {
    throw new Error(
      `listener ownership could not be observed (source=${source}${diagnostic})`,
    );
  }
}

function processFingerprintMatches(actual, expectedFingerprint) {
  // Deliberately NO #3049 migration lens here (accepted cost, disclosed on
  // the PR): a record written by a pre-pin `station start` mismatches the
  // pinned probe on a non-UTC host, health reports `process`/`ownership-post`
  // failures, and reconcile restarts the instance — which re-records pinned
  // fingerprints and self-heals. One supervised restart per pre-pin
  // instance beats carrying a third copy of the legacy-lens machinery in a
  // path where a false "unhealthy" is recoverable by design (unlike the
  // stop path, where a false mismatch blocks the stop, or lock liveness,
  // where it reclaims a live holder's lock).
  return (
    actual?.pid === expectedFingerprint.pid &&
    actual?.startToken === expectedFingerprint.startToken &&
    actual?.commandDigest === expectedFingerprint.commandDigest
  );
}

function expected(record) {
  return {
    instanceId: record.instanceId,
    sha: record.build.sha,
    bootId: record.bootId,
  };
}

function matches(actual, identity) {
  return (
    actual?.instanceId === identity.instanceId &&
    (actual?.sha ?? actual?.fullSha) === identity.sha &&
    actual?.bootId === identity.bootId
  );
}

async function fetchIdentity(url, identity, signal) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (!matches(body, identity)) throw new Error('boot identity mismatch');
}

function websocketHealthUpgrade(port, signal) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/__station/health',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    const finish = (error) => {
      request.destroy();
      error ? reject(error) : resolve();
    };
    request.once('upgrade', (_response, socket) => {
      socket.destroy();
      finish();
    });
    request.once('response', (response) => {
      response.resume();
      finish(new Error(`upgrade rejected with HTTP ${response.statusCode}`));
    });
    request.once('error', reject);
    signal.addEventListener(
      'abort',
      () => finish(new Error('probe deadline exceeded')),
      { once: true },
    );
    request.end();
  });
}

export async function probeDogfoodHealth(
  instanceStatePath,
  { timeoutMs = 3000, allowWildcardHost = false } = {},
) {
  const record = readInstanceRecord(instanceStatePath, { allowWildcardHost });
  const identity = expected(record);
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs(deadline));
  const checks = [
    [
      'process',
      () => {
        assertProcessOwnership(record, deadline);
      },
    ],
    ['listeners', () => assertListenerOwnership(record, deadline)],
    [
      'api',
      () =>
        fetchIdentity(
          `http://127.0.0.1:${record.serverPort}/api/system/identity`,
          identity,
          controller.signal,
        ),
    ],
    [
      'terminal',
      () => websocketHealthUpgrade(record.serverPort + 1, controller.signal),
    ],
    [
      'voice',
      () => websocketHealthUpgrade(record.serverPort + 2, controller.signal),
    ],
    [
      'ui',
      () =>
        fetchIdentity(
          `http://127.0.0.1:${record.uiPort}/__station/identity`,
          identity,
          controller.signal,
        ),
    ],
  ];
  try {
    const results = await Promise.all(
      checks.map(async ([name, check]) => {
        try {
          await check();
          return { name, healthy: true };
        } catch (error) {
          return { name, healthy: false, reason: error.message };
        }
      }),
    );
    try {
      assertProcessOwnership(record, deadline);
      assertListenerOwnership(record, deadline);
      results.push({ name: 'ownership-post', healthy: true });
    } catch (error) {
      results.push({
        name: 'ownership-post',
        healthy: false,
        reason: error.message,
      });
    }
    const failedChecks = results
      .filter((result) => !result.healthy)
      .map((result) => result.name);
    return {
      healthy: failedChecks.length === 0,
      identity,
      pid: record.serverPid,
      checks: results,
      failedChecks,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main(argv = process.argv.slice(2)) {
  const stateArg = argv.find((arg) => arg.startsWith('--instance-state='));
  const timeoutArg = argv.find((arg) => arg.startsWith('--timeout-ms='));
  const allowWildcardHost = argv.includes('--allow-wildcard-host');
  if (!stateArg)
    throw new Error(
      'usage: station-dogfood-health.mjs --instance-state=/absolute/path',
    );
  const result = await probeDogfoodHealth(
    stateArg.slice('--instance-state='.length),
    {
      timeoutMs: timeoutArg
        ? Number(timeoutArg.slice('--timeout-ms='.length))
        : 3000,
      allowWildcardHost,
    },
  );
  console.log(JSON.stringify(result));
  if (!result.healthy) process.exitCode = 1;
}

function isMainModule() {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return import.meta.url === pathToFileURL(entrypoint).href;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
