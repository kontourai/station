declare module '@kontourai/veritas/engine' {
  export function classifyNodes(
    files: readonly string[],
    repoMap: unknown,
    rootDir: string,
  ): {
    affectedNodes: string[];
    affectedEvidenceChecks: string[];
    matchedNodes: RepoMapNode[];
    fileNodes: Record<string, RepoMapNode[]>;
    unmatchedFiles: string[];
  };

  interface RepoMapNode {
    id: string;
    label: string;
    kind: string;
    owners: string[];
    boundary: string;
    boundaryAllow: string[];
  }
}
