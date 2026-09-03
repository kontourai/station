import { readFileSync } from 'node:fs';
import {
  assertRegistryGitHeadMatchesSource,
  parseRegistryGitHead,
} from './lib/npm-registry-provenance.mjs';

const [registryFile, sourceSha] = process.argv.slice(2);
if (!registryFile || !sourceSha || process.argv.length !== 4) {
  throw new Error(
    'Usage: verify-npm-registry-provenance.mjs <registry-githead.json> <source-sha>',
  );
}

const registryGitHead = parseRegistryGitHead(
  readFileSync(registryFile, 'utf8'),
);
assertRegistryGitHeadMatchesSource(registryGitHead, sourceSha);
console.log(registryGitHead);
