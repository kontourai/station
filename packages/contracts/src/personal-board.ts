import type { LayoutReadView } from './layout.js';

export type PersonalBoardSection = {
  id: string;
  title: string;
  width: 'half' | 'full';
} & (
  | {
      kind: 'tasks';
      projectSlug?: string;
      includeCompleted?: boolean;
      limit: number;
    }
  | { kind: 'attention'; projectSlug?: string; limit: number }
  | { kind: 'recent-work'; projectSlug?: string; limit: number }
  | { kind: 'projects'; limit: number }
  | { kind: 'note'; body: string }
  | { kind: 'links'; links: { label: string; href: string }[] }
);

export interface PersonalBoardDefinition {
  version: 1;
  name: string;
  description: string;
  sections: PersonalBoardSection[];
}

export interface PersonalBoardDocument {
  layout: LayoutReadView;
  /** Opaque precondition over the entire saved Layout, including pending proposals. */
  revision: string;
  definition: PersonalBoardDefinition | null;
  proposal: PersonalBoardDefinition | null;
}

export interface PersonalBoardProposalInput {
  /** Null creates a new Board; an existing Board requires its current revision. */
  revision: string | null;
  definition: PersonalBoardDefinition;
}

export interface PersonalBoardSaveInput {
  revision: string;
  definition: PersonalBoardDefinition;
}
