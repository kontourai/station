import { describe, expect, test } from 'vitest';
import { adoptRemoteTaskEngineWhenReady } from '../adoption.js';
import { githubRepositoryFromRemote } from '../repository.js';

describe('the repository a remote task chat works on', () => {
  test.each([
    ['https://github.com/example/widgets.git', 'example/widgets'],
    ['https://github.com/example/widgets', 'example/widgets'],
    ['git@github.com:example/widgets.git', 'example/widgets'],
    ['ssh://git@github.com/example/widgets.git', 'example/widgets'],
    ['https://github.com/example/widgets.js\n', 'example/widgets.js'],
  ])('%s names %s', (url, expected) => {
    const repository = githubRepositoryFromRemote(url);
    expect(repository && `${repository.owner}/${repository.name}`).toBe(
      expected,
    );
  });

  test.each([
    'https://gitlab.com/example/widgets.git',
    'https://github.com/example',
    'https://github.com/../..',
    'https://github.com/example/widgets/tree/main',
    'file:///srv/git/widgets',
  ])('%s names no GitHub repository', (url) => {
    expect(githubRepositoryFromRemote(url)).toBeUndefined();
  });
});

describe('offering the remote task engine as an Agent', () => {
  test('nothing is adopted while no connection is ready', async () => {
    let reloads = 0;
    const outcome = await adoptRemoteTaskEngineWhenReady({
      service: { readyConnections: () => [] },
      // Never reached: an adoption would read the registry through it.
      configLoader: {} as never,
      reloadAgents: async () => {
        reloads += 1;
      },
    });
    expect(outcome).toBe('not-ready');
    expect(reloads).toBe(0);
  });
});
