// @kontourai/corpus ships JavaScript without declarations. These types cover
// the `@kontourai/corpus/search` entry as its README and src/search.mjs define
// it: ranked search over docs bundles a host already holds in memory.
declare module '@kontourai/corpus/search' {
  export interface CorpusSearchTopic {
    readonly id: string;
    readonly title: string;
    readonly source: string;
    readonly url: string;
    readonly markdown: string;
    readonly summary?: string;
    readonly tags?: readonly string[];
    readonly parentId?: string;
  }

  export interface CorpusSearchDocument {
    readonly source: string;
    readonly title: string;
    readonly url: string;
    readonly markdown: string;
  }

  export interface CorpusSearchBundle {
    readonly product: string;
    readonly sha: string | null;
    readonly dirty?: boolean;
    readonly documents: readonly CorpusSearchDocument[];
    readonly topics: readonly CorpusSearchTopic[];
    readonly synonyms?: readonly (readonly string[])[];
  }

  interface CorpusSearchResultBase {
    readonly product: string;
    readonly title: string;
    readonly source: string;
    readonly url: string;
    readonly sha: string | null;
    readonly dirty?: true;
    readonly score: number;
    readonly snippet: string;
  }

  export type CorpusSearchResult =
    | (CorpusSearchResultBase & {
        readonly kind: 'topic';
        readonly id: string;
        readonly summary?: string;
        readonly tags?: readonly string[];
        readonly parentId?: string;
      })
    | (CorpusSearchResultBase & { readonly kind: 'document' })
    | (CorpusSearchResultBase & {
        readonly kind: 'row';
        readonly name: string;
        readonly headings: readonly string[];
      });

  export function searchBundles(
    bundles: readonly CorpusSearchBundle[],
    query: string,
    limit?: number,
  ): CorpusSearchResult[];
}
