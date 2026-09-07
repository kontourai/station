#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const RESOURCE =
  '      - path: PrivacyInfo.xcprivacy\n        buildPhase: resources\n';
const ANCHOR = '      - path: station_iOS\n';

export function ensureIosPrivacyManifestResource(project) {
  if (project.includes(RESOURCE)) return project;
  if (project.split(ANCHOR).length !== 2)
    throw new Error('iOS project spec has no unique station_iOS source anchor');
  return project.replace(ANCHOR, `${ANCHOR}${RESOURCE}`);
}

function main(projectPath) {
  if (!projectPath) throw new Error('Expected an iOS project.yml path');
  const resolved = resolve(projectPath);
  const current = readFileSync(resolved, 'utf8');
  const next = ensureIosPrivacyManifestResource(current);
  if (next !== current) writeFileSync(resolved, next, 'utf8');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    main(process.argv[2]);
  } catch (error) {
    console.error(
      `iOS privacy manifest resource error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
