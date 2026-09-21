import { spawn } from 'node:child_process';
import { pnpmInvocation } from '../dependency-lifecycle.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './owned-process.mjs';
import { readPnpmDependencyGraph } from './pnpm-dependency-graph.mjs';

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const IMPORTERS = { root: '.', sdk: 'packages/sdk', shared: 'packages/shared' };

/** One registry response; reachability is derived from the locked graph. */
export function normalizePnpmAudit(raw, graph, importer, productionOnly) {
  if (
    !raw ||
    typeof raw.advisories !== 'object' ||
    Array.isArray(raw.advisories) ||
    !raw.metadata?.vulnerabilities
  )
    throw new Error('Unsupported pnpm audit JSON');
  const rawCounts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const selected =
    importer === '.'
      ? graph.workspaceClosure(productionOnly)
      : graph.closure(importer, productionOnly);
  const candidates = new Map();
  for (const id of selected) {
    const node = graph.nodes.get(id);
    if (node.importer) continue;
    const key = `${node.name}@${node.version}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(id);
  }
  const vulnerabilities = Object.create(null);
  const resolvedVersions = {};
  for (const advisory of Object.values(raw.advisories)) {
    if (
      !advisory ||
      !SEVERITIES.includes(advisory.severity) ||
      typeof advisory.module_name !== 'string' ||
      !advisory.module_name ||
      !/^GHSA-[a-z0-9-]+$/i.test(advisory.github_advisory_id ?? '') ||
      !Array.isArray(advisory.findings) ||
      advisory.findings.length === 0
    )
      throw new Error('Malformed pnpm advisory');
    rawCounts[advisory.severity]++;
    const nodes = [];
    for (const finding of advisory.findings) {
      if (
        typeof finding.version !== 'string' ||
        !finding.version ||
        !Array.isArray(finding.paths) ||
        !finding.paths.length
      )
        throw new Error('Malformed pnpm advisory finding');
      for (const id of candidates.get(
        `${advisory.module_name}@${finding.version}`,
      ) ?? []) {
        nodes.push(id);
        resolvedVersions[id] = finding.version;
      }
    }
    if (!nodes.length) continue;
    vulnerabilities[advisory.module_name] ??= {
      name: advisory.module_name,
      severity: advisory.severity,
      via: [],
      nodes: [],
    };
    const entry = vulnerabilities[advisory.module_name];
    if (
      SEVERITIES.indexOf(advisory.severity) > SEVERITIES.indexOf(entry.severity)
    )
      entry.severity = advisory.severity;
    entry.nodes = [...new Set([...entry.nodes, ...nodes])];
    entry.via.push({
      name: advisory.module_name,
      severity: advisory.severity,
      title: advisory.title,
      url: `https://github.com/advisories/${advisory.github_advisory_id}`,
    });
  }
  for (const severity of SEVERITIES) {
    if (raw.metadata.vulnerabilities[severity] !== rawCounts[severity])
      throw new Error(
        `pnpm audit ${severity} count does not match its advisory records`,
      );
  }
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const v of Object.values(vulnerabilities)) counts[v.severity]++;
  counts.total = Object.keys(vulnerabilities).length;
  return {
    audit: {
      auditReportVersion: 2,
      vulnerabilities,
      metadata: { vulnerabilities: counts },
    },
    resolvedVersions,
  };
}

export async function runPnpmAudit(root) {
  const invocation = pnpmInvocation({ cwd: root });
  const execution = executeOwnedCommand(
    invocation.command,
    [...invocation.args, 'audit', '--json'],
    spawn,
    'pnpm audit',
    {
      cwd: root,
      argv0: invocation.argv0,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let rejectBoundary;
  const boundary = new Promise((_, reject) => {
    rejectBoundary = reject;
  });
  const capture = captureOwnedProcessOutput(execution, {
    maxBytes: 50 * 1024 * 1024,
    onOverflow: () =>
      rejectBoundary(new Error('pnpm audit output exceeded its bound')),
  });
  const timer = setTimeout(
    () =>
      rejectBoundary(new Error('pnpm audit exceeded its 240000ms deadline')),
    240_000,
  );
  let completion;
  const failures = [];
  try {
    completion = await Promise.race([execution.completion, boundary]);
    if (
      completion.error ||
      completion.signal ||
      ![0, 1].includes(completion.status)
    )
      throw new Error(
        `pnpm audit operational failure: ${completion.signal ? `signal ${completion.signal}` : `exit ${completion.status}`}`,
        { cause: completion.error },
      );
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
    try {
      const retired = await terminateSuiteExecution(execution, {
        waitForSuiteSettlement,
        terminationGraceMs: 5_000,
        terminationForceMs: 5_000,
        processLabel: 'pnpm audit',
      });
      if (!retired.settled || retired.errors.length)
        failures.push(
          new Error('pnpm audit cleanup did not settle its process tree', {
            cause: retired.errors,
          }),
        );
    } catch (error) {
      failures.push(error);
    }
  }
  const output = capture.finish();
  if (output.truncated || output.invalidUtf8)
    failures.push(
      new Error('pnpm audit returned oversized or invalid UTF-8 output'),
    );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'pnpm audit failed');
  try {
    return JSON.parse(output.stdout.text);
  } catch {
    throw new Error('pnpm audit did not return valid JSON');
  }
}

export async function collectPnpmAudits(
  scopes,
  { root, run = runPnpmAudit, graph = readPnpmDependencyGraph(root) },
) {
  if (!scopes.length) throw new Error('No pnpm audit scopes selected');
  for (const { scope } of scopes)
    if (!Object.hasOwn(IMPORTERS, scope))
      throw new Error(`Unknown audit scope ${scope}`);
  const raw = await run(root);
  return scopes.flatMap(({ scope }) =>
    ['full', 'production'].map((reachability) => ({
      scope,
      reachability,
      ...normalizePnpmAudit(
        raw,
        graph,
        IMPORTERS[scope],
        reachability === 'production',
      ),
    })),
  );
}
