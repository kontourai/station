import { execFile } from 'node:child_process';
import { pnpmInvocation } from '../dependency-lifecycle.mjs';
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

export function runPnpmAudit(root) {
  const invocation = pnpmInvocation({ cwd: root });
  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      [...invocation.args, 'audit', '--json'],
      {
        cwd: root,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error && (error.killed || error.signal || error.code !== 1))
          return reject(
            new Error(`pnpm audit operational failure: ${error.message}`),
          );
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('pnpm audit did not return valid JSON'));
        }
      },
    );
  });
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
