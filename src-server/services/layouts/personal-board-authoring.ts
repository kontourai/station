import { createHash, randomUUID } from 'node:crypto';
import type {
  LayoutConfig,
  LayoutOwner,
} from '@kontourai/station-contracts/layout';
import type {
  PersonalBoardDefinition,
  PersonalBoardDocument,
  PersonalBoardProposalInput,
  PersonalBoardSaveInput,
} from '@kontourai/station-contracts/personal-board';
import { FileStorageNotFoundError } from '../../domain/project-file-transactions.js';
import { personalBoardDefinitionSchema } from '../../routes/schemas/schema-definitions/personal-board.js';
import { withPersonalLayoutOperation } from './personal-layout-operation.js';
import type { OwnedLayoutStore } from './personal-layout-service.js';

export class BoardRevisionConflict extends Error {
  constructor() {
    super(
      'This Board changed. Refresh it before saving or proposing another revision.',
    );
  }
}

function revision(layout: LayoutConfig): string {
  return createHash('sha256').update(JSON.stringify(layout)).digest('hex');
}

function definition(value: unknown): PersonalBoardDefinition | null {
  return value === undefined
    ? null
    : personalBoardDefinitionSchema.parse(value);
}

function personalBoardDocument(layout: LayoutConfig): PersonalBoardDocument {
  return {
    layout,
    revision: revision(layout),
    definition: definition(layout.config.dashboard),
    proposal: definition(layout.config.dashboardProposal),
  };
}

export class PersonalBoardAuthoring {
  constructor(private readonly store: OwnedLayoutStore) {}

  get(owner: LayoutOwner, slug: string): PersonalBoardDocument {
    return personalBoardDocument(this.store.getOwnedLayout(owner, slug));
  }

  private async proposeExclusive(
    owner: LayoutOwner,
    slug: string,
    input: PersonalBoardProposalInput,
  ): Promise<PersonalBoardDocument> {
    const layout = await this.store.mutateOwnedLayout(
      owner,
      slug,
      (current) => {
        if (
          input.revision === null
            ? current !== undefined
            : !current || revision(current) !== input.revision
        )
          throw new BoardRevisionConflict();
        const now = new Date().toISOString();
        const base: LayoutConfig = current ?? {
          id: randomUUID(),
          slug,
          owner,
          type: 'custom',
          name: `${input.definition.name} (draft)`,
          config: {},
          createdAt: now,
          updatedAt: now,
        };
        return {
          ...base,
          config: { ...base.config, dashboardProposal: input.definition },
          updatedAt: now,
        };
      },
    );
    return personalBoardDocument(layout);
  }

  propose(
    owner: LayoutOwner,
    slug: string,
    input: PersonalBoardProposalInput,
  ): Promise<PersonalBoardDocument> {
    return withPersonalLayoutOperation(this.store, owner, slug, () =>
      this.proposeExclusive(owner, slug, input),
    );
  }

  async save(
    owner: LayoutOwner,
    slug: string,
    input: PersonalBoardSaveInput,
  ): Promise<PersonalBoardDocument> {
    return this.change(owner, slug, input.revision, (current) => {
      const { dashboardProposal: _proposal, ...config } = current.config;
      return {
        ...current,
        name: input.definition.name,
        description: input.definition.description,
        config: { ...config, dashboard: input.definition },
      };
    });
  }

  async dismiss(
    owner: LayoutOwner,
    slug: string,
    expected: string,
  ): Promise<PersonalBoardDocument> {
    return this.change(owner, slug, expected, (current) => {
      const { dashboardProposal: _proposal, ...config } = current.config;
      return { ...current, config };
    });
  }

  private async change(
    owner: LayoutOwner,
    slug: string,
    expected: string,
    change: (layout: LayoutConfig) => LayoutConfig,
  ): Promise<PersonalBoardDocument> {
    return withPersonalLayoutOperation(this.store, owner, slug, async () => {
      const layout = await this.store.mutateOwnedLayout(
        owner,
        slug,
        (current) => {
          if (!current) throw new FileStorageNotFoundError('Board not found');
          if (revision(current) !== expected) throw new BoardRevisionConflict();
          return { ...change(current), updatedAt: new Date().toISOString() };
        },
      );
      return personalBoardDocument(layout);
    });
  }
}
