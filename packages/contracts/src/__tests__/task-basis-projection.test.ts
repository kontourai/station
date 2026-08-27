import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeBasisProjectionV2 } from '@kontourai/surface/basis';
import { describe, expect, test } from 'vitest';
import { parseStationBasisProjection } from '../task-basis.js';

function v2() {
  const composition = JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        'node_modules/@kontourai/surface/examples/fixtures/station-basis-context.v2.json',
      ),
      'utf8',
    ),
  );
  return composeBasisProjectionV2(composition);
}

describe('Station Basis v2 parser boundary', () => {
  test("returns Surface's independent parsed snapshot, not the caller object", () => {
    const input = v2();
    const parsed = parseStationBasisProjection(input);
    expect(parsed).not.toBeNull();
    expect(parsed).not.toBe(input);
    const before = JSON.stringify(parsed);
    (input as { version: string }).version = 'hostile-version';
    (input as { answer: { state: string } }).answer.state = 'corrupt';
    expect(JSON.stringify(parsed)).toBe(before);
  });

  test("turns a hostile getter into the caller's closed parse gap", () => {
    const hostile = Object.create(null, {
      version: {
        enumerable: true,
        get: () => {
          throw new Error('getter');
        },
      },
    });
    expect(parseStationBasisProjection(hostile)).toBeNull();
  });
});
