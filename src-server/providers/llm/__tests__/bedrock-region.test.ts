/**
 * archive#1557. Three surfaces disagreed about one setting: the inference
 * path read the stored config and ignored `AWS_REGION`, the model-catalogue
 * route read `AWS_REGION` and ignored the stored config, and the Settings
 * badge told the user the stored value was inert whenever `AWS_REGION`
 * existed. These tests pin the single resolution and, more importantly, pin
 * that the two READERS go through it — a shared function nobody calls fixes
 * nothing.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_SETTINGS_REGISTRY } from '@kontourai/station-contracts/settings-registry';
import { describe, expect, it } from 'vitest';
import { normalizeBedrockRegion } from '../bedrock-models.js';
import {
  BEDROCK_REGION_DEFAULT,
  BEDROCK_REGION_ENV_VAR,
  isBedrockRegionId,
  resolveBedrockRegion,
} from '../bedrock-region.js';

/**
 * Block and line comments removed so a source scan asserts what the file
 * DOES, not what it says about its own history.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_SERVER = join(HERE, '..', '..', '..');

describe('one resolution for the Bedrock region', () => {
  it('prefers the agent override over everything', () => {
    expect(
      resolveBedrockRegion({
        agentRegion: 'ap-south-1',
        configRegion: 'eu-west-1',
        env: { AWS_REGION: 'us-east-2' },
      }),
    ).toMatchObject({ region: 'ap-south-1', source: 'agent' });
  });

  it('places a connection region between the agent and the workspace setting', () => {
    expect(
      resolveBedrockRegion({
        connectionRegion: 'ca-central-1',
        configRegion: 'eu-west-1',
        env: { AWS_REGION: 'us-east-2' },
      }),
    ).toMatchObject({ region: 'ca-central-1', source: 'connection' });
    expect(
      resolveBedrockRegion({
        agentRegion: 'ap-south-1',
        connectionRegion: 'ca-central-1',
      }),
    ).toMatchObject({ region: 'ap-south-1', source: 'agent' });
  });

  it('prefers the stored setting over the environment', () => {
    // The behaviour the badge denied. An edit to this setting takes effect
    // whether or not AWS_REGION is set, so the control must stay editable.
    expect(
      resolveBedrockRegion({
        configRegion: 'eu-west-1',
        env: { AWS_REGION: 'us-east-2' },
      }),
    ).toMatchObject({ region: 'eu-west-1', source: 'config' });
  });

  it('falls back to the environment only when nothing is stored', () => {
    expect(
      resolveBedrockRegion({ env: { AWS_REGION: 'us-east-2' } }),
    ).toMatchObject({
      region: 'us-east-2',
      source: 'env',
      envVar: 'AWS_REGION',
    });
  });

  it('treats an empty or whitespace stored value as absent', () => {
    // A stored '' would otherwise win and hand the AWS client no region while
    // every surface reported one.
    expect(
      resolveBedrockRegion({
        configRegion: '   ',
        env: { AWS_REGION: 'us-east-2' },
      }),
    ).toMatchObject({ region: 'us-east-2', source: 'env' });
    expect(resolveBedrockRegion({ configRegion: '', env: {} })).toMatchObject({
      region: BEDROCK_REGION_DEFAULT,
      source: 'default',
    });
  });

  it('discards a malformed AWS_REGION rather than passing it on', () => {
    // Review round 2, HIGH. `BedrockModelCatalog`'s constructor THROWS on a
    // value failing the region grammar, and `runtime-initialize.ts` builds one
    // at boot with no try/catch. Routing the environment into the resolver put
    // an arbitrary user env var on that path for the first time, so
    // `export AWS_REGION=US-EAST-1` in a shell profile would have made Station
    // unbootable. A malformed value is not a decision.
    for (const malformed of [
      'US-EAST-1',
      'us-east-1,eu-west-1',
      '"us-east-1"',
      'useast1',
      'us-east',
      `${'a'.repeat(80)}-b-c`,
    ]) {
      expect(
        resolveBedrockRegion({ env: { AWS_REGION: malformed } }),
        `${malformed} must not be admitted`,
      ).toMatchObject({ region: BEDROCK_REGION_DEFAULT, source: 'default' });
    }
  });

  it('admits the region shapes AWS actually uses', () => {
    for (const region of ['us-east-1', 'eu-west-3', 'ap-southeast-4']) {
      expect(
        resolveBedrockRegion({ env: { AWS_REGION: region } }),
      ).toMatchObject({ region, source: 'env' });
    }
  });

  it('accepts exactly what normalizeBedrockRegion accepts', () => {
    // The two must not drift: one discards, the other throws, and a value the
    // resolver admits but the catalogue rejects is the boot crash again.
    for (const candidate of [
      'us-east-1',
      'ap-southeast-4',
      'US-EAST-1',
      'us-east',
      '',
      '  ',
    ]) {
      let normalizes = true;
      try {
        normalizeBedrockRegion(candidate);
      } catch {
        normalizes = false;
      }
      expect(isBedrockRegionId(candidate.trim()), candidate).toBe(normalizes);
    }
  });

  it('names the default as a default rather than as a decision', () => {
    expect(resolveBedrockRegion()).toMatchObject({
      region: BEDROCK_REGION_DEFAULT,
      source: 'default',
    });
  });
});

describe('the readers cannot diverge again', () => {
  /**
   * EVERY site that decides a Bedrock region.
   *
   * The first archive#1557 fix listed two of these, and review found the list was
   * the defect: `framework-model-factory.ts` — the chain every Station-agent
   * execution path runs — kept its own `appConfig.region || 'us-east-1'` tail
   * with no `AWS_REGION`, so unifying the badge and the catalogue around a
   * resolver the chat turn did not use RELOCATED the disagreement and put a
   * user-facing claim on top of it. A scan that reads two files cannot see a
   * third; the list is the guard, so it has to be honest about its coverage.
   *
   * **What this list is NOT, stated accurately on the third attempt.** It
   * covers every site that derives a region from configuration or environment.
   * It does not cover:
   *
   * - `bedrock-models.ts`'s `getModelPricing(region = 'us-east-1')` and
   *   `connection-factories.ts`, which default or pass through a value they
   *   were handed. Verified pass-through, not decisions.
   * - `bedrock-llm-provider.ts:115`'s `this.region = region || 'us-east-1'`,
   *   which is NOT merely a constructor default and was described as one for
   *   two rounds. `BedrockProviderConfig.region` is optional and the UI seeds a
   *   new connection with `{ region: '' }`, so a user who leaves Region blank
   *   makes that `||` a real decision — one that consults neither the stored
   *   setting nor the environment, and whose model picker then offers models
   *   from a region its turns will not use. Pre-existing behaviour, named here
   *   rather than covered by a sentence that says it does not exist. Routing it
   *   changes connection semantics (a blank connection region would start
   *   inheriting the workspace default), which is a product decision this
   *   branch is not the place for.
   */
  const readers = [
    join(SRC_SERVER, 'providers', 'llm', 'bedrock.ts'),
    join(SRC_SERVER, 'routes', 'connections', 'models.ts'),
    join(SRC_SERVER, 'runtime', 'frameworks', 'framework-model-factory.ts'),
    join(SRC_SERVER, 'runtime', 'plugins', 'runtime-provider-resolution.ts'),
    join(SRC_SERVER, 'runtime', 'bootstrap', 'runtime-initialize.ts'),
    join(SRC_SERVER, 'runtime', 'agents', 'agent-hooks.ts'),
    join(SRC_SERVER, 'runtime', 'tools', 'tool-execution-usage.ts'),
    join(SRC_SERVER, 'runtime', 'conversation', 'usage-stats.ts'),
    join(SRC_SERVER, 'routes', 'connections', 'bedrock.ts'),
  ];

  it.each(readers)(
    '%s resolves the region through the shared function',
    (path) => {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain('resolveBedrockRegion');
    },
  );

  it.each(readers)('%s does not read AWS_REGION on its own', (path) => {
    // The concrete regression: `process.env.AWS_REGION || 'us-east-1'` in the
    // catalogue route, and a config-only chain in the provider. Either one
    // reappearing re-creates the disagreement, so the absence is asserted
    // rather than assumed from a passing behaviour test that mocks both.
    //
    // Comments are stripped first: these files DESCRIBE the old expressions
    // in their docblocks, and a scan that cannot tell a mention from a read
    // would either fail on the explanation or force the explanation out.
    const source = stripComments(readFileSync(path, 'utf8'));
    const selfRead = new RegExp(
      `process\\.env(\\.|\\[['"])${BEDROCK_REGION_ENV_VAR}`,
    );
    expect(selfRead.test(source)).toBe(false);
    // A resurrected default chain. The pricing client's deliberate
    // `region: 'us-east-1'` pin (that API exists nowhere else) is not this
    // shape and stays legal.
    expect(source).not.toContain(`|| '${BEDROCK_REGION_DEFAULT}'`);
    expect(source).not.toContain(`?? '${BEDROCK_REGION_DEFAULT}'`);
  });

  it('keeps the registry declaration pointing at the var the resolver reads', () => {
    const region = APP_SETTINGS_REGISTRY.find(
      (definition) => definition.key === 'region',
    );
    expect(region?.envFallback).toBe(BEDROCK_REGION_ENV_VAR);
  });
});
