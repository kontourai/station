import { mkdir, rm, stat, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { prepareManagedEngineWorkspace } from '../../infra/managed-engine-workspace.js';
import {
  isStationChatFolder,
  prepareNoProjectChatScratch,
} from '../no-project-chat-folder.js';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    platform: vi.fn(actual.platform),
    homedir: vi.fn(actual.homedir),
  };
});

const makeTempDir = trackTempDirs();

afterEach(() => {
  vi.resetAllMocks();
});

test('Windows chat workspaces avoid private Station ancestors and remain isolated by Station', async () => {
  const profile = makeTempDir('station-windows-workspaces-');
  vi.mocked(os.platform).mockReturnValue('win32');
  vi.mocked(os.homedir).mockReturnValue(profile);
  const home = join(profile, '.station', 'instances', 'nightly');
  const other = join(profile, '.station-workloads', 'instances', 'nightly');
  const scratch = await prepareNoProjectChatScratch('conversation', home);
  const managed = await prepareManagedEngineWorkspace(
    'codex',
    { kind: 'session', connectionId: 'codex', threadId: 'conversation' },
    home,
  );
  for (const cwd of [scratch, managed]) {
    expect(isAbsolute(cwd)).toBe(true);
    expect(relative(home, cwd).startsWith('..')).toBe(true);
    expect(relative(profile, cwd).startsWith('..')).toBe(false);
    expect((await stat(cwd)).isDirectory()).toBe(true);
    expect(isStationChatFolder(cwd, home)).toBe(true);
  }
  expect(await prepareNoProjectChatScratch('conversation', home)).toBe(scratch);
  expect(await prepareNoProjectChatScratch('conversation', other)).not.toBe(
    scratch,
  );
  expect(isStationChatFolder(join(home, 'scratch', 'legacy-chat'), home)).toBe(
    true,
  );
  const alias = join(profile, 'profile-alias');
  await symlink(profile, alias, 'junction');
  vi.mocked(os.homedir).mockReturnValue(alias);
  expect(isStationChatFolder(scratch, home)).toBe(true);
  expect(await prepareNoProjectChatScratch('conversation', home)).toBe(scratch);
});

test('Windows scratch preparation refuses a redirected workspace parent', async () => {
  const profile = makeTempDir('station-windows-workspace-link-');
  vi.mocked(os.platform).mockReturnValue('win32');
  vi.mocked(os.homedir).mockReturnValue(profile);
  await symlink(os.tmpdir(), join(profile, '.station-workspaces'), 'junction');
  await expect(
    prepareNoProjectChatScratch('conversation', join(profile, '.station')),
  ).rejects.toThrow(/symbolic link/);
});

test('scratch recognition refuses redirected Windows and legacy scratch roots', async () => {
  const profile = makeTempDir('station-windows-scratch-escape-');
  vi.mocked(os.platform).mockReturnValue('win32');
  vi.mocked(os.homedir).mockReturnValue(profile);
  const home = join(profile, '.station');
  const scratch = await prepareNoProjectChatScratch('seed', home);
  const outside = join(profile, 'outside');
  await mkdir(join(outside, 'chat'), { recursive: true });
  await mkdir(home, { recursive: true });
  await rm(dirname(scratch), { recursive: true, force: true });
  for (const root of [dirname(scratch), join(home, 'scratch')]) {
    await symlink(outside, root, 'junction');
    expect(isStationChatFolder(join(root, 'chat'), home)).toBe(false);
  }
  expect(isStationChatFolder(join(outside, 'chat'), home)).toBe(false);
});
