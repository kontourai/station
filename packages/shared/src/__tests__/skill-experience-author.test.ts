import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentPluginManifestV1 } from '@kontourai/station-contracts/agent-plugin';
import type { SkillExperienceDefinitionV1 } from '@kontourai/station-contracts/skill-experience';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import { parseAgentPluginManifest } from '../agent-plugin-manifest.js';
import { buildPlugin } from '../build.js';

const exampleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../examples/visual-skill-experience',
);
const definitionPath = 'io.kontourai.station/experiences/stress-test-idea.json';
const makeTempDir = trackTempDirs();

function authorPackage() {
  const root = makeTempDir('station-experience-author-');
  const plugin = join(root, 'plugin');
  cpSync(exampleRoot, plugin, { recursive: true });
  const definition: SkillExperienceDefinitionV1 = JSON.parse(
    readFileSync(join(plugin, definitionPath), 'utf8'),
  );
  const manifest: AgentPluginManifestV1 = JSON.parse(
    readFileSync(join(plugin, 'plugin.json'), 'utf8'),
  );
  return {
    root,
    plugin,
    definition,
    manifest,
    writeDefinition: (value: unknown) =>
      writeFileSync(join(plugin, definitionPath), JSON.stringify(value)),
    writeManifest: () =>
      writeFileSync(join(plugin, 'plugin.json'), JSON.stringify(manifest)),
  };
}

describe('visual Skill author build contract', () => {
  test('validates the handwritten package and every supported input kind before a no-bundle build', async () => {
    const authored = authorPackage();
    await expect(buildPlugin(authored.plugin)).resolves.toEqual({
      built: false,
    });
    authored.definition.inputs.push(
      {
        id: 'depth',
        kind: 'single-choice',
        label: 'Depth',
        required: false,
        default: 'brief',
        options: [{ value: 'brief', label: 'Brief' }],
        provenance: {
          origin: 'reviewer-inferred',
          explanation: 'Optional initial preference.',
        },
      },
      {
        id: 'attachments',
        kind: 'attachments',
        label: 'Supporting notes',
        required: false,
        maxCount: 2,
        provenance: {
          origin: 'station-added',
          explanation: 'Optional supporting documents.',
        },
      },
    );
    authored.writeDefinition(authored.definition);
    await expect(buildPlugin(authored.plugin)).resolves.toEqual({
      built: false,
    });
  });

  test.each([
    ['schema version', { schemaVersion: '2.0' }, /schemaVersion.*constant/],
    [
      'unknown required input component',
      {
        inputs: [
          {
            id: 'x',
            kind: 'executable',
            label: 'Run',
            required: true,
            provenance: {
              origin: 'station-added',
              explanation: 'Unknown component.',
            },
          },
        ],
      },
      /inputs\/0/,
    ],
    [
      'undeclared skill reference',
      {
        inputs: [
          {
            id: 'x',
            kind: 'text',
            label: 'Idea',
            required: true,
            maxLength: 100,
            provenance: {
              origin: 'skill-declared',
              skillRef: 'missing',
              explanation: 'Bad reference.',
            },
          },
        ],
      },
      /unknown skill reference 'missing'/,
    ],
    ['missing skill declaration', { skills: [] }, /skills.*fewer than 1/],
    [
      'identity conflict',
      { id: 'different' },
      /id.*match its manifest declaration/,
    ],
    [
      'default mode conflict',
      { presentation: { modes: ['alongside'], defaultMode: 'guided' } },
      /defaultMode.*included in modes/,
    ],
    [
      'text default outside constraints',
      {
        inputs: [
          {
            id: 'x',
            kind: 'text',
            label: 'Idea',
            required: true,
            minLength: 3,
            maxLength: 5,
            default: 'too long',
            provenance: {
              origin: 'station-added',
              explanation: 'Bad default.',
            },
          },
        ],
      },
      /inputs\/x\/default.*outside/,
    ],
    [
      'choice default outside options',
      {
        inputs: [
          {
            id: 'x',
            kind: 'single-choice',
            label: 'Depth',
            required: false,
            default: 'missing',
            options: [{ value: 'brief', label: 'Brief' }],
            provenance: {
              origin: 'station-added',
              explanation: 'Bad default.',
            },
          },
        ],
      },
      /inputs\/x\/default.*declared option/,
    ],
    ['arbitrary code field', { execute: 'run this' }, /additional properties/],
    [
      'escaping skill path',
      {
        skills: [
          {
            id: 'interview',
            name: 'stress-test-idea',
            path: './skills/../../outside/SKILL.md',
            sha256: '0'.repeat(64),
          },
        ],
      },
      /skills\/0\/path/,
    ],
  ])('refuses %s with an author diagnostic', async (_name, delta, expected) => {
    const authored = authorPackage();
    authored.writeDefinition({ ...authored.definition, ...delta });
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(expected);
  });

  test('refuses duplicate contributions and missing owning package version', async () => {
    const authored = authorPackage();
    const extension = authored.manifest.extensions!['io.kontourai.station']!;
    extension.experiences!.push({ ...extension.experiences![0] });
    authored.writeManifest();
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /declarations.id.*duplicate/,
    );
    extension.experiences!.pop();
    delete authored.manifest.version;
    authored.writeManifest();
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /owning plugin.json version/,
    );
  });

  test('binds portable Skill names, dependencies and actual content bytes', async () => {
    const authored = authorPackage();
    const skill = authored.definition.skills[0];
    skill.name = 'different';
    authored.writeDefinition(authored.definition);
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /named portable Skill path/,
    );
    skill.name = 'stress-test-idea';
    skill.dependsOn = ['missing'];
    authored.writeDefinition(authored.definition);
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /unknown or self skill reference 'missing'/,
    );
    delete skill.dependsOn;
    authored.writeDefinition(authored.definition);
    writeFileSync(
      join(authored.plugin, skill.path),
      'Changed skill instructions.',
    );
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /sha256.*does not match bundled Skill bytes/,
    );
  });

  test('rejects matching-digest Skills with an undiscoverable frontmatter identity or invalid content', async () => {
    const authored = authorPackage();
    const skill = authored.definition.skills[0];
    for (const [content, expected] of [
      [
        '---\nname: other-skill\ndescription: A valid skill with another identity.\n---\nAsk the user a question.',
        /parsed Skill frontmatter name/,
      ],
      ['No required Skill frontmatter.', /skills\/interview\/path/],
    ] as const) {
      writeFileSync(join(authored.plugin, skill.path), content);
      skill.sha256 = createHash('sha256').update(content).digest('hex');
      authored.writeDefinition(authored.definition);
      await expect(buildPlugin(authored.plugin)).rejects.toThrow(expected);
    }
  });

  test('refuses missing or oversized definition files instead of claiming a successful empty build', async () => {
    const authored = authorPackage();
    await rm(join(authored.plugin, definitionPath));
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /Skill experience file.*ENOENT/,
    );
    writeFileSync(
      join(authored.plugin, definitionPath),
      ' '.repeat(64 * 1024 + 1),
    );
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      /at most 65536 bytes/,
    );
  });

  test.each(['definition', 'skill'])(
    'refuses physically escaping %s files',
    async (target) => {
      const authored = authorPackage();
      const path =
        target === 'definition'
          ? definitionPath
          : authored.definition.skills[0].path;
      const outside = join(authored.root, 'outside');
      cpSync(join(authored.plugin, path), outside);
      await rm(join(authored.plugin, path));
      symlinkSync(outside, join(authored.plugin, path));
      await expect(buildPlugin(authored.plugin)).rejects.toThrow(
        /file escapes plugin root/,
      );
    },
  );

  test.skipIf(process.platform === 'win32').each(['definition', 'skill'])(
    'refuses a FIFO %s without blocking the author build',
    async (target) => {
      const authored = authorPackage();
      const script = `
        import { buildPlugin } from ${JSON.stringify(new URL('../build.ts', import.meta.url).href)};
        try {
          await buildPlugin(process.argv[1]);
          process.stdout.write('validated');
        } catch (error) {
          process.stderr.write(String(error));
          process.exitCode = 1;
        }
      `;
      const args = [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        script,
        authored.plugin,
      ];
      const started = Date.now();
      const baseline = spawnSync(process.execPath, args, {
        cwd: resolve(exampleRoot, '../..'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
      });
      const baselineMs = Date.now() - started;
      expect(baseline.error).toBeUndefined();
      expect(baseline.status).toBe(0);
      expect(baseline.stdout).toBe('validated');
      const path =
        target === 'definition'
          ? definitionPath
          : authored.definition.skills[0].path;
      await rm(join(authored.plugin, path));
      execFileSync('mkfifo', [join(authored.plugin, path)], {
        windowsHide: true,
        timeout: 10_000,
      });
      // Startup is observed in the same test; a hung synchronous open must
      // fail the child instead of hanging Vitest's own worker.
      const result = spawnSync(process.execPath, args, {
        cwd: resolve(exampleRoot, '../..'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: Math.max(5_000, baselineMs * 8),
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `Skill experience file ${target === 'definition' ? `./${definitionPath}` : path}: must be a regular file`,
      );
    },
    30_000,
  );

  test('refuses unknown contribution versions and traversal while preserving the portable manifest boundary', async () => {
    const authored = authorPackage();
    const namespace = authored.manifest.extensions!['io.kontourai.station']!;
    for (const declaration of [
      { version: '2.0', id: 'stress-test-idea', source: `./${definitionPath}` },
      {
        version: '1.0',
        id: 'stress-test-idea',
        source: './io.kontourai.station/experiences/../../outside.json',
      },
    ]) {
      const manifest = {
        ...authored.manifest,
        extensions: {
          'io.kontourai.station': { ...namespace, experiences: [declaration] },
        },
      };
      writeFileSync(
        join(authored.plugin, 'plugin.json'),
        JSON.stringify(manifest),
      );
      await expect(buildPlugin(authored.plugin)).rejects.toThrow(
        /Invalid Station extension/,
      );
      const reports: string[] = [];
      const portable = parseAgentPluginManifest(manifest, (report) =>
        reports.push(report.code),
      );
      expect(portable?.manifest.name).toBe('visual-skill-experience');
      expect(portable?.stationExtension).toBeUndefined();
      expect(reports).toContain('station-extension-invalid');
    }
    const otherClient = parseAgentPluginManifest({
      ...authored.manifest,
      extensions: { 'org.example.client': { experiences: 'opaque' } },
    });
    expect(otherClient?.manifest.name).toBe('visual-skill-experience');
    expect(otherClient?.stationExtension).toBeUndefined();
  });
});

test('a separately authored rich pane package builds without a Station component allowlist and rejects cross-package pane linkage', async () => {
  const root = makeTempDir('station-rich-experience-author-');
  const plugin = join(root, 'plugin');
  cpSync(resolve('examples/rich-skill-experience'), plugin, {
    recursive: true,
  });
  await expect(buildPlugin(plugin)).resolves.toMatchObject({ built: true });
  const definition: SkillExperienceDefinitionV1 = JSON.parse(
    readFileSync(join(plugin, definitionPath), 'utf8'),
  );
  definition.presentation.richView!.descriptorId =
    'pane:plugin%3Aanother-package:interview:review';
  writeFileSync(join(plugin, definitionPath), JSON.stringify(definition));
  await expect(buildPlugin(plugin)).rejects.toThrow(
    /same-package plugin-component Workspace Pane/,
  );
});

test.each(['constructor', 'prototype', '__proto__'])(
  'author build refuses reserved input id %s before publishing a declaration the wire parser cannot start',
  async (id) => {
    const authored = authorPackage();
    const input = authored.definition.inputs[0]!;
    if (input.kind !== 'text') throw new Error('Expected original text input');
    input.id = id;
    input.required = false;
    input.default = 'A declared default';
    authored.writeDefinition(authored.definition);
    await expect(buildPlugin(authored.plugin)).rejects.toThrow(
      `inputs/${id}: reserved input identity`,
    );
  },
);
