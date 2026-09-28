import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

describe('issue-template Security Report contact link', () => {
  it('targets the exact Station private advisory destination in the real config', () => {
    const config = load(
      readFileSync(
        resolve(process.cwd(), '.github/ISSUE_TEMPLATE/config.yml'),
        'utf8',
      ),
    ) as { contact_links: Array<{ name: string; url: string }> };

    const securityReportLinks = config.contact_links.filter(
      (entry) => entry.name === 'Security Report',
    );
    expect(securityReportLinks).toHaveLength(1);
    expect(securityReportLinks[0].url).toBe(
      'https://github.com/kontourai/station/security/advisories/new',
    );
  });
});
