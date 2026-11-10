import { readFileSync } from 'node:fs';
import { isTelemetryPublisherId } from '@kontourai/station-contracts/product-telemetry';
import Ajv from 'ajv';
import { expect, test } from 'vitest';

const digest = 'a'.repeat(24);
const edgeCases: readonly (readonly [string, boolean])[] = [
  ['kontour', true],
  ['operator', true],
  ['publisher:writer', true],
  [`publisher:${digest}/writer_1.2:beta-3`, true],
  [`publisher:${'w'.repeat(128)}`, true],
  [`publisher:${digest}/${'w'.repeat(128)}`, true],
  ['', false],
  ['publisher:', false],
  ['publisher:Writer', false],
  [`publisher:${digest}/Writer`, false],
  [`publisher:${'a'.repeat(23)}/writer`, false],
  [`publisher:${'a'.repeat(25)}/writer`, false],
  [`publisher:${'A'.repeat(24)}/writer`, false],
  [`publisher:${'g'.repeat(24)}/writer`, false],
  [`publisher:${'w'.repeat(129)}`, false],
  [`publisher:${digest}/${'w'.repeat(129)}`, false],
  [`publisher:${digest}/writer/extra`, false],
  [`publisher:${digest}//writer`, false],
  [`publisher:${digest}/`, false],
  ['publisher:/writer', false],
  ['publisher:@scope/plugin', false],
  ['publisher:écrivain', false],
  [`publisher:${digest}/ｗriter`, false],
  [`publisher:${digest}/writer😀`, false],
  ['publisher:writer\n', false],
  [`publisher:${digest}/writer\n`, false],
  [`publisher:${digest}/writer\r\n`, false],
  [`publisher:${digest}\n/writer`, false],
  ...['constructor', 'prototype', '__proto__'].flatMap(
    (reserved): (readonly [string, boolean])[] => [
      [reserved, false],
      [`publisher:${reserved}`, false],
      [`publisher:${reserved}/writer`, false],
      [`publisher:${digest}/${reserved}`, false],
    ],
  ),
];

function generatedIds(): Set<string> {
  const ids = new Set(edgeCases.map(([id]) => id));
  let seed = 0x4617;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const text = (alphabet: string, length: number) =>
    Array.from({ length }, () => alphabet[next() % alphabet.length]).join('');
  const itemCharacters = 'abcdefghijklmnopqrstuvwxyz0123456789._:-';
  const mutations = 'AZ/@ \nλ';
  for (let i = 0; i < 5000; i++) {
    const hex = text('0123456789abcdef', 24);
    const item = text(itemCharacters, next() % 132);
    const namespaced = `publisher:${hex}/${item}`;
    ids.add(namespaced);
    ids.add(`publisher:${text(itemCharacters + mutations, next() % 164)}`);
    ids.add(`publisher:${hex.slice(0, next() % 25)}/${item}`);
    const at = next() % namespaced.length;
    ids.add(
      namespaced.slice(0, at) +
        mutations[next() % mutations.length] +
        namespaced.slice(at + 1),
    );
  }
  return ids;
}

test('real app schema and publisher validator agree on generated IDs and bounded edge cases', () => {
  const schema = JSON.parse(
    readFileSync(
      new URL('../../../schemas/app.schema.json', import.meta.url),
      'utf8',
    ),
  );
  // Match SchemaValidator's production options, including additional-properties behavior.
  const validate = new Ajv({ allErrors: false, verbose: true }).compile(schema);
  const expected = new Map(edgeCases);
  for (const id of generatedIds()) {
    const codeAccepts = isTelemetryPublisherId(id);
    for (const field of ['telemetryTier', 'telemetryPublisherPolicy']) {
      const schemaAccepts = validate({
        defaultModel: '',
        invokeModel: '',
        structureModel: '',
        [field]: { [id]: 'lite' },
      });
      expect(schemaAccepts, `${field}: ${JSON.stringify(id)}`).toBe(
        codeAccepts,
      );
    }
    if (expected.has(id))
      expect(codeAccepts, JSON.stringify(id)).toBe(expected.get(id));
  }
});
