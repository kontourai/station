import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { terminatePtyProcessGroups } from '../pty-process-groups.js';

const census = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util');
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: census.read }),
  };
});

const root = '100 1 100 ttys3994\n';
describe('PTY process-group census custody', () => {
  beforeEach(() => {
    census.read.mockReset();
    vi.spyOn(process, 'kill').mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  test.each([
    '?',
    '??',
    '-',
    'none',
    'unknown',
    'tty',
    'pts/',
    '/dev/null',
    'pts/../1',
  ])(
    'refuses a census with non-device tty %s before signaling any group',
    async (tty) => {
      census.read.mockResolvedValue({
        stdout: `100 1 100 ${tty}\n200 1 200 ${tty}\n`,
      });
      await expect(terminatePtyProcessGroups(100, () => true)).rejects.toThrow(
        'Terminal controlling tty ownership unavailable',
      );
      expect(process.kill).not.toHaveBeenCalled();
    },
  );

  test.each(['pts/3', 'ttys003'])(
    'accepts concrete tty %s and terminates its owned group',
    async (tty) => {
      census.read.mockResolvedValue({ stdout: `100 1 100 ${tty}\n` });
      await terminatePtyProcessGroups(100, () => true);
      expect(process.kill).toHaveBeenCalledWith(-100, 'SIGSTOP');
      expect(process.kill).toHaveBeenCalledWith(-100, 'SIGKILL');
    },
  );

  test('waits without signals for a new child to acquire its native-bound tty', async () => {
    let reads = 0;
    census.read.mockImplementation(async () => {
      reads++;
      if (reads <= 2) expect(process.kill).not.toHaveBeenCalled();
      return { stdout: reads === 1 ? '100 1 100 ??\n' : root };
    });
    await terminatePtyProcessGroups(100, () => true, 'ttys3994');
    expect(process.kill).toHaveBeenCalledWith(-100, 'SIGKILL');
  });

  test('a different concrete tty never satisfies the native-bound ownership', async () => {
    census.read.mockResolvedValue({ stdout: root });
    await expect(
      terminatePtyProcessGroups(100, () => true, 'ttys9999'),
    ).rejects.toThrow('Terminal controlling tty ownership unavailable');
    expect(process.kill).not.toHaveBeenCalled();
  });

  test('an initially missing native binding never turns into successful cleanup', async () => {
    census.read.mockResolvedValue({ stdout: '100 1 100 ??\n' });
    await expect(
      terminatePtyProcessGroups(100, () => true, 'ttys3994'),
    ).rejects.toThrow('Terminal process groups did not quiesce');
    expect(process.kill).not.toHaveBeenCalled();
  });

  test('an invalid native device refuses admission before any census signal', async () => {
    census.read.mockResolvedValue({ stdout: root });
    await expect(
      terminatePtyProcessGroups(100, () => true, 'pts/../1'),
    ).rejects.toThrow('Terminal controlling tty ownership unavailable');
    expect(process.kill).not.toHaveBeenCalled();
  });

  test('rescans after freezing and kills a newly discovered reparented tty group', async () => {
    census.read
      .mockResolvedValueOnce({ stdout: root })
      .mockResolvedValueOnce({ stdout: root + '200 1 200 ttys3994\n' })
      .mockResolvedValue({ stdout: root + '200 1 200 ttys3994\n' });
    await terminatePtyProcessGroups(100, () => true);
    expect(process.kill).toHaveBeenCalledWith(-200, 'SIGSTOP');
    expect(process.kill).toHaveBeenCalledWith(-200, 'SIGKILL');
    expect(process.kill).toHaveBeenCalledWith(-100, 'SIGKILL');
  });

  test('never continues a frozen group that has left the owned terminal census', async () => {
    census.read
      .mockResolvedValueOnce({ stdout: root + '200 100 200 ttys3994\n' })
      .mockResolvedValue({ stdout: root + '200 1 200 ttysOther\n' });
    await terminatePtyProcessGroups(100, () => true);
    expect(process.kill).toHaveBeenCalledWith(-200, 'SIGSTOP');
    expect(process.kill).not.toHaveBeenCalledWith(-200, 'SIGCONT');
    expect(process.kill).not.toHaveBeenCalledWith(-200, 'SIGKILL');
  });

  test('a failed freeze thaws only surviving groups whose frozen identities remain owned', async () => {
    census.read.mockResolvedValue({ stdout: root + '200 100 200 ttys3994\n' });
    vi.mocked(process.kill).mockImplementation((pid, name) => {
      if (pid === -200 && name === 'SIGSTOP') throw new Error('freeze refused');
      return true;
    });
    await expect(terminatePtyProcessGroups(100, () => true)).rejects.toThrow(
      'freeze refused',
    );
    expect(process.kill).toHaveBeenCalledWith(-100, 'SIGCONT');
    expect(process.kill).not.toHaveBeenCalledWith(-200, 'SIGCONT');
  });
});
