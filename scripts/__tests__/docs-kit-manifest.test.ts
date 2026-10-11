import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPublicDocs } from '../build-github-pages.mjs';

// docs-kit.json feeds the docs-bundle.json that pages.yml publishes beside
// Station's own Pages site, so its documents must be exactly the pages that
// site renders: the bundle's docs/<path>.html URLs point at them. Its own
// docs-kit gate (.github/workflows/docs-kit.yml) is advisory, so this is the
// blocking check that the two manifests have not drifted.
describe('docs-kit manifest', () => {
  it('publishes exactly the admitted public docs, in order and section', async () => {
    const manifest = JSON.parse(readFileSync('docs-kit.json', 'utf8'));
    const publicDocs = await loadPublicDocs();
    expect(publicDocs.length).toBeGreaterThan(0);
    expect(manifest.documents).toEqual(
      publicDocs.map(({ source, section }) => ({
        source: `docs/${source}`,
        section,
      })),
    );
  });

  it('identifies Station and lands on the README', () => {
    const manifest = JSON.parse(readFileSync('docs-kit.json', 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      product: 'station',
      repo: 'kontourai/station',
      landing: 'README.md',
    });
  });
});
