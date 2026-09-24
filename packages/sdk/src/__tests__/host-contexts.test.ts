/**
 * Compile-time contract for the host context hooks (#2399).
 *
 * The slots behind `useAgents`, `useNavigation`, `useToast` and `useAuth` were
 * typed `any`, so a plugin misusing them type-checked. The power of this file
 * is in `npm run typecheck:sdk`, which compiles it: each `@ts-expect-error`
 * below becomes an "unused directive" error the moment a hook's result widens
 * back to `any`. The runtime assertions only keep vitest from reporting an
 * empty file.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  useAgent,
  useAgents,
  useAuth,
  useNavigation,
  useToast,
} from '../hooks/context';
import type { SDKAuthState, SDKNavigation, SDKToast } from '../host-contexts';
import type {
  useKnowledgeDocContentQuery,
  useKnowledgeDocsQuery,
  useKnowledgeFilteredQuery,
  useKnowledgeNamespacesQuery,
  useKnowledgeTreeQuery,
} from '../query-domains/projectData';
import type {
  AgentSummary,
  KnowledgeDocumentMeta,
  KnowledgeNamespaceConfig,
  KnowledgeTreeNode,
} from '../types';

describe('host context hook contracts', () => {
  it('publishes each hook result as its contract, not any', () => {
    expectTypeOf<ReturnType<typeof useAgents>>().toEqualTypeOf<
      AgentSummary[]
    >();
    expectTypeOf<ReturnType<typeof useAgent>>().toEqualTypeOf<
      AgentSummary | undefined
    >();
    expectTypeOf<
      ReturnType<typeof useNavigation>
    >().toEqualTypeOf<SDKNavigation>();
    expectTypeOf<ReturnType<typeof useToast>>().toEqualTypeOf<SDKToast>();
    expectTypeOf<ReturnType<typeof useAuth>>().toEqualTypeOf<SDKAuthState>();
    expect(true).toBe(true);
  });

  it('accepts both toast spellings the host renders, and refuses a mix', () => {
    const exercise = (toast: SDKToast) => {
      toast.showToast('Saved', 'success');
      toast.showToast('Saved', 'warning', 4000);
      toast.showToast({
        message: 'Saved',
        type: 'success',
        actions: [{ label: 'View', onClick: () => {} }],
      });
      // @ts-expect-error the object form takes no positional tone
      toast.showToast({ message: 'Saved' }, 'error');
      // @ts-expect-error not one of the four tones
      toast.showToast('Saved', 'ok');
    };
    expect(typeof exercise).toBe('function');
  });

  it('refuses reads the host navigation, auth and agents do not carry', () => {
    const exercise = (
      navigation: SDKNavigation,
      auth: SDKAuthState,
      agents: AgentSummary[],
    ) => {
      // @ts-expect-error the host publishes `isDockOpen`; there is no `dockState`
      const dock: boolean = navigation.dockState;
      // @ts-expect-error `expiresAt` is a Date, not an epoch number
      const expiry: number | null = auth.expiresAt;
      // @ts-expect-error an Agent's slug is a string, not a number
      const slug: number | undefined = agents[0]?.slug;
      return [dock, expiry, slug];
    };
    expect(typeof exercise).toBe('function');
  });

  it('types the knowledge query results a plugin reads', () => {
    expectTypeOf<
      ReturnType<typeof useKnowledgeTreeQuery>['data']
    >().toEqualTypeOf<KnowledgeTreeNode | undefined>();
    expectTypeOf<
      ReturnType<typeof useKnowledgeFilteredQuery>['data']
    >().toEqualTypeOf<KnowledgeDocumentMeta[] | undefined>();
    expectTypeOf<
      ReturnType<typeof useKnowledgeDocsQuery>['data']
    >().toEqualTypeOf<KnowledgeDocumentMeta[] | undefined>();
    expectTypeOf<
      ReturnType<typeof useKnowledgeNamespacesQuery>['data']
    >().toEqualTypeOf<KnowledgeNamespaceConfig[] | undefined>();
    expectTypeOf<
      ReturnType<typeof useKnowledgeDocContentQuery>['data']
    >().toEqualTypeOf<string | undefined>();
    expect(true).toBe(true);
  });
});
