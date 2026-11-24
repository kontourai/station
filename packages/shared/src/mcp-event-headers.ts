import { isObjectRecord } from './object-record.js';

type Declaration = {
  path: readonly string[];
  name: string;
  type: 'string' | 'integer' | 'boolean';
};

const namedSchemas = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
]);
const positionalSchemas = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const nestedSchemas = new Set([
  'additionalItems',
  'additionalProperties',
  'contains',
  'contentSchema',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

export function describeEventArgumentHeaders(
  schema?: Record<string, unknown>,
): Declaration[] | undefined {
  if (!schema) return [];
  const pending: Array<{ schema: unknown; path: readonly string[] | null }> = [
    { schema, path: [] },
  ];
  const declarations: Declaration[] = [];
  const names = new Set<string>();
  // Even schemas with no annotations must fit the read-side inspection budget.
  for (let visited = 0; pending.length > 0; visited += 1) {
    if (visited >= 4096) return undefined;
    const current = pending.pop();
    if (!current || !isObjectRecord(current.schema)) continue;
    const { schema: node, path } = current;
    if (Object.hasOwn(node, 'x-mcp-header')) {
      const name = node['x-mcp-header'];
      const type = node.type;
      if (
        !path?.length ||
        typeof name !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ||
        (type !== 'integer' && type !== 'string' && type !== 'boolean') ||
        names.has(name.toLowerCase())
      )
        return undefined;
      names.add(name.toLowerCase());
      declarations.push({ path, name, type });
    }
    for (const [keyword, child] of Object.entries(node)) {
      if (keyword === 'properties' && isObjectRecord(child)) {
        for (const [key, property] of Object.entries(child)) {
          pending.push({
            schema: property,
            path: path ? [...path, key] : null,
          });
        }
      } else if (namedSchemas.has(keyword) && isObjectRecord(child)) {
        for (const childSchema of Object.values(child))
          pending.push({ schema: childSchema, path: null });
      } else if (
        (positionalSchemas.has(keyword) || keyword === 'items') &&
        Array.isArray(child)
      ) {
        for (const childSchema of child)
          pending.push({ schema: childSchema, path: null });
      } else if (nestedSchemas.has(keyword)) {
        pending.push({ schema: child, path: null });
      }
    }
  }
  return declarations;
}

export function encodeMcpEventHeader(value: string): string {
  return value.trim() === value &&
    /^[\x20-\x7e]*$/u.test(value.replaceAll('\t', ' ')) &&
    !(value.startsWith('=?base64?') && value.endsWith('?='))
    ? value
    : `=?base64?${Buffer.from(value).toString('base64')}?=`;
}

export function buildEventArgumentHeaders(
  declarations: readonly Declaration[],
  args: Record<string, unknown>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { path, name, type } of declarations) {
    let value: unknown = args;
    for (const key of path) {
      value =
        isObjectRecord(value) && Object.hasOwn(value, key)
          ? value[key]
          : undefined;
    }
    if (value === undefined || value === null) continue;
    const valid =
      type === 'integer'
        ? typeof value === 'number' && Number.isSafeInteger(value)
        : typeof value === type;
    if (!valid) throw new Error('Invalid event routing argument');
    headers[`Mcp-Param-${name}`] = encodeMcpEventHeader(String(value));
  }
  return headers;
}
