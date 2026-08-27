/**
 * Email Provider — implements IEmailProvider using calendar-mcp email tools.
 */

import { callTool } from '@kontourai/station-sdk';
import type { IEmailProvider } from '../providers';
import type { EmailVM } from '../viewmodels';

const AGENT = 'enterprise-assistant';

function mapEmail(raw: any): EmailVM {
  return {
    id: raw.id,
    subject: raw.subject || '',
    from: { name: raw.from?.name || '', email: raw.from?.address || '' },
    date: new Date(raw.receivedDateTime || raw.date || Date.now()),
    preview: raw.bodyPreview || raw.preview || '',
    isRead: raw.isRead ?? true,
    importance: raw.importance?.toLowerCase() as EmailVM['importance'],
    hasAttachments: raw.hasAttachments ?? false,
  };
}

export const emailProvider: IEmailProvider = {
  async getInbox(options) {
    const raw = await callTool(AGENT, 'calendar-mcp_email_inbox', {
      count: options?.count || 25,
      filter: options?.filter,
    });
    return (raw?.emails || raw || []).map(mapEmail);
  },
  async searchEmails(query) {
    const raw = await callTool(AGENT, 'calendar-mcp_email_search', { query });
    return (raw?.emails || raw || []).map(mapEmail);
  },
  async readEmail(id) {
    const r = await callTool(AGENT, 'calendar-mcp_email_read', {
      messageId: id,
    });
    return {
      ...mapEmail(r),
      body: r.body?.content || r.body || '',
      to: (r.toRecipients || []).map((x: any) => ({
        name: x.emailAddress?.name || '',
        email: x.emailAddress?.address || '',
      })),
      cc: (r.ccRecipients || []).map((x: any) => ({
        name: x.emailAddress?.name || '',
        email: x.emailAddress?.address || '',
      })),
      attachments: (r.attachments || []).map((a: any) => ({
        name: a.name,
        size: a.size || 0,
        contentType: a.contentType || '',
      })),
    };
  },
};
