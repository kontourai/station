import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ADAPTER_IMPLEMENTATIONS } from './adapter-contract-test-utils.js';
import { providerShapeImplementations } from './provider-shape-inventory.js';

const makeTempDir = trackTempDirs();

const adaptersDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../adapters',
);

function adapterSource(name: string): string {
  return readFileSync(join(adaptersDir, name), 'utf8');
}

/**
 * The provider inventory is deliberately source-derived. A new adapter that
 * emits a canonical turn start must join this list explicitly; otherwise its
 * attachment behavior has no reviewed projection proof and this test reds.
 * The projection itself (bus and persistence carry the blob reference, not
 * the bytes) is proven at its owner in
 * services/orchestration/__tests__/provider-event-projection-publication.test.ts.
 */
const TURN_STARTED_ADAPTERS = [
  'acp-adapter.ts',
  'bedrock-adapter.ts',
  'claude-adapter.ts',
  'codex-adapter.ts',
  'muse-adapter.ts',
  'ollama-adapter.ts',
  'station-agent-adapter.ts',
] as const;

const ATTACHMENT_FORWARDING_ADAPTERS = [
  'acp-adapter.ts',
  'claude-adapter.ts',
  'codex-adapter.ts',
] as const;

describe('turn.started attachment projection inventory (station#4134)', () => {
  test('every concrete ProviderAdapterShape implementation across production src-server TypeScript registers in the deterministic conformance suite', () => {
    // Scan all production directories, including files with no existing import
    // edge. The text prefilter requires sendTurn or ProviderAdapterShape in the
    // file. Implementations assembled solely through aliases, inherited members,
    // or spreads with neither marker are outside this guard; new adapters must
    // name the contract or their required sendTurn method to join this inventory.
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    expect(providerShapeImplementations(root)).toEqual(
      Object.values(ADAPTER_IMPLEMENTATIONS).sort(),
    );
  }, 120_000);

  test('discovers a shape implementation in a candidate fixture file', () => {
    const root = makeTempDir('station-adapter-inventory-');
    const providers = join(root, 'src-server/providers');
    const services = join(root, 'src-server/services/nested');
    mkdirSync(providers, { recursive: true });
    mkdirSync(services, { recursive: true });
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(
      join(providers, 'adapter-shape.ts'),
      'export interface ProviderAdapterShape { sendTurn(): void }',
    );
    writeFileSync(
      join(services, 'candidate.ts'),
      `import type { ProviderAdapterShape } from '../../providers/adapter-shape';
       export class Candidate implements
         ProviderAdapterShape {}`,
    );
    writeFileSync(
      join(services, 'structural.ts'),
      'export const structural = { sendTurn() {} };',
    );
    expect(providerShapeImplementations(root)).toEqual([
      'services/nested/candidate.ts#Candidate',
      'services/nested/structural.ts#structural',
    ]);
  });

  test('enumerates every provider adapter that emits turn.started', () => {
    const discovered = readdirSync(adaptersDir)
      .filter((name) => name.endsWith('-adapter.ts'))
      .filter((name) => /method:\s*'turn\.started'/u.test(adapterSource(name)))
      .sort();

    expect(discovered).toEqual([...TURN_STARTED_ADAPTERS].sort());
  });

  test('every attachment-forwarding adapter puts only its input on turn.started', () => {
    for (const name of ATTACHMENT_FORWARDING_ADAPTERS) {
      expect(
        adapterSource(name),
        `${name} must explicitly join the live attachment projection seam`,
      ).toMatch(
        /method:\s*'turn\.started'[\s\S]{0,900}?attachments:\s*input\.attachments/u,
      );
    }
  });
});
