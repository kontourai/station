import { createHash, randomUUID } from 'node:crypto';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  AttachmentStagingPreparation,
  StagedAttachmentReference,
} from '@kontourai/station-contracts/attachment-staging';
import { parseChatAttachmentDataUrl } from '@kontourai/station-contracts/chat-attachment';
import type { ConversationOpenResolution } from '@kontourai/station-contracts/orchestration';
import type { Page } from '@playwright/test';

/** Bind explicitly named conversation/session identities through the real open contract. */
export async function mockMobileConversationOpen(
  page: Page,
  input: {
    conversationId: string;
    currentSessionId: string;
    title: string;
    messageCount?: number;
  },
) {
  const data: ConversationOpenResolution = {
    status: 'resolved',
    currentSessionId: input.currentSessionId,
    canContinue: true,
    conversation: {
      id: input.conversationId,
      source: 'runtime',
      agentSlug: agentId('station'),
      projectSlug: 'default',
      title: input.title,
      messageCount: input.messageCount ?? 0,
      createdAt: '2026-07-19T10:00:00Z',
      updatedAt: '2026-07-19T10:06:00Z',
      mutable: false,
      answerability: { answerable: true },
    },
    transcript: {
      available: true,
      owner: 'runtime',
      messageCount: input.messageCount ?? 0,
    },
    answerability: { answerable: true },
    recoveryActions: [],
  };
  await page.route(
    `**/api/conversations/${input.conversationId}/open`,
    (route) => route.fulfill({ json: { success: true, data } }),
  );
}

type UploadMetadata = Pick<
  StagedAttachmentReference,
  'clientAttachmentId' | 'kind' | 'name' | 'mimeType' | 'size'
>;

/** Capture actual upload bytes and return only the server-owned reference on completion. */
export async function mockMobileAttachmentStaging(page: Page) {
  const pending = new Map<string, AttachmentStagingPreparation>();
  const uploads: Array<{
    bytes: Buffer;
    reference: StagedAttachmentReference;
  }> = [];
  await page.route(
    /\/api\/orchestration\/attachment-staging(?:\/.*)?$/u,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/capability'))
        return route.fulfill({
          json: { state: 'supported', version: 1, maxConcurrentUploads: 3 },
        });
      if (path.endsWith('/prepare')) {
        const metadata = request.postDataJSON() as UploadMetadata;
        const prepared: AttachmentStagingPreparation = {
          ...metadata,
          stageId: `stage_${randomUUID()}`,
          uploadGrant: 'a'.repeat(43),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
        pending.set(prepared.stageId, prepared);
        return route.fulfill({ json: prepared });
      }
      const stageId = path.split('/').at(-1)!;
      const prepared = pending.get(stageId);
      if (request.method() === 'PUT' && prepared) {
        const parsed = parseChatAttachmentDataUrl(request.postData() ?? '');
        const bytes = parsed ? Buffer.from(parsed.base64, 'base64') : undefined;
        if (!bytes) throw new Error('The staged upload contained no bytes');
        const { uploadGrant: _grant, ...metadata } = prepared;
        const reference: StagedAttachmentReference = {
          ...metadata,
          source: 'current-composer',
          digest: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
        };
        uploads.push({ bytes, reference });
        return route.fulfill({ json: reference });
      }
      return route.abort();
    },
  );
  return uploads;
}
