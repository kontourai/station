import { Agent, request as httpsRequest } from 'node:https';
import { checkServerIdentity, rootCertificates } from 'node:tls';
import { satisfies, valid, validRange } from 'semver';
import { collectPnpmAudits } from './pnpm-advisory.mjs';
import { readPnpmDependencyGraph } from './pnpm-dependency-graph.mjs';

const REGISTRY = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const MAX_BYTES = 50 * 1024 * 1024;

async function queryRegistry(packages, request) {
  const body = JSON.stringify(packages);
  // No project/user npmrc, pnpm flags, proxy environment or custom CA controls.
  const agent = new Agent({ ca: rootCertificates, rejectUnauthorized: true });
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        REGISTRY,
        {
          method: 'POST',
          agent,
          ca: rootCertificates,
          rejectUnauthorized: true,
          checkServerIdentity,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'accept-encoding': 'identity',
          },
          signal: AbortSignal.timeout(240_000),
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(
              new Error(
                `Release advisory registry HTTP ${response.statusCode}`,
              ),
            );
            return;
          }
          let size = 0;
          const chunks = [];
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BYTES)
              response.destroy(
                new Error(
                  'Release advisory registry response exceeds byte limit',
                ),
              );
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              resolve(
                JSON.parse(
                  new TextDecoder('utf-8', { fatal: true }).decode(
                    Buffer.concat(chunks),
                  ),
                ),
              );
            } catch {
              reject(
                new Error(
                  'Release advisory registry response is not valid JSON/UTF-8',
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    agent.destroy();
  }
}

/** Audit every locked dependency class, independently of candidate package-manager settings. */
export async function collectReleaseAudits(
  scopes,
  { root, request = httpsRequest },
) {
  const graph = readPnpmDependencyGraph(root);
  const packages = new Map();
  for (const id of graph.workspaceClosure(false)) {
    const node = graph.nodes.get(id);
    if (node.importer) continue;
    if (!valid(node.version))
      throw new Error('Unsupported locked advisory version');
    if (!packages.has(node.name)) packages.set(node.name, new Set());
    packages.get(node.name).add(node.version);
  }
  if (!packages.size)
    throw new Error('Release advisory graph contains no registry packages');
  const payload = Object.fromEntries(
    [...packages]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, versions]) => [name, [...versions].sort()]),
  );
  const bulk = await queryRegistry(payload, request);
  if (!bulk || typeof bulk !== 'object' || Array.isArray(bulk))
    throw new Error('Malformed release advisory bulk response');
  const advisories = Object.create(null);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, entries] of Object.entries(bulk)) {
    if (!packages.has(name) || !Array.isArray(entries))
      throw new Error('Unexpected release advisory package');
    for (const entry of entries) {
      const ghsa =
        /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/i.exec(
          entry?.url ?? '',
        )?.[1];
      if (
        !ghsa ||
        !Object.hasOwn(counts, entry.severity) ||
        !validRange(entry.vulnerable_versions)
      )
        throw new Error(
          'Malformed release advisory identity, severity or range',
        );
      const identity = `${name}:${ghsa}`;
      if (Object.hasOwn(advisories, identity))
        throw new Error('Duplicate release advisory identity');
      const versions = [...packages.get(name)].filter((version) =>
        satisfies(version, entry.vulnerable_versions, {
          includePrerelease: true,
        }),
      );
      if (!versions.length)
        throw new Error('Release advisory matches no requested locked version');
      advisories[identity] = {
        module_name: name,
        github_advisory_id: ghsa,
        severity: entry.severity,
        title: typeof entry.title === 'string' ? entry.title : '',
        findings: versions.map((version) => ({ version, paths: [name] })),
      };
      counts[entry.severity]++;
    }
  }
  return collectPnpmAudits(scopes, {
    root,
    graph,
    run: async () => ({ advisories, metadata: { vulnerabilities: counts } }),
  });
}
