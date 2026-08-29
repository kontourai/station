import { readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import {
  createSourceLabelAdapter,
  runSourceAvailability,
} from '../source-availability-driver.mjs';

const sha = 'a'.repeat(40);
describe('source availability driver', () => {
  test('locks the workflow to exact protected-main source and the tested driver', () => {
    const workflow = readFileSync(
      '.github/workflows/source-availability.yml',
      'utf8',
    );
    expect(workflow).toContain('push:');
    expect(workflow).toContain('branches: [main]');
    expect(workflow).toContain('ref: $' + '{{ github.sha }}');
    expect(workflow).toContain('persist-credentials: false');
    expect(workflow).toContain('node scripts/source-availability-driver.mjs');
    expect(workflow).not.toMatch(
      /pull_request|github-script|npm\s|self-hosted|actions\/cache|upload-artifact/,
    );
  });
  test('does no mutation for malformed facts', async () => {
    const api = {
      pullsForCommit: vi.fn(),
      getIssue: vi.fn(),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    };
    await expect(
      runSourceAvailability(
        { repository: { full_name: 'evil/repo' } },
        { api, exec: vi.fn(), checkedOutSha: sha },
      ),
    ).resolves.toMatchObject({ kind: 'ignored' });
    expect(api.addLabel).not.toHaveBeenCalled();
  });
  test('repairs a higher-stage race in favor of the higher stage', async () => {
    const getIssue = vi
      .fn()
      .mockResolvedValueOnce({ labels: [] })
      .mockResolvedValueOnce({ labels: ['stage:source', 'stage:preview'] })
      .mockResolvedValueOnce({ labels: ['stage:preview'] });
    const api = { getIssue, addLabel: vi.fn(), removeLabel: vi.fn() };
    await expect(createSourceLabelAdapter(api).project(1)).resolves.toEqual({
      kind: 'higher-won',
    });
    expect(api.removeLabel).toHaveBeenCalledWith(1, 'stage:source');
  });
  test('recovers an ambiguous add by exact readback', async () => {
    const api = {
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: [] })
        .mockResolvedValueOnce({ labels: ['stage:source'] }),
      addLabel: vi.fn().mockRejectedValue(new Error('response lost')),
      removeLabel: vi.fn(),
    };
    await expect(createSourceLabelAdapter(api).project(1)).resolves.toEqual({
      kind: 'source',
    });
  });
  test('projects bounded authoritative facts deterministically', async () => {
    const api = {
      pullsForCommit: vi.fn().mockResolvedValue([
        {
          number: 7,
          merged_at: 'x',
          merge_commit_sha: sha,
          base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
        },
      ]),
      closingIssuesForPull: vi.fn().mockResolvedValue([
        {
          number: 1,
          repository: { full_name: 'kontourai/station' },
        },
      ]),
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: [] })
        .mockResolvedValueOnce({ labels: ['stage:source'] }),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    };
    const exec = vi.fn().mockReturnValue(sha);
    await expect(
      runSourceAvailability(
        {
          repository: { full_name: 'kontourai/station' },
          ref: 'refs/heads/main',
          before: 'b'.repeat(40),
          after: sha,
        },
        { api, exec, checkedOutSha: sha },
      ),
    ).resolves.toMatchObject({ kind: 'projected' });
    expect(api.addLabel).toHaveBeenCalledWith(1, 'stage:source');
    expect(api.closingIssuesForPull).toHaveBeenCalledWith(7);
  });
  test('projects a multi-commit merge push whose commits each return their own pull object', async () => {
    // pullsForCommit yields a DISTINCT object per commit for the same pull;
    // deriving facts over the raw array left duplicates without
    // closingIssues and failed every merge-commit push.
    const mergeSha = sha;
    const branchSha = 'c'.repeat(40);
    const pullFor = () => ({
      number: 7,
      merged_at: 'x',
      merge_commit_sha: mergeSha,
      base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
    });
    const api = {
      pullsForCommit: vi.fn().mockImplementation(async () => [pullFor()]),
      closingIssuesForPull: vi
        .fn()
        .mockResolvedValue([
          { number: 1, repository: { full_name: 'kontourai/station' } },
        ]),
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: [] })
        .mockResolvedValueOnce({ labels: ['stage:source'] }),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    };
    const exec = vi.fn().mockReturnValue(`${mergeSha}\n${branchSha}`);
    await expect(
      runSourceAvailability(
        {
          repository: { full_name: 'kontourai/station' },
          ref: 'refs/heads/main',
          before: 'b'.repeat(40),
          after: mergeSha,
        },
        { api, exec, checkedOutSha: mergeSha },
      ),
    ).resolves.toMatchObject({ kind: 'projected' });
    expect(api.closingIssuesForPull).toHaveBeenCalledTimes(1);
  });

  test('makes label conflicts and failed readback fail the run', async () => {
    const api = {
      pullsForCommit: vi.fn().mockResolvedValue([
        {
          number: 7,
          merged_at: 'x',
          merge_commit_sha: sha,
          base: { ref: 'main', repo: { full_name: 'kontourai/station' } },
        },
      ]),
      closingIssuesForPull: vi.fn().mockResolvedValue([
        {
          number: 1,
          repository: { full_name: 'kontourai/station' },
        },
      ]),
      getIssue: vi
        .fn()
        .mockResolvedValueOnce({ labels: [] })
        .mockResolvedValueOnce({
          labels: ['stage:source', 'stage:preview', 'stage:stable'],
        })
        .mockResolvedValueOnce({
          labels: ['stage:preview', 'stage:stable'],
        }),
      addLabel: vi.fn(),
      removeLabel: vi.fn(),
    };
    const exec = vi.fn().mockReturnValue(sha);
    await expect(
      runSourceAvailability(
        {
          repository: { full_name: 'kontourai/station' },
          ref: 'refs/heads/main',
          before: 'b'.repeat(40),
          after: sha,
        },
        { api, exec, checkedOutSha: sha },
      ),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(api.removeLabel).toHaveBeenCalledWith(1, 'stage:source');
  });
});
