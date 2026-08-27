export const SOURCE = 'stage:source';
export const HIGHER = Object.freeze(['stage:preview', 'stage:stable']);
const STAGES = Object.freeze([SOURCE, ...HIGHER]);

const names = (labels = []) =>
  new Set(labels.map((x) => (typeof x === 'string' ? x : x.name)));

/** Source projection is monotonic: delivery evidence never downgrades preview/stable. */
export function reduceIssueAvailability(labels) {
  const current = names(labels);
  const present = STAGES.filter((label) => current.has(label));
  if (present.length > 1) return { kind: 'conflict', add: [], remove: [] };
  if (HIGHER.some((label) => current.has(label)) || current.has(SOURCE))
    return { kind: 'unchanged', add: [], remove: [] };
  return { kind: 'source', add: [SOURCE], remove: [] };
}

/** Delivery projection is monotonic and only admits a verified higher stage. */
export function reduceDeliveryAvailability(labels, stage) {
  if (!HIGHER.includes(stage)) return { kind: 'ignored', add: [], remove: [] };
  const current = names(labels);
  const present = STAGES.filter((label) => current.has(label));
  if (present.length > 1) return { kind: 'conflict', add: [], remove: [] };
  if (current.has('stage:stable'))
    return { kind: 'unchanged', add: [], remove: [] };
  if (stage === 'stage:preview' && current.has('stage:preview'))
    return { kind: 'unchanged', add: [], remove: [] };
  return {
    kind: stage === 'stage:stable' ? 'stable' : 'preview',
    add: [stage],
    remove:
      stage === 'stage:stable'
        ? [SOURCE, 'stage:preview'].filter((label) => current.has(label))
        : [SOURCE].filter((label) => current.has(label)),
  };
}
