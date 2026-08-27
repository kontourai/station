import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildOpenApiSpec } from '../src-server/openapi/spec.js';

const outputPath = resolve(process.cwd(), 'docs/reference/openapi.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  `${JSON.stringify(buildOpenApiSpec(), null, 2)}\n`,
  'utf-8',
);

console.log(`Generated OpenAPI spec at ${outputPath}`);
