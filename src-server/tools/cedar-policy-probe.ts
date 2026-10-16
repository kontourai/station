import { performance } from 'node:perf_hooks';
import { createPolicySet } from '../services/policy/cedar-evaluator.js';

// Standalone packaged-server qualification entry. No listener or Station home.
const start = performance.now();
const prepared = await createPolicySet({
  schema:
    'entity User; entity File; action "read" appliesTo { principal: User, resource: File, context: {} };',
  policies: { probe: 'permit(principal, action == Action::"read", resource);' },
});
if (!prepared.ok)
  throw new Error(
    `Cedar probe initialization refused: ${JSON.stringify(prepared.errors)}`,
  );
const initializationMs = performance.now() - start;
const request = {
  principal: { type: 'User', id: 'probe' },
  action: { type: 'Action', id: 'read' },
  resource: { type: 'File', id: 'probe' },
  context: {},
  entities: [
    { uid: { type: 'User', id: 'probe' }, attrs: {}, parents: [] },
    { uid: { type: 'File', id: 'probe' }, attrs: {}, parents: [] },
  ],
};
const samples: number[] = [];
for (let i = 0; i < 200; i++) {
  const before = performance.now();
  const result = prepared.policySet.evaluate(request);
  if (
    result.decision !== 'allow' ||
    result.errors.length ||
    result.determiningPolicyIds.join() !== 'probe'
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
  `${JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, initializationMs, iterations: samples.length, warmMedianMs: samples[100], warmP95Ms: samples[190], memory: process.memoryUsage(), policyRevision: prepared.policySet.policyRevision })}\n`,
);
