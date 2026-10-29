import { FileTreeService } from '../../../../services/projects/file-tree-service.js';
import { createCodingRoutes } from '../../coding.js';
import { codingDiffRepositoryFixture } from './coding-worktree-diff-repository.js';

export { THREE_NEW_FILES } from './coding-worktree-diff-repository.js';

/** Actual public route owner, shared by in-process server tests and the Node bridge. */
export function codingDiffRoutes(root: string) {
  return createCodingRoutes(new FileTreeService(), {
    resolveProjectFolder: (slug) =>
      slug === 'project-alpha' ? root : undefined,
  });
}

export function codingDiffFixture(directory: string) {
  const repository = codingDiffRepositoryFixture(directory);
  const { root } = repository;
  const app = codingDiffRoutes(root);
  const request = () =>
    app.request(
      `/git/diff?projectSlug=project-alpha&path=${encodeURIComponent(root)}`,
    );
  return { ...repository, app, request };
}
