import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { PortabilityImportLedgerEntry } from '@kontourai/station-contracts/portability';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  buildAgentsMdImportPlan,
  parseAgentsMd,
  parseClaudeDesktopConfig,
} from '@kontourai/station-shared/portability';
import { acquireStationHomeRuntimeLease } from '@kontourai/station-shared/station-home-lifecycle';
import { PROJECT_HOME } from './helpers.js';
import {
  completedImportLedgerPath,
  type ImportProgress,
  importProgressPath,
  readImportProgress,
  writeImportProgress,
} from './import-progress.js';
import {
  validateIntegrationImport,
  writeAgent,
  writeAppConfigGuidance,
  writeImportLedger,
  writeIntegration,
} from './portability-io.js';

export interface ImportCommandOptions {
  projectHome?: string;
  resumeId?: string;
}

export interface ImportCommandResult {
  appConfigUpdated: boolean;
  agentCount: number;
  integrationCount: number;
  ledgerPath: string;
  notesPath?: string;
}

interface PlannedEffect {
  target: string;
  apply: () => Promise<unknown>;
}

function planImport(
  sourcePath: string,
  sourceText: string,
  projectHome: string,
  importedAt: string,
): {
  effects: PlannedEffect[];
  receipt: PortabilityImportLedgerEntry;
  notes: string | null;
} {
  const effects: PlannedEffect[] = [];
  if (sourcePath.toLowerCase().endsWith('.json')) {
    const { integrations, losses } = parseClaudeDesktopConfig(sourceText);
    for (const integration of integrations) {
      validateIntegrationImport(integration.id, integration);
      effects.push({
        target: `integrations/${integration.id}`,
        apply: () => writeIntegration(integration.id, integration, projectHome),
      });
    }
    return {
      effects,
      receipt: {
        id: `claude-desktop-${randomUUID()}`,
        sourceFormat: 'claude-desktop',
        importedAt,
        sourcePath,
        degradedFields: losses,
        applied: {
          appConfigUpdated: false,
          agentSlugs: [],
          integrationIds: integrations.map((integration) => integration.id),
        },
      },
      notes: null,
    };
  }

  const parsed = parseAgentsMd(sourceText);
  const plan = buildAgentsMdImportPlan({ sourcePath, parsed, importedAt });
  if (plan.ledgerEntry.applied.appConfigUpdated) {
    effects.push({
      target: 'config/app.json',
      apply: () => writeAppConfigGuidance(plan.appConfig, projectHome),
    });
  }
  for (const agent of plan.agents) {
    effects.push({
      target: `agents/${agent.slug}`,
      apply: () => writeAgent(agent.slug, agent.spec, projectHome),
    });
  }
  for (const integration of plan.integrations) {
    validateIntegrationImport(integration.id, integration);
    effects.push({
      target: `integrations/${integration.id}`,
      apply: () => writeIntegration(integration.id, integration, projectHome),
    });
  }
  return {
    effects,
    receipt: { ...plan.ledgerEntry, id: `agents-md-${randomUUID()}` },
    notes: parsed.unmatchedProse,
  };
}

export function readConfigImportStatus(projectHome = PROJECT_HOME) {
  const progress = readImportProgress(projectHome);
  if (!progress) return null;
  const { id, sourcePath, sourceFormat, importedAt, phase, effects } = progress;
  return {
    id,
    sourcePath,
    sourceFormat,
    importedAt,
    phase,
    effects,
    ledgerPath: completedImportLedgerPath(projectHome, id),
  };
}

export async function importConfig(
  sourcePath: string,
  options: ImportCommandOptions = {},
): Promise<ImportCommandResult> {
  if (!sourcePath) throw new Error('Usage: station import <file>');

  const projectHome = options.projectHome ?? PROJECT_HOME;
  const useLease = acquireStationHomeRuntimeLease(projectHome);
  try {
    const sourceBytes = readFileSync(sourcePath);
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
    const plan = planImport(
      sourcePath,
      sourceBytes.toString('utf8'),
      projectHome,
      new Date().toISOString(),
    );
    const directory = dirname(importProgressPath(projectHome));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await acquireFileMutationLockAsync(
      join(directory, 'import.lock'),
    );
    try {
      const previous = readImportProgress(projectHome);
      if (options.resumeId !== undefined && previous?.id !== options.resumeId) {
        throw new Error(
          'No matching Station import. Inspect the last operation with station import --status.',
        );
      }
      if (
        previous &&
        previous.phase !== 'complete' &&
        options.resumeId === undefined
      ) {
        throw new Error(
          `A Station import is incomplete. Inspect it with station import --status, then retry the original file with --resume=${previous.id}. Resuming may replace changes to unfinished targets.`,
        );
      }
      const progress: ImportProgress =
        previous && options.resumeId !== undefined
          ? previous
          : {
              version: 1,
              id: plan.receipt.id,
              sourcePath,
              sourceFormat: plan.receipt.sourceFormat,
              sourceSha256,
              importedAt: plan.receipt.importedAt,
              phase: 'applying',
              effects: plan.effects.map(({ target }) => ({
                target,
                status: 'pending',
              })),
            };
      if (
        progress.sourceSha256 !== sourceSha256 ||
        progress.sourceFormat !== plan.receipt.sourceFormat ||
        progress.effects.length !== plan.effects.length ||
        progress.effects.some(
          ({ target }, index) => target !== plan.effects[index].target,
        )
      ) {
        throw new Error(
          'The file does not match the original Station import. Use the original file bytes and format.',
        );
      }
      const { appConfigUpdated, agentSlugs, integrationIds } =
        plan.receipt.applied;
      const ledgerPath = completedImportLedgerPath(projectHome, progress.id);
      const result = {
        appConfigUpdated,
        agentCount: agentSlugs.length,
        integrationCount: integrationIds.length,
        ledgerPath,
        notesPath: plan.notes
          ? ledgerPath.replace(/\.json$/, '.notes.md')
          : undefined,
      };
      if (progress.phase === 'complete') {
        console.log(`  ✓ import already complete: ${ledgerPath}`);
        return result;
      }
      try {
        await writeImportProgress(projectHome, progress);
        for (const [index, effect] of plan.effects.entries()) {
          const step = progress.effects[index];
          if (step.status === 'applied') continue;
          step.status = 'uncertain';
          await writeImportProgress(projectHome, progress);
          await effect.apply();
          step.status = 'applied';
          await writeImportProgress(projectHome, progress);
        }
        progress.phase = 'publishing';
        await writeImportProgress(projectHome, progress);
        await writeImportLedger(
          {
            ...plan.receipt,
            id: progress.id,
            sourcePath: progress.sourcePath,
            importedAt: progress.importedAt,
          },
          plan.notes,
          projectHome,
        );
        progress.phase = 'complete';
        await writeImportProgress(projectHome, progress);
        console.log(
          `  ✓ imported ${basename(sourcePath)} (${agentSlugs.length} agents, ${integrationIds.length} integrations)`,
        );
        return result;
      } catch (cause) {
        throw new Error(
          `Station import did not finish. Inspect it with station import --status before retrying the same file with --resume=${progress.id}.`,
          { cause },
        );
      }
    } finally {
      await release();
    }
  } finally {
    useLease.release();
  }
}
