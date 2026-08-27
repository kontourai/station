/**
 * The Playbooks→Skills pass, composed for a one-shot process.
 *
 * `station doctor --migrate-playbooks` runs with no Station server, so it
 * assembles the same seams the boot path uses out of their free-function form:
 * `loadSkillConfig`/`saveSkillConfig` behind a `SkillService`, and
 * `config-loader-agents`' own load/save (which carry the identity and schema
 * refusals) as the agent port. Nothing here re-implements a write — a second
 * writer for the same files is exactly what this migration exists to remove.
 *
 * A full `ConfigLoader` is deliberately NOT constructed: it starts filesystem
 * watchers and pollers a one-shot report has no use for, and would have to be
 * disposed to let the process exit.
 */
import {
  listAgentConfigs,
  loadAgentConfig,
  mutateAgentConfig,
} from '../../domain/config-loader-agents.js';
import {
  loadSkillConfig,
  saveSkillConfig,
} from '../../domain/config-loader-storage.js';
import {
  migratePlaybooksToSkills,
  type PlaybookSkillMigrationReport,
} from './playbook-skill-migration.js';
import { SkillService } from './skill-service.js';

export async function runPlaybookSkillMigrationForHome(
  homeDir: string,
  dryRun: boolean,
): Promise<PlaybookSkillMigrationReport> {
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
  };
  const configLoader = {
    getProjectHomeDir: () => homeDir,
    loadSkill: (name: string) => loadSkillConfig(homeDir, name),
    saveSkill: (name: string, config: never) =>
      saveSkillConfig(homeDir, name, config),
  };
  const skillService = new SkillService(configLoader as never, logger);
  // The pass reserves names against what is already installed, so discovery
  // has to have run — otherwise every collision check compares against nothing.
  await skillService.discoverSkills(homeDir);

  return migratePlaybooksToSkills({
    homeDir,
    skills: {
      listSkills: () => skillService.listSkills(),
      createLocalSkill: (input, projectHomeDir) =>
        skillService.createLocalSkill(input, projectHomeDir),
      completeInterruptedLocalSkillPackage: (
        input,
        expectedIdentity,
        projectHomeDir,
      ) =>
        skillService.completeInterruptedLocalSkillPackage(
          input,
          expectedIdentity,
          projectHomeDir,
        ),
      adoptSkillStats: (name, stats) =>
        skillService.adoptSkillStats(name, stats),
    },
    agents: {
      listAgents: async () =>
        (await listAgentConfigs(homeDir)).map((agent) => ({
          slug: agent.slug,
        })),
      loadAgent: async (slug) =>
        (await loadAgentConfig(homeDir, slug)) as unknown as Record<
          string,
          unknown
        >,
      // The locked read-derive-write updater, the same one the server uses.
      mutateAgent: async (slug, updater) =>
        (await mutateAgentConfig(
          homeDir,
          slug,
          updater as never,
        )) as unknown as Record<string, unknown> | null,
    },
    logger,
    dryRun,
  });
}
