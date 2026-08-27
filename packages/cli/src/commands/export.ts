import { existsSync, writeFileSync } from 'node:fs';
import type { PortabilityFormat } from '@kontourai/station-contracts/portability';
import {
  buildAgentsMdDocument,
  buildClaudeDesktopConfig,
  serializeAgentsMd,
  serializeClaudeDesktopConfig,
} from '@kontourai/station-shared/portability';
import { readPortabilitySnapshot } from './portability-io.js';

export interface ExportCommandOptions {
  format: PortabilityFormat;
  output?: string;
  projectHome?: string;
  includeSecrets?: boolean;
}

export function exportConfig(options: ExportCommandOptions): string {
  if (options.includeSecrets) {
    console.error(
      'WARNING: --include-secrets exports ordinary legacy credentials as plaintext. It never exports secret binding references or binding-backed credentials.',
    );
  }
  const snapshot = readPortabilitySnapshot(
    options.projectHome,
    options.includeSecrets === true,
  );
  let output: string;

  if (options.format === 'agents-md') {
    const document = buildAgentsMdDocument(snapshot);
    output = serializeAgentsMd(document);
  } else if (options.format === 'claude-desktop') {
    const config = buildClaudeDesktopConfig({
      integrations: snapshot.integrations,
    });
    output = serializeClaudeDesktopConfig(config.config);
  } else {
    throw new Error(`Unsupported export format: ${options.format}`);
  }

  if (options.output) {
    if (existsSync(options.output))
      throw new Error(
        `Refusing to overwrite existing export: ${options.output}`,
      );
    writeFileSync(options.output, output, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`  ✓ exported ${options.format} to ${options.output}`);
  } else {
    console.log(output);
  }

  return output;
}
