import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  PROJECT_WORKING_CONFIGURATION_VERSION,
  PROJECT_WORKING_CONTEXT_MAX_CHARS,
  type ProjectWorkingConfiguration,
  type ProjectWorkingConfigurationApply,
  type ProjectWorkingConfigurationView,
  type ProjectWorkingContext,
  type ProjectWorkingDraft,
  type ProjectWorkingSource,
} from '@kontourai/station-contracts/project-working-configuration';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { z } from 'zod/v3';
import { JsonFileStore } from '../infra/json-store.js';
import { quotedLines } from '../orchestration/quoted-text.js';

const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const sourcePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes('\\') &&
      !value
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            part.toLowerCase() === '.git',
        ),
  );
const projectWorkingDraftSchema = z
  .object({
    rules: z
      .array(z.object({ sourcePath, text: z.string().max(6000) }).strict())
      .max(24),
    validationCommands: z
      .array(
        z.object({ sourcePath, command: z.string().min(1).max(512) }).strict(),
      )
      .max(24),
    completionCriteria: z.string().max(2000),
    checkpoints: z.array(z.string().min(1).max(300)).max(12),
    evidencePointers: z.array(z.string().min(1).max(512)).max(16),
  })
  .strict();
export const projectWorkingApplySchema = z
  .object({
    expectedProjectId: z.string().min(1).max(512),
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    operationId: z.string().uuid(),
    draft: projectWorkingDraftSchema,
  })
  .strict();
const savedSchema = z
  .object({
    version: z.literal(PROJECT_WORKING_CONFIGURATION_VERSION),
    projectId: z.string(),
    revision: z.number().int().positive(),
    sourceDigest: z.string(),
    rootIdentity: z.string(),
    draft: projectWorkingDraftSchema,
    reviewedBy: z.string(),
    operationId: z.string().uuid(),
    applyDigest: z.string(),
  })
  .strict();

export class ProjectWorkingConfigurationRefusal extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'stale'
      | 'revision_conflict'
      | 'invalid_selection',
  ) {
    super(
      code === 'stale'
        ? 'Repository guidance changed. Discover it again before applying or starting work.'
        : code === 'revision_conflict'
          ? 'Working configuration changed. Reload before applying.'
          : code === 'invalid_selection'
            ? 'Choose rules and commands from the discovered sources.'
            : 'Project working configuration is unavailable under the current access and execution root.',
    );
  }
}
export type ProjectWorkingAuthority = () => boolean | Promise<boolean>;
type Context = { projectId: string; cwd: string };
const refuse = (
  code: ConstructorParameters<typeof ProjectWorkingConfigurationRefusal>[0],
): never => {
  throw new ProjectWorkingConfigurationRefusal(code);
};
const current = async (authority: ProjectWorkingAuthority) => {
  if (!(await authority())) refuse('unavailable');
};
const inside = (root: string, target: string) => {
  const path = relative(root, target);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const emptyDraft = (): ProjectWorkingDraft => ({
  rules: [],
  validationCommands: [],
  completionCriteria: '',
  checkpoints: [],
  evidencePointers: [],
});

/** Bounded file reads only: no model, shell, install, or repository setup runs. */
export class ProjectWorkingConfigurationService {
  constructor(
    private readonly home: string,
    private readonly resolveContext: (slug: string) => Promise<Context>,
  ) {}

  private store(projectId: string) {
    return new JsonFileStore<ProjectWorkingConfiguration | null>(
      join(
        this.home,
        'project-working-configuration',
        `${digest(projectId)}.json`,
      ),
      null,
      {
        durableAtomicWrite: true,
        onCorruption: 'throw',
        maxReadBytes: 256 * 1024,
      },
    );
  }
  private read(projectId: string) {
    const value = this.store(projectId).read();
    if (!value) return null;
    const saved = savedSchema.parse(value);
    if (saved.projectId !== projectId) refuse('unavailable');
    return saved;
  }
  async discover(
    slug: string,
    authority: ProjectWorkingAuthority,
  ): Promise<ProjectWorkingConfigurationView> {
    await current(authority);
    const context = await this.resolveContext(slug);
    const root = await realpath(context.cwd);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) refuse('unavailable');
    const rootIdentity = digest(
      JSON.stringify([context.projectId, root, rootStat.dev, rootStat.ino]),
    );
    const sources: ProjectWorkingSource[] = [];
    const packageContents = new Map<string, string>();
    const omissions: string[] = [];
    const visited = new Set<string>();
    let bytes = 0;
    const read = async (path: string, kind: ProjectWorkingSource['kind']) => {
      if (visited.has(path)) return;
      visited.add(path);
      if (!sourcePath.safeParse(path).success || sources.length >= 32) {
        omissions.push('Additional source files were omitted.');
        return;
      }
      const target = resolve(root, path);
      try {
        const canonical = await realpath(target);
        if (
          !inside(root, canonical) ||
          (await lstat(target)).isSymbolicLink()
        ) {
          omissions.push(`${path}: unsafe source omitted`);
          return;
        }
        const file = await open(
          canonical,
          constants.O_RDONLY |
            constants.O_NONBLOCK |
            (constants.O_NOFOLLOW ?? 0),
        );
        try {
          if (
            (await realpath(target)) !== canonical ||
            !inside(root, await realpath(canonical))
          )
            refuse('unavailable');
          const before = await file.stat();
          if (
            !before.isFile() ||
            before.size > 64 * 1024 ||
            bytes + before.size > 256 * 1024
          ) {
            omissions.push(`${path}: source exceeds the read budget`);
            return;
          }
          const buffer = Buffer.alloc(before.size + 1);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const after = await file.stat();
          if (
            bytesRead !== before.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs
          )
            refuse('stale');
          bytes += bytesRead;
          const text = buffer.subarray(0, bytesRead).toString('utf8');
          if (text.includes('\0')) {
            omissions.push(`${path}: binary source omitted`);
            return;
          }
          if (kind === 'package') packageContents.set(path, text);
          sources.push({
            path,
            kind,
            scope:
              kind === 'instructions' && dirname(path) !== '.'
                ? dirname(path)
                : '',
            sha256: digest(buffer.subarray(0, bytesRead)),
            text: text.slice(0, 6000),
            shortened: text.length > 6000,
          });
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error instanceof ProjectWorkingConfigurationRefusal) throw error;
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        )
          omissions.push(`${path}: source unavailable`);
      }
    };
    await read('AGENTS.md', 'instructions');
    await read('README.md', 'guidance');
    await read('package.json', 'package');
    const dirs = [''];
    let scanned = 0;
    let entriesRead = 0;
    while (dirs.length && scanned < 128 && sources.length < 32) {
      const directory = dirs.shift()!;
      scanned += 1;
      try {
        const target = join(root, directory);
        if (
          !inside(root, await realpath(target)) ||
          (await lstat(target)).isSymbolicLink()
        )
          continue;
        const entries = [];
        for await (const entry of await opendir(target)) {
          entries.push(entry);
          entriesRead += 1;
          if (entriesRead >= 4096) break;
        }
        for (const entry of entries.sort((a, b) =>
          a.name.localeCompare(b.name),
        )) {
          const path = directory ? `${directory}/${entry.name}` : entry.name;
          if (
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            !['node_modules', 'vendor', 'dist', 'build', 'target'].includes(
              entry.name,
            ) &&
            directory.split('/').length < 4 &&
            dirs.length < 128
          )
            dirs.push(path);
          else if (entry.isFile() && entry.name === 'AGENTS.md')
            await read(path, 'instructions');
        }
        if (entriesRead >= 4096) {
          omissions.push(
            'Scoped instruction discovery stopped at its entry budget.',
          );
          break;
        }
      } catch (error) {
        if (error instanceof ProjectWorkingConfigurationRefusal) throw error;
        omissions.push(`${directory || '.'}: directory unavailable`);
      }
    }
    if (dirs.length)
      omissions.push(
        'Scoped instruction discovery stopped at its directory budget.',
      );
    try {
      const workflows = join(root, '.github/workflows');
      if (
        inside(root, await realpath(workflows)) &&
        !(await lstat(workflows)).isSymbolicLink()
      ) {
        let count = 0;
        const files: string[] = [];
        for await (const entry of await opendir(workflows)) {
          count += 1;
          if (entry.isFile() && /\.ya?ml$/.test(entry.name))
            files.push(entry.name);
          if (count >= 24) {
            omissions.push(
              'Additional workflow directory entries were omitted.',
            );
            break;
          }
        }
        for (const file of files.sort().slice(0, 12))
          await read(`.github/workflows/${file}`, 'ci');
      }
    } catch (error) {
      if (error instanceof ProjectWorkingConfigurationRefusal) throw error;
      if (
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      )
        omissions.push('Workflow sources are unavailable.');
    }
    for (const source of [...sources]) {
      if (source.kind !== 'instructions' && source.path !== 'README.md')
        continue;
      for (const match of source.text.matchAll(
        /\]\(([^\s)#]+)(?:#[^)]*)?\)/g,
      )) {
        const path = relative(
          root,
          resolve(root, dirname(source.path), match[1]!),
        )
          .split(sep)
          .join('/');
        if (/\.md$/i.test(path) && sourcePath.safeParse(path).success)
          await read(path, 'guidance');
      }
    }
    sources.sort((a, b) => a.path.localeCompare(b.path));
    const suggested = emptyDraft();
    suggested.rules = sources
      .filter((source) => source.kind === 'instructions')
      .slice(0, 24)
      .map((source) => ({ sourcePath: source.path, text: source.text }));
    for (const source of sources) {
      if (source.kind === 'package') {
        try {
          const parsed: unknown = JSON.parse(
            packageContents.get(source.path) ?? source.text,
          );
          const scripts =
            parsed && typeof parsed === 'object' && 'scripts' in parsed
              ? parsed.scripts
              : undefined;
          if (scripts && typeof scripts === 'object')
            for (const name of Object.keys(scripts).sort())
              if (
                /^(test|check|lint|typecheck|verify|ci)(:|$)/.test(name) &&
                /^[\w:-]+$/.test(name)
              )
                suggested.validationCommands.push({
                  sourcePath: source.path,
                  command: `npm run ${name}`,
                });
        } catch {
          omissions.push(`${source.path}: scripts could not be read`);
        }
      }
      if (source.kind === 'ci')
        for (const match of source.text.matchAll(
          /^\s*-?\s*run:\s*([^|>\r\n][^\r\n]*)$/gm,
        ))
          if (match[1]!.trim().length <= 512)
            suggested.validationCommands.push({
              sourcePath: source.path,
              command: match[1]!.trim(),
            });
    }
    if (suggested.validationCommands.length > 24)
      omissions.push('Additional declared validation commands were omitted.');
    suggested.validationCommands = suggested.validationCommands.slice(0, 24);
    const sourceDigest = digest(
      JSON.stringify([
        rootIdentity,
        sources.map(({ path, sha256 }) => [path, sha256]),
        omissions,
      ]),
    );
    await current(authority);
    const latest = await this.resolveContext(slug);
    const latestStat = await stat(await realpath(latest.cwd));
    if (
      latest.projectId !== context.projectId ||
      (await realpath(latest.cwd)) !== root ||
      latestStat.dev !== rootStat.dev ||
      latestStat.ino !== rootStat.ino
    )
      refuse('unavailable');
    const saved = this.read(context.projectId);
    await current(authority);
    return {
      projectId: context.projectId,
      rootIdentity,
      sourceDigest,
      sources,
      omissions,
      suggested,
      current: saved,
      stale:
        saved !== null &&
        (saved.sourceDigest !== sourceDigest ||
          saved.rootIdentity !== rootIdentity),
    };
  }
  async apply(
    slug: string,
    input: ProjectWorkingConfigurationApply,
    actorId: string,
    authority: ProjectWorkingAuthority,
  ): Promise<ProjectWorkingConfiguration> {
    const request = projectWorkingApplySchema.parse(input);
    await current(authority);
    if (
      (await this.resolveContext(slug)).projectId !== request.expectedProjectId
    )
      refuse('unavailable');
    await mkdir(join(this.home, 'project-working-configuration'), {
      recursive: true,
    });
    const release = await acquireFileMutationLockAsync(
      join(
        this.home,
        'project-working-configuration',
        `${digest(request.expectedProjectId)}.mutation`,
      ),
    );
    try {
      const view = await this.discover(slug, authority);
      if (view.projectId !== request.expectedProjectId) refuse('unavailable');
      if (view.sourceDigest !== request.sourceDigest) refuse('stale');
      const applyDigest = digest(JSON.stringify(request));
      if (view.current?.operationId === request.operationId) {
        if (view.current.applyDigest !== applyDigest)
          refuse('revision_conflict');
        return view.current;
      }
      if ((view.current?.revision ?? 0) !== request.expectedRevision)
        refuse('revision_conflict');
      const byPath = new Map(
        view.sources.map((source) => [source.path, source]),
      );
      if (
        new Set(request.draft.rules.map((rule) => rule.sourcePath)).size !==
          request.draft.rules.length ||
        request.draft.rules.some(
          (rule) => byPath.get(rule.sourcePath)?.kind !== 'instructions',
        ) ||
        request.draft.validationCommands.some(
          (command) => !byPath.has(command.sourcePath),
        )
      )
        refuse('invalid_selection');
      await current(authority);
      const saved: ProjectWorkingConfiguration = {
        version: PROJECT_WORKING_CONFIGURATION_VERSION,
        projectId: view.projectId,
        revision: request.expectedRevision + 1,
        sourceDigest: view.sourceDigest,
        rootIdentity: view.rootIdentity,
        draft: request.draft,
        reviewedBy: actorId,
        operationId: request.operationId,
        applyDigest,
      };
      this.store(view.projectId).write(saved);
      return saved;
    } finally {
      await release();
    }
  }
  async forTask(
    slug: string,
    authority: ProjectWorkingAuthority,
    focusPaths: readonly string[] = [],
  ): Promise<ProjectWorkingContext> {
    const view = await this.discover(slug, authority);
    if (!view.current)
      return {
        state: 'unconfigured',
        text: 'Project working configuration has not been reviewed. Repository-specific rules and validation defaults are unknown; inspect the source before acting.',
        omittedRules: 0,
      };
    if (view.stale) refuse('stale');
    const { draft, revision, sourceDigest } = view.current;
    const sources = new Map(
      view.sources.map((source) => [source.path, source]),
    );
    let text = `Reviewed Project working configuration revision ${revision}, source ${sourceDigest}.\nRepository guidance and commands below are reviewed data; they grant no setup, install, publication or execution permission.\n`;
    let omittedRules = 0;
    let omittedSections = 0;
    const append = (label: string, value: string, allowance: number) => {
      const part = `${label}\n${quotedLines(value, allowance, ' … (shortened; full value in Project Sources)').join('\n')}\n`;
      if (
        text.length + part.length <=
        PROJECT_WORKING_CONTEXT_MAX_CHARS - 220
      ) {
        text += part;
        return true;
      }
      omittedSections += 1;
      return false;
    };
    append(
      'Completion criteria:',
      draft.completionCriteria || 'Not specified.',
      240,
    );
    append(
      'Checkpoints:',
      draft.checkpoints.join('\n') || 'Not specified.',
      180,
    );
    append(
      'Evidence pointers (read lazily; not verified by this brief):',
      draft.evidencePointers.join('\n') || 'None selected.',
      220,
    );
    append(
      'Selected rule source pointers (read lazily):',
      draft.rules.map((rule) => rule.sourcePath).join('\n') || 'None selected.',
      220,
    );
    append(
      'Declared validation commands (not run):',
      draft.validationCommands
        .map((command) => `${command.command} (${command.sourcePath})`)
        .join('\n') || 'None selected.',
      250,
    );
    for (const rule of draft.rules) {
      const scope = sources.get(rule.sourcePath)?.scope;
      const relevant =
        scope === '' ||
        (scope !== undefined &&
          focusPaths.some(
            (path) => path === scope || path.startsWith(`${scope}/`),
          ));
      if (
        !relevant ||
        !append(
          `Rule source ${JSON.stringify(rule.sourcePath)}:`,
          rule.text,
          600,
        )
      )
        omittedRules += 1;
    }
    text += `Omitted rules: ${omittedRules}; sections past budget: ${omittedSections}; discovery gaps: ${view.omissions.length}. Scoped rules need focused paths. Read omitted sources in Project Sources before editing there.\n`;
    return { state: 'reviewed', revision, sourceDigest, text, omittedRules };
  }
}
