import {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_FILE_MIME_TYPES,
  CHAT_IMAGE_MIME_TYPES,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import { isTaskRoomAttachments } from '@kontourai/station-contracts/project-task-room';
import { z } from 'zod/v3';

const descriptor = z.object({
  kind: z.enum(['image', 'file']),
  name: z.string().min(1).max(CHAT_ATTACHMENT_MAX_NAME_LENGTH),
  mimeType: z.enum([...CHAT_IMAGE_MIME_TYPES, ...CHAT_FILE_MIME_TYPES]),
  size: z.number().int().positive(),
});
export const taskRoomAttachmentsSchema = z
  .array(descriptor.extend({ id: z.string().max(36).uuid() }).strict())
  .max(CHAT_ATTACHMENT_MAX_COUNT)
  .refine(isTaskRoomAttachments, 'Invalid Task attachments.');
export const taskRoomAttachmentUploadSchema = z
  .object({
    taskCreatedAt: z.string().datetime(),
    attachments: z
      .array(
        descriptor
          .extend({
            dataUrl: z.string().max(CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH),
          })
          .strict(),
      )
      .min(1)
      .max(CHAT_ATTACHMENT_MAX_COUNT)
      .superRefine((attachments, ctx) => {
        const error = validateChatAttachments(attachments);
        if (error)
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
      }),
  })
  .strict();
