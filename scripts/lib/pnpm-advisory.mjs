import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pnpmInvocation } from '../dependency-lifecycle.mjs';
import { createPnpmAuditAttemptDiagnostics } from './dependency-audit-diagnostics.mjs';
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

const AUDIT_TIMEOUT_MS = 240_000;

export async function runPnpmAudit(
  root,
  {
    attempt = 1,
    diagnosticsRoot = join(
      root,
      '.kontourai/verification-output/dependency-audit',
    ),
  } = {},
) {
  const diagnostics = createPnpmAuditAttemptDiagnostics({
    attempt,
    outputRoot: diagnosticsRoot,
    timeoutMs: AUDIT_TIMEOUT_MS,
  });
  const failurePhases = [];
  const failures = [];
  const recordFailure = (phase, error) => {
    failurePhases.push(phase);
    failures.push(error);
  };
  let completion;
  try {
    const invocation = pnpmInvocation({ cwd: root });
    diagnostics.enter('launch');
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
    const processResult = execution.completion.then((result) => {
      completion = result;
      return result;
    });
    let capture;
    let timer;
    let boundaryFailure;
    diagnostics.enter('process');
    try {
      let rejectBoundary;
      const boundary = new Promise((_, reject) => {
        rejectBoundary = reject;
      });
      capture = captureOwnedProcessOutput(execution, {
        maxBytes: 50 * 1024 * 1024,
        onOverflow: () => {
          boundaryFailure ??= 'output';
          rejectBoundary(new Error('pnpm audit output exceeded its bound'));
        },
      });
      timer = setTimeout(() => {
        boundaryFailure ??= 'deadline';
        rejectBoundary(new Error('pnpm audit exceeded its 240000ms deadline'));
      }, AUDIT_TIMEOUT_MS);
      const result = await Promise.race([processResult, boundary]);
      if (result.error || result.signal || ![0, 1].includes(result.status))
        recordFailure(
          result.error ? 'launch' : 'process',
          new Error(
            `pnpm audit operational failure: ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}`,
            { cause: result.error },
          ),
        );
    } catch (error) {
      recordFailure(boundaryFailure ?? (capture ? 'process' : 'output'), error);
    } finally {
      clearTimeout(timer);
      diagnostics.enter('cleanup');
      try {
        const retired = await terminateSuiteExecution(execution, {
          waitForSuiteSettlement,
          terminationGraceMs: 5_000,
          terminationForceMs: 5_000,
          processLabel: 'pnpm audit',
        });
        if (!retired.settled || retired.errors.length)
          recordFailure(
            'cleanup',
            new Error('pnpm audit cleanup did not settle its process tree', {
              cause: retired.errors,
            }),
          );
      } catch (error) {
        recordFailure('cleanup', error);
      }
    }
    diagnostics.enter('output');
    const output = capture?.finish();
    if (output?.truncated || output?.invalidUtf8)
      recordFailure(
        'output',
        new Error('pnpm audit returned oversized or invalid UTF-8 output'),
      );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, 'pnpm audit failed');
    diagnostics.enter('decode');
    try {
      return JSON.parse(output.stdout.text);
    } catch {
      throw new Error('pnpm audit did not return valid JSON');
    }
  } catch (error) {
    if (!failurePhases.length) failurePhases.push(diagnostics.currentPhase);
    throw error;
  } finally {
    diagnostics.settle({
      status: completion?.status,
      signal: completion?.signal ?? null,
      failurePhases,
    });
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
