import { deflateSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { readAgentWire } from './turn-wire.js';

type Node = null | boolean | number | string | Node[] | { [key: string]: Node };
const descriptor = z
  .object({
    version: z.literal('agent-body/3'),
    chunks: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(65536),
    payload: z.string(),
  })
  .strict();
function delta(
  node: Node,
): { field: number; text: string; template: Node[] } | undefined {
  if (!Array.isArray(node) || node[0] !== 'object') return;
  const type = node.find((pair) => Array.isArray(pair) && pair[0] === 'type');
  if (
    !Array.isArray(type) ||
    !['text-delta', 'reasoning-delta'].includes(String(type[1]))
  )
    return;
  const field = node.findIndex(
    (pair) =>
      Array.isArray(pair) &&
      ['delta', 'text'].includes(String(pair[0])) &&
      typeof pair[1] === 'string',
  );
  if (field < 0) return;
  const pair = node[field] as Node[];
  const template = [...node];
  template[field] = [pair[0]!, ''];
  return { field, text: String(pair[1]), template };
}
function nested(value: string): Node | undefined {
  if (!value.startsWith('[')) return;
  try {
    readAgentWire(value);
    return JSON.parse(value);
  } catch {
    return;
  }
}

/** Store native text independently of wire escaping and provider chunk boundaries. */
export function encodeAgentBody(
  wire: string,
  putText: (value: string) => string,
): string {
  const chunks = new Set<string>();
  const visit = (node: Node): Node => {
    if (typeof node === 'string') {
      const inside = nested(node);
      if (inside !== undefined) return { nested: visit(inside) };
      if (node.length < 256) return node;
      const refs: string[] = [];
      let start = 0;
      let rolling = 0;
      for (let index = 0; index < node.length; index++) {
        rolling =
          ((rolling << 1) + Math.imul(node.charCodeAt(index), 0x9e3779b1)) >>>
          0;
        const length = index + 1 - start;
        if (
          length >= 4096 ||
          (length >= 1024 && (rolling & 2047) === 0) ||
          index === node.length - 1
        ) {
          const ref = putText(node.slice(start, index + 1));
          chunks.add(ref);
          refs.push(ref);
          start = index + 1;
          rolling = 0;
        }
      }
      return { text: refs };
    }
    if (!Array.isArray(node)) return node;
    if (node[0] !== 'array') return node.map(visit);
    const values = node.slice(1);
    const strings =
      values.length > 0 &&
      values.every(
        (value) => typeof value === 'string' && nested(value) !== undefined,
      );
    const parts = strings
      ? values.map((value) => nested(String(value))!)
      : values;
    const tape: Node[] = [];
    for (let index = 0; index < parts.length; ) {
      const first = delta(parts[index]!);
      if (!first) {
        tape.push(visit(parts[index++]!));
        continue;
      }
      const template = JSON.stringify(first.template);
      const lengths: number[] = [];
      const texts: string[] = [];
      while (index < parts.length) {
        const next = delta(parts[index]!);
        if (!next || JSON.stringify(next.template) !== template) break;
        lengths.push(next.text.length);
        texts.push(next.text);
        index++;
      }
      tape.push({
        run: [first.template, first.field, lengths, visit(texts.join(''))],
      });
    }
    return { tape, strings };
  };
  const payload = deflateSync(JSON.stringify(visit(JSON.parse(wire)))).toString(
    'base64',
  );
  return JSON.stringify({
    version: 'agent-body/3',
    chunks: [...chunks],
    payload,
  });
}

export function decodeAgentBody(
  stored: string,
  readText: (ref: string) => string,
): string {
  const data = descriptor.parse(JSON.parse(stored));
  const used = new Set<string>();
  const visit = (node: Node): Node => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    if ('text' in node && Array.isArray(node.text))
      return node.text
        .map((ref) => {
          if (typeof ref !== 'string' || !data.chunks.includes(ref))
            throw new Error('DURABLE_AGENT_BODY_DAMAGED');
          used.add(ref);
          return readText(ref);
        })
        .join('');
    if ('nested' in node) return JSON.stringify(visit(node.nested!));
    if (!Array.isArray(node.tape) || typeof node.strings !== 'boolean')
      throw new Error('DURABLE_AGENT_BODY_DAMAGED');
    const values: Node[] = [];
    for (const part of node.tape) {
      if (
        part &&
        !Array.isArray(part) &&
        typeof part === 'object' &&
        Array.isArray(part.run)
      ) {
        const [template, field, lengths, encoded] = part.run;
        const text = visit(encoded!);
        if (
          !Array.isArray(template) ||
          typeof field !== 'number' ||
          !Array.isArray(lengths) ||
          typeof text !== 'string'
        )
          throw new Error('DURABLE_AGENT_BODY_DAMAGED');
        let offset = 0;
        for (const length of lengths) {
          if (
            typeof length !== 'number' ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            offset + length > text.length
          )
            throw new Error('DURABLE_AGENT_BODY_DAMAGED');
          const value = structuredClone(template);
          const pair = value[field];
          if (!Array.isArray(pair) || pair[1] !== '')
            throw new Error('DURABLE_AGENT_BODY_DAMAGED');
          pair[1] = text.slice(offset, offset + length);
          offset += length;
          values.push(value);
        }
        if (offset !== text.length)
          throw new Error('DURABLE_AGENT_BODY_DAMAGED');
      } else values.push(visit(part));
    }
    return [
      'array',
      ...values.map((value) => (node.strings ? JSON.stringify(value) : value)),
    ];
  };
  const wire = JSON.stringify(
    visit(
      JSON.parse(
        inflateSync(Buffer.from(data.payload, 'base64'), {
          maxOutputLength: 64 * 1024 * 1024,
        }).toString('utf8'),
      ),
    ),
  );
  if (used.size !== data.chunks.length)
    throw new Error('DURABLE_AGENT_BODY_DAMAGED');
  return wire;
}
