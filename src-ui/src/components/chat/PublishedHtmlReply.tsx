import type {
  HtmlReplyReference,
  PublishedHtmlReply as StoredPage,
} from '@kontourai/station-contracts/html-reply';
import { getJson } from '@kontourai/station-sdk';
import { useQuery } from '@tanstack/react-query';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';
import { SkeletonBlock } from '../state';
import { HtmlReply } from './HtmlReply';

export function PublishedHtmlReply({
  reference,
}: {
  reference: HtmlReplyReference;
}) {
  const { apiBase } = useApiBase();
  const authority = useHostRequestAuthorityScope();
  const { theme } = useDeviceSettings();
  const query = useQuery({
    queryKey: [
      'html-reply',
      apiBase,
      authority?.authorityKey,
      reference.sessionId,
      reference.pageId,
    ],
    queryFn: async ({ signal }) => {
      const response = await getJson(
        `${apiBase}/api/html-replies/${encodeURIComponent(reference.sessionId)}/${encodeURIComponent(reference.pageId)}`,
        { signal, requestScope: authority, maxResponseBytes: 10 * 1024 * 1024 },
      );
      if (!response.ok)
        throw new Error(
          'This page is unavailable or you no longer have access.',
        );
      const body: {
        success: boolean;
        data?: StoredPage;
        frameOrigin?: string;
      } = await response.json();
      if (!body.success || !body.data)
        throw new Error('This page is unavailable.');
      return { page: body.data, frameOrigin: body.frameOrigin ?? '' };
    },
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  if (query.error)
    return <p role="status">Visual reply unavailable: {query.error.message}</p>;
  if (!query.data) return <SkeletonBlock label="Loading visual reply" />;
  return (
    <HtmlReply
      page={query.data.page}
      frameOrigin={query.data.frameOrigin}
      theme={theme}
    />
  );
}
