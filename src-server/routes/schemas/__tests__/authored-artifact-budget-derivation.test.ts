import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const authoredArtifactEntrySurfaces = [
  'src-server/routes/schemas/schema-definitions/content.ts',
  'src-server/tools/station-control-agent-tools.ts',
  'src-server/tools/station-control-catalog-tools.ts',
] as const;

describe('authored-artifact budget derivation (station#2838)', () => {
  test('the artifact entry surfaces contain no bare 100,000-character Zod bounds', () => {
    const bareBudget = /\.max\(\s*100_?000\b/g;
    const bareBounds = authoredArtifactEntrySurfaces.flatMap((surface) => {
      const source = readFileSync(resolve(process.cwd(), surface), 'utf8');
      return [...source.matchAll(bareBudget)].map((match) => ({
        surface,
        bound: match[0],
      }));
    });

    // This scans every artifact-writing boundary, rather than just today's
    // fields, so a fifth writer that repeats the old bare literal reddens.
    expect(bareBounds).toEqual([]);
  });
});
