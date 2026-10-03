import { createHash } from 'node:crypto';
import { closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AgentPluginManifestV1,
  StationAgentPluginExtensionV1,
} from '@kontourai/station-contracts/agent-plugin';
import type { SkillExperienceDefinitionV1 } from '@kontourai/station-contracts/skill-experience';
import { parseWorkspacePaneDescriptor } from '@kontourai/station-contracts/workspace-pane';
import {
  frontmatterToProperties,
  parseFrontmatter,
  validateSkillContent,
} from 'agent-skills-ts-sdk';
import { validateSkillExperience } from './agent-plugin-validators.generated.mjs';
import { openRegularFileSync } from './regular-file.js';

function readAuthorFile(root: string, path: string, maxBytes: number): Buffer {
  let file: number | undefined;
  try {
    const actual = realpathSync(resolve(root, path));
    const local = relative(root, actual);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
      throw new Error('file escapes plugin root');
    const opened = openRegularFileSync(actual);
    if (opened === null) throw new Error('must be a regular file');
    file = opened;
    const stats = fstatSync(file);
    if (!stats.isFile() || stats.size > maxBytes)
      throw new Error(`must be a regular file of at most ${maxBytes} bytes`);
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(file, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new Error(`exceeds ${maxBytes} bytes`);
    return bytes.subarray(0, length);
  } catch (cause) {
    throw new Error(
      `Skill experience file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  } finally {
    if (file !== undefined) closeSync(file);
  }
}

export function isSkillExperienceDefinition(
  value: unknown,
): value is SkillExperienceDefinitionV1 {
  return validateSkillExperience(value);
}

function assertUnique(values: string[], location: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Skill experience ${location}: duplicate identity`);
}

/** Read inert definitions and their bundled Skills; no activation or permission grants. */
export function readValidatedSkillExperiences(
  pluginDir: string,
  manifest: AgentPluginManifestV1,
  extension: StationAgentPluginExtensionV1 | undefined,
): SkillExperienceDefinitionV1[] {
  const definitions: SkillExperienceDefinitionV1[] = [];
  const contributions = extension?.experiences ?? [];
  if (contributions.length === 0) return definitions;
  if (!manifest.version)
    throw new Error('Skill experiences require an owning plugin.json version');
  assertUnique(
    contributions.map((entry) => entry.id),
    'declarations.id',
  );
  assertUnique(
    contributions.map((entry) => entry.source),
    'declarations.source',
  );
  const root = realpathSync(pluginDir);
  for (const contribution of contributions) {
    const bytes = readAuthorFile(root, contribution.source, 64 * 1024);
    let candidate: unknown;
    try {
      candidate = JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
      throw new Error(`Skill experience ${contribution.source}: invalid JSON`, {
        cause,
      });
    }
    if (
      candidate &&
      typeof candidate === 'object' &&
      'inputs' in candidate &&
      Array.isArray(candidate.inputs)
    ) {
      for (const input of candidate.inputs) {
        if (
          input &&
          typeof input === 'object' &&
          typeof input.id === 'string' &&
          ['constructor', 'prototype', '__proto__'].includes(input.id)
        )
          throw new Error(
            `Skill experience ${contribution.source}/inputs/${input.id}: reserved input identity is unsupported`,
          );
      }
    }
    if (!validateSkillExperience(candidate)) {
      const first = validateSkillExperience.errors?.[0];
      throw new Error(
        `Skill experience ${contribution.source}${first?.instancePath || '/'}: ${first?.message ?? 'unsupported definition'}`,
      );
    }
    const definition = candidate as SkillExperienceDefinitionV1;
    const fail = (location: string, message: string): never => {
      throw new Error(
        `Skill experience ${contribution.source}/${location}: ${message}`,
      );
    };
    if (definition.id !== contribution.id)
      fail('id', 'must match its manifest declaration');
    assertUnique(
      definition.skills.map((skill) => skill.id),
      `${contribution.source}/skills.id`,
    );
    assertUnique(
      definition.skills.map((skill) => skill.path),
      `${contribution.source}/skills.path`,
    );
    assertUnique(
      definition.inputs.map((input) => input.id),
      `${contribution.source}/inputs.id`,
    );
    assertUnique(
      definition.outputs.map((output) => output.id),
      `${contribution.source}/outputs.id`,
    );
    assertUnique(
      definition.requiredContext.map((context) => context.kind),
      `${contribution.source}/requiredContext.kind`,
    );
    const skillIds = new Set(definition.skills.map((skill) => skill.id));
    if (definition.entrySkillId && !skillIds.has(definition.entrySkillId))
      fail('entrySkillId', 'must name a bundled Skill');
    assertUnique(
      (definition.transitions ?? []).map((entry) => entry.experienceId),
      `${contribution.source}/transitions.experienceId`,
    );
    for (const skill of definition.skills) {
      if (skill.path !== `./skills/${skill.name}/SKILL.md`)
        fail(
          `skills/${skill.id}/path`,
          'must match the named portable Skill path',
        );
      for (const dependency of skill.dependsOn ?? []) {
        if (!skillIds.has(dependency) || dependency === skill.id)
          fail(
            `skills/${skill.id}/dependsOn`,
            `unknown or self skill reference '${dependency}'`,
          );
      }
      const skillBytes = readAuthorFile(root, skill.path, 1024 * 1024);
      const actual = createHash('sha256').update(skillBytes).digest('hex');
      if (actual !== skill.sha256)
        fail(
          `skills/${skill.id}/sha256`,
          'does not match bundled Skill bytes; review and update the definition',
        );
      const content = skillBytes.toString('utf8');
      const errors = validateSkillContent(content);
      if (errors.length) fail(`skills/${skill.id}/path`, errors.join('; '));
      if (
        frontmatterToProperties(parseFrontmatter(content).metadata).name !==
        skill.name
      )
        fail(
          `skills/${skill.id}/name`,
          'must match the parsed Skill frontmatter name',
        );
    }
    for (const item of [
      ...definition.inputs,
      ...definition.outputs,
      ...definition.requiredContext,
      ...(definition.transitions ?? []),
    ]) {
      if (
        item.provenance.origin === 'skill-declared' &&
        !skillIds.has(item.provenance.skillRef)
      )
        fail(
          'provenance/skillRef',
          `unknown skill reference '${item.provenance.skillRef}'`,
        );
    }
    for (const input of definition.inputs) {
      if (input.kind === 'text') {
        const minimum = input.minLength ?? 0;
        if (minimum > input.maxLength)
          fail(`inputs/${input.id}`, 'minLength exceeds maxLength');
        if (
          input.default !== undefined &&
          (Array.from(input.default).length < minimum ||
            Array.from(input.default).length > input.maxLength)
        )
          fail(
            `inputs/${input.id}/default`,
            'is outside the declared text constraints',
          );
      } else if (input.kind === 'single-choice') {
        assertUnique(
          input.options.map((option) => option.value),
          `${contribution.source}/inputs/${input.id}/options.value`,
        );
        if (
          input.default !== undefined &&
          !input.options.some((option) => option.value === input.default)
        )
          fail(`inputs/${input.id}/default`, 'must name a declared option');
      }
    }
    if (
      !definition.presentation.modes.includes(
        definition.presentation.defaultMode,
      )
    )
      fail('presentation/defaultMode', 'must be included in modes');
    if (
      definition.interaction.questionRounds &&
      definition.interaction.pattern !== 'interview'
    )
      fail(
        'interaction/questionRounds',
        'is supported only for the interview pattern',
      );
    if (definition.presentation.richView) {
      const descriptor = (extension?.workspacePanes ?? [])
        .map(parseWorkspacePaneDescriptor)
        .find(
          (pane) => pane?.id === definition.presentation.richView?.descriptorId,
        );
      if (
        descriptor?.provenance.origin !== 'plugin' ||
        descriptor.provenance.pluginId !== manifest.name ||
        descriptor.renderer.kind !== 'plugin-component'
      )
        fail(
          'presentation/richView',
          'must name a same-package plugin-component Workspace Pane',
        );
    }
    definitions.push(definition);
  }
  const experienceIds = new Set(definitions.map((definition) => definition.id));
  for (const definition of definitions) {
    for (const transition of definition.transitions ?? []) {
      if (!experienceIds.has(transition.experienceId))
        throw new Error(
          `Skill experience ${definition.id}/transitions: unknown local experience '${transition.experienceId}'`,
        );
    }
  }
  return definitions;
}

export function validateAuthoredSkillExperiences(
  pluginDir: string,
  manifest: AgentPluginManifestV1,
  extension: StationAgentPluginExtensionV1 | undefined,
): void {
  readValidatedSkillExperiences(pluginDir, manifest, extension);
}
