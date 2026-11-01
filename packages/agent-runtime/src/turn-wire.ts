import { canonical } from './encoding.js';

type Wire = null | boolean | number | string | Wire[];
/** Tagged data prevents a tool's JSON keys from impersonating a Date or BLOB. */
export function agentWire(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): Wire => {
    if (depth > 64) throw new Error('DURABLE_AGENT_VALUE_TOO_DEEP');
    if (item === undefined) return ['undefined'];
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return item;
    if (typeof item === 'number' && Number.isFinite(item))
      return ['number', Object.is(item, -0) ? '-0' : String(item)];
    if (!item || typeof item !== 'object' || seen.has(item))
      throw new Error('DURABLE_AGENT_VALUE_UNSUPPORTED');
    if (item instanceof Uint8Array)
      return ['bytes', Buffer.from(item).toString('base64')];
    if (item instanceof Date && Number.isFinite(item.getTime()))
      return ['date', item.toISOString()];
    seen.add(item);
    try {
      if (Array.isArray(item))
        return ['array', ...item.map((child) => visit(child, depth + 1))];
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item)))
        throw new Error('DURABLE_AGENT_VALUE_UNSUPPORTED');
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (
        Reflect.ownKeys(item).some((k) => typeof k !== 'string') ||
        Object.values(descriptors).some((d) => !('value' in d) || !d.enumerable)
      )
        throw new Error('DURABLE_AGENT_VALUE_UNSUPPORTED');
      return [
        'object',
        ...Object.keys(descriptors)
          .sort()
          .map((key) => [key, visit(descriptors[key]!.value, depth + 1)]),
      ];
    } finally {
      seen.delete(item);
    }
  };
  return canonical(visit(value, 0));
}
export function readAgentWire(value: string): unknown {
  const visit = (node: Wire): unknown => {
    if (!Array.isArray(node)) return node;
    const [kind, ...parts] = node;
    if (kind === 'undefined' && parts.length === 0) return undefined;
    if (
      kind === 'number' &&
      parts.length === 1 &&
      typeof parts[0] === 'string' &&
      Number.isFinite(Number(parts[0]))
    )
      return Number(parts[0]);
    if (kind === 'bytes' && parts.length === 1 && typeof parts[0] === 'string')
      return new Uint8Array(Buffer.from(parts[0], 'base64'));
    if (kind === 'date' && parts.length === 1 && typeof parts[0] === 'string')
      return new Date(parts[0]);
    if (kind === 'array') return parts.map(visit);
    if (kind === 'object')
      return Object.fromEntries(
        parts.map((pair) => {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== 'string'
          )
            throw new Error('DURABLE_AGENT_VALUE_DAMAGED');
          return [pair[0], visit(pair[1]!)];
        }),
      );
    throw new Error('DURABLE_AGENT_VALUE_DAMAGED');
  };
  const result = visit(JSON.parse(value));
  if (agentWire(result) !== value)
    throw new Error('DURABLE_AGENT_VALUE_DAMAGED');
  return result;
}
