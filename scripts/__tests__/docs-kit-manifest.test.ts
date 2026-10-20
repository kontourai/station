import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPublicDocs } from '../build-github-pages.mjs';
import { readStationDocsInputs } from '../generate-station-docs.mjs';

// corpus.json feeds the docs-bundle.json that pages.yml publishes beside
// Station's own Pages site, so its published documents must be exactly the
// pages that site renders: the bundle's docs/<path>.html URLs point at them.
// Its topics mirror the shipped Station Docs MCP topics, so the shared docs
// MCP answers with the same sections the in-app server does. Its own docs-kit
// gate (.github/workflows/docs-kit.yml) is advisory, so this is the blocking
// check that the manifests have not drifted.
// The shape generate-station-docs.mjs returns for each shipped topic; the
// generator is untyped JavaScript, so name the fields this test reads.
interface ShippedTopic {
  readonly id: string;
  readonly title: string;
  readonly parentId: string;
  readonly sourcePath: string;
  readonly sourceAnchor: string;
}

function readManifest() {
  return JSON.parse(readFileSync('corpus.json', 'utf8'));
}

async function shippedManualTopics() {
  const catalog = JSON.parse(
    readFileSync('docs/learn/mcp-topics.json', 'utf8'),
  );
  // The generator's own mapping from each catalog section to its manual
  // anchor; architecture topics come from the atlas and have no manual source.
  const shipped: ShippedTopic[] = await readStationDocsInputs();
  const topics = shipped.filter((topic) => topic.parentId === 'manual');
  return { catalog, topics };
}

describe('docs-kit manifest', () => {
  it('publishes exactly the admitted public docs, in order and section', async () => {
    const manifest = readManifest();
    const publicDocs = await loadPublicDocs();
    expect(publicDocs.length).toBeGreaterThan(0);
    expect(
      manifest.documents.filter(
        (document: { publish?: boolean }) => document.publish !== false,
      ),
    ).toEqual(
      publicDocs.map(({ source, section }) => ({
        source: `docs/${source}`,
        section,
      })),
    );
  });

  it('bundles the shipped manual without publishing it as a page', async () => {
    const { catalog } = await shippedManualTopics();
    expect(
      readManifest().documents.filter(
        (document: { publish?: boolean }) => document.publish === false,
      ),
    ).toEqual([
      { source: catalog.source, section: 'Reference', publish: false },
    ]);
  });

  it('mirrors every shipped manual topic and the section it maps to', async () => {
    const { catalog, topics } = await shippedManualTopics();
    // The generator refuses manual sections the catalog omits, so a truncated
    // catalog cannot make both sides agree; an empty one fails here.
    expect(topics.length).toBeGreaterThan(0);
    expect(topics.map(({ id }) => id)).toEqual(
      catalog.topics.map(({ id }: { id: string }) => id),
    );
    expect(readManifest().topics).toEqual(
      topics.map(({ id, title, sourcePath, sourceAnchor }) => ({
        id,
        title,
        source: `${sourcePath}#${sourceAnchor}`,
      })),
    );
  });

  it('identifies Station and lands on the README', () => {
    expect(readManifest()).toMatchObject({
      schemaVersion: 2,
      product: 'station',
      repo: 'kontourai/station',
      landing: 'README.md',
    });
  });
});
