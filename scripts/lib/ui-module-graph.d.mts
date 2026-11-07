export function createUiModuleGraph(rootDir?: string): {
  edges(repoPath: string): { static: string[]; dynamic: string[] };
  closure(
    entries: readonly string[],
    options: { followDynamic: boolean },
  ): Set<string>;
};
