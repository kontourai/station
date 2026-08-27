import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { describe, expect, it } from 'vitest';
import { buildVersion, injectBuildIdentity } from '../../../vite.config';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const configFile = path.join(repoRoot, 'vite.config.ts');

describe('build identity stays outside the JavaScript hash graph', () => {
  it('does not expose build identity through Vite define', async () => {
    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      configFile,
      repoRoot,
    );

    expect(loaded?.config.define?.__STATION_BUILD__).toBeUndefined();
    expect(
      loaded?.config.plugins?.some(
        (plugin) =>
          typeof plugin === 'object' &&
          plugin !== null &&
          'name' in plugin &&
          plugin.name === 'station-build-identity',
      ),
    ).toBe(true);
  });

  it('injects one escaped version and commit pair into index.html', () => {
    const html = injectBuildIdentity(
      '<html><head></head><body></body></html>',
      {
        version: '1.2.3&<candidate>',
        commit: 'abc"def\'ghi',
      },
    );

    expect(html).toContain(
      '<meta name="station-build-version" content="1.2.3&amp;&lt;candidate&gt;">',
    );
    expect(html).toContain(
      '<meta name="station-build-commit" content="abc&quot;def&#39;ghi">',
    );
    expect(html.match(/station-build-version/g)).toHaveLength(1);
    expect(html.match(/station-build-commit/g)).toHaveLength(1);
  });

  it('uses a build-specific native release identity without changing source authority', () => {
    expect(buildVersion('0.1.2')).toBe('0.1.2');
    expect(buildVersion('0.1.2', '0.1.2-preview.3')).toBe('0.1.2-preview.3');
    expect(buildVersion('0.1.2', '0.1.2-nightly.2412')).toBe(
      '0.1.2-nightly.2412',
    );
    expect(() => buildVersion('0.1.2', 'latest')).toThrow(
      /Invalid Station build version/,
    );
  });

  it('fails closed when index.html has no head boundary', () => {
    expect(() =>
      injectBuildIdentity('<html><body></body></html>', {
        version: '1.2.3',
        commit: 'abcdef0',
      }),
    ).toThrow(/missing <\/head>/);
  });
});
