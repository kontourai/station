import { cpus, loadavg, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createPolicySet } from '../services/policy/cedar-evaluator.js';

// Standalone packaged-server qualification entry. No listener or Station home.
const start = performance.now();
const memoryBefore = process.memoryUsage();
const policies = Object.fromEntries(
  Array.from({ length: 16 }, (_, i) => [
    `read${i}`,
    `permit(principal, action == Action::"read", resource) when { resource.level == ${i} && context.ticket != "" };`,
  ]),
);
const prepared = await createPolicySet({
  schema:
    'entity User; entity File { level: Long }; action "read" appliesTo { principal: User, resource: File, context: { ticket: String } };',
  policies,
});
if (!prepared.ok)
  throw new Error(
    `Cedar probe initialization refused: ${JSON.stringify(prepared.errors)}`,
  );
const initializationMs = performance.now() - start;
const request = {
  principal: { type: 'User', id: 'probe' },
  action: { type: 'Action', id: 'read' },
  resource: { type: 'File', id: 'file1' },
  context: { ticket: 'bounded-probe' },
  entities: [
    { uid: { type: 'User', id: 'probe' }, attrs: {}, parents: [] },
    ...Array.from({ length: 127 }, (_, i) => ({
      uid: { type: 'File', id: `file${i}` },
      attrs: { level: i % 16 },
      parents: [],
    })),
  ],
};
const samples: number[] = [];
for (let i = 0; i < 200; i++) {
  const before = performance.now();
  const result = prepared.policySet.evaluate(request);
  if (
    result.decision !== 'allow' ||
    result.errors.length ||
    result.determiningPolicyIds.join() !== 'read1'
  )
    throw new Error('Cedar packaged permit probe failed');
  samples.push(performance.now() - before);
}
if (
  prepared.policySet.evaluate({ ...request, entities: [] }).decision !== 'deny'
)
  throw new Error('Cedar packaged missing-fact probe failed');
samples.sort((a, b) => a - b);
process.stdout.write(
  `${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, loadAverage: loadavg(), policies: 16, entities: request.entities.length, requestBytes: Buffer.byteLength(JSON.stringify(request)), initializationMs, iterations: samples.length, warmMedianMs: samples[100], warmP95Ms: samples[190], memoryBefore, memoryAfter: process.memoryUsage(), policyRevision: prepared.policySet.policyRevision })}\n`,
);
