import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { SkillExperienceInventoryV1 } from '@kontourai/station-contracts/skill-experience';
import { afterEach, expect, test } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { SkillService } from '../../../services/agents/skill-service.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { AgentPluginLoader } from '../../../services/plugins/agent-plugin-loader.js';
import {
  pluginActivationDescriptorDigest,
  verifyPluginActivation,
} from '../../../services/plugins/plugin-activation-plan.js';
import { computePluginContentDigest } from '../../../services/plugins/plugin-content-integrity.js';
import { createLocalPluginInstallationService } from '../../../services/plugins/plugin-installation-local.js';
import { readPluginManifestFile } from '../../../services/plugins/plugin-manifest-loader.js';
import { createSkillRoutes } from '../skills.js';

const scratch: Array<{ home: string; store: EventStore }> = [];
afterEach(() => {
  for (const { home, store } of scratch.splice(0)) {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});

async function installedExperience(change?: (source: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'station-experience-route-'));
  const source = join(home, 'source');
  cpSync(resolve('examples/visual-skill-experience'), source, {
    recursive: true,
  });
  change?.(source);
  const plugins = join(home, 'plugins');
  mkdirSync(plugins);
  const store = new EventStore(join(home, 'events.sqlite'));
  scratch.push({ home, store });
  const journal = store.createPackageMcpAdmissionJournal();
  const manifest = await readPluginManifestFile(join(source, 'plugin.json'));
  const pluginId = manifest.name;
  const digest = computePluginContentDigest(dirname(source), basename(source))!;
  await createLocalPluginInstallationService(plugins, journal, source).install({
    installation: pluginId,
    expected: null,
    artifact: { digest },
    origin: 'b'.repeat(64),
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      sourceDigest: digest,
      descriptorDigest: pluginActivationDescriptorDigest(manifest),
      origin: 'b'.repeat(64),
      consent: { kind: 'no-operator-decision', caller: 'experience-fixture' },
      previous: null,
      agents: [],
      ownedDependencies: [],
    },
  });
  const loader = new AgentPluginLoader({
    projectHomeDir: home,
    journal: () => journal,
  });
  const config = new ConfigLoader({ projectHomeDir: home });
  const logger = { info() {}, warn() {}, debug() {} };
  const skills = new SkillService(config, logger, {
    canonicalSources: () => loader.skillSources(),
    experienceInventory: () => loader.listSkillExperiences(),
  });
  const routes = createSkillRoutes(skills, () => home);
  const current = journal.currentInstallation(pluginId);
  if (current.state !== 'observed') throw new Error('Installation missing');
  const installation = current.installation;
  async function inventory(rediscover = true) {
    if (rediscover) await skills.discoverSkills(home);
    const response = await routes.request('/experiences');
    expect(response.status).toBe(200);
    const result: { success: boolean; data: SkillExperienceInventoryV1 } =
      await readJson(response);
    expect(result.success).toBe(true);
    return result.data;
  }
  async function activate() {
    const permit = journal.claimActivation(installation);
    await verifyPluginActivation(permit, journal, async () => {});
    expect(journal.completeActivation(permit)).toEqual({ state: 'applied' });
  }
  return {
    home,
    source,
    plugins,
    pluginId,
    loader,
    skills,
    journal,
    installation,
    inventory,
    activate,
  };
}

test('the real skill route publishes installed definitions only after activation and withdraws them on retirement', async () => {
  const fixture = await installedExperience();
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
  await fixture.activate();
  const available = await fixture.inventory();
  expect(available.diagnostics).toEqual([]);
  expect(available.experiences).toHaveLength(1);
  expect(available.experiences[0]).toMatchObject({
    identity: {
      pluginId: 'visual-skill-experience',
      pluginVersion: '1.0.0',
      experienceId: 'stress-test-idea',
      incarnation: fixture.installation.incarnation,
      materialization: fixture.installation.materialization,
      contentDigest: fixture.installation.contentDigest,
    },
    definition: {
      title: 'Stress-test an idea',
      skills: [{ name: 'stress-test-idea' }],
    },
  });
  expect(available.experiences[0]!.identity.definitionDigest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(fixture.journal.requestRetirement(fixture.installation).state).toBe(
    'fenced',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});

test('changed installed bytes cannot reuse catalog availability', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  const available = await fixture.inventory();
  expect(available.experiences).toHaveLength(1);
  const root = fixture.loader.listInstalled()[0]!.root;
  writeFileSync(
    join(root, 'skills/stress-test-idea/SKILL.md'),
    'Changed after admission',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});

test.each(['digest', 'dependency', 'version', 'escape'] as const)(
  'an admitted package with a %s error cannot publish a visual definition',
  async (failure) => {
    const fixture = await installedExperience((source) => {
      const path = join(
        source,
        'io.kontourai.station/experiences/stress-test-idea.json',
      );
      const definition = JSON.parse(readFileSync(path, 'utf8'));
      if (failure === 'digest') definition.skills[0].sha256 = '0'.repeat(64);
      if (failure === 'dependency')
        definition.skills[0].dependsOn = ['missing'];
      if (failure === 'version') definition.schemaVersion = '2.0';
      if (failure === 'escape') {
        const skill = join(source, 'skills/stress-test-idea/SKILL.md');
        const outside = join(dirname(source), 'outside.md');
        writeFileSync(outside, readFileSync(skill));
        rmSync(skill);
        symlinkSync(outside, skill);
      }
      writeFileSync(path, JSON.stringify(definition));
    });
    await fixture.activate();
    const result = await fixture.inventory();
    expect(result.experiences).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: 'definition-invalid' }),
    ]);
    if (failure !== 'escape') {
      await fixture.skills.discoverSkills(fixture.home);
      expect(fixture.skills.listSkills().map((skill) => skill.name)).toContain(
        'stress-test-idea',
      );
    }
  },
);

test('an ordinary third-party package is discoverable without a renderer allowlist', async () => {
  const fixture = await installedExperience((source) => {
    const path = join(source, 'plugin.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.name = 'independent-author-tools';
    writeFileSync(path, JSON.stringify(manifest));
  });
  await fixture.activate();
  expect((await fixture.inventory()).experiences[0]?.identity.pluginId).toBe(
    'independent-author-tools',
  );
});

test('a local Skill override makes the pinned experience unavailable without rebinding its identity', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  expect((await fixture.inventory()).experiences).toHaveLength(1);
  const directory = join(fixture.home, 'skills/stress-test-idea');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    '---\nname: stress-test-idea\ndescription: Local alternative\n---\nDifferent instructions.',
  );
  expect(await fixture.inventory()).toMatchObject({
    experiences: [],
    diagnostics: [
      { code: 'unavailable', message: expect.stringContaining('overridden') },
    ],
  });
});

test('same-version replacement cannot publish against the previous discovered Skill generation', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  const old = (await fixture.inventory()).experiences[0]!.identity;
  const definitionPath = join(
    fixture.source,
    'io.kontourai.station/experiences/stress-test-idea.json',
  );
  const definition = JSON.parse(readFileSync(definitionPath, 'utf8'));
  definition.title = 'Updated interview';
  writeFileSync(definitionPath, JSON.stringify(definition));
  const service = createLocalPluginInstallationService(
    fixture.plugins,
    fixture.journal,
    fixture.source,
  );
  const previous = await service.inspect(fixture.pluginId);
  const manifest = await readPluginManifestFile(
    join(fixture.source, 'plugin.json'),
  );
  const digest = computePluginContentDigest(
    dirname(fixture.source),
    basename(fixture.source),
  )!;
  await service.install({
    installation: fixture.pluginId,
    expected: previous,
    artifact: { digest },
    origin: 'b'.repeat(64),
    activationPlan: {
      version: 1,
      artifactDigest: digest,
      sourceDigest: digest,
      descriptorDigest: pluginActivationDescriptorDigest(manifest),
      origin: 'b'.repeat(64),
      consent: { kind: 'no-operator-decision', caller: 'experience-fixture' },
      previous,
      agents: [],
      ownedDependencies: [],
    },
  });
  const current = fixture.journal.currentInstallation(fixture.pluginId);
  if (current.state !== 'observed') throw new Error('Replacement missing');
  const permit = fixture.journal.claimActivation(current.installation);
  await verifyPluginActivation(permit, fixture.journal, async () => {});
  expect(fixture.journal.completeActivation(permit)).toEqual({
    state: 'applied',
  });
  expect(await fixture.inventory(false)).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
  const refreshed = (await fixture.inventory()).experiences[0]!;
  expect(refreshed.definition.title).toBe('Updated interview');
  expect(refreshed.identity.incarnation).not.toBe(old.incarnation);
  expect(refreshed.identity.materialization).not.toBe(old.materialization);
});

test('corrupt selected package manifests remain a named refusal instead of disappearing from discovery', async () => {
  const fixture = await installedExperience();
  await fixture.activate();
  const root = fixture.loader.listInstalled()[0]!.root;
  writeFileSync(join(root, 'plugin.json'), '{');
  expect(await fixture.inventory(false)).toMatchObject({
    experiences: [],
    diagnostics: [{ pluginId: fixture.pluginId, code: 'unavailable' }],
  });
});

test('journal-observed legacy packages cannot invent managed materialization identity', async () => {
  const home = mkdtempSync(join(tmpdir(), 'station-experience-legacy-'));
  const root = join(home, 'plugins/visual-skill-experience');
  cpSync(resolve('examples/visual-skill-experience'), root, {
    recursive: true,
  });
  const store = new EventStore(join(home, 'events.sqlite'));
  scratch.push({ home, store });
  const journal = store.createPackageMcpAdmissionJournal();
  const recorded = journal.recordInstallation({
    pluginId: 'visual-skill-experience',
    contentDigest: computePluginContentDigest(dirname(root), basename(root))!,
    previous: null,
  });
  if (recorded.state !== 'recorded')
    throw new Error('Legacy fixture not recorded');
  expect(journal.admissionOpen(recorded.installation)).toBe(true);
  const loader = new AgentPluginLoader({
    projectHomeDir: home,
    journal: () => journal,
  });
  const skills = new SkillService(
    new ConfigLoader({ projectHomeDir: home }),
    { info() {}, warn() {}, debug() {} },
    {
      canonicalSources: () => loader.skillSources(),
      experienceInventory: () => loader.listSkillExperiences(),
    },
  );
  await skills.discoverSkills(home);
  const response = await createSkillRoutes(skills, () => home).request(
    '/experiences',
  );
  expect(response.status).toBe(200);
  const body = await readJson<{ data: SkillExperienceInventoryV1 }>(response);
  expect(body.data).toMatchObject({
    experiences: [],
    diagnostics: [{ code: 'unavailable' }],
  });
});
