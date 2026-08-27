import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const CANONICAL_SECURITY_REPORT_URL =
  'https://github.com/kontourai/station/security/advisories/new';
const PREDECESSOR_SECURITY_REPORT_URL =
  'https://github.com/briananderson1222/work-agent/security/advisories/new';

interface ContactLink {
  name: string;
  url: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateSecurityReportLink(config: unknown): void {
  if (!isRecord(config) || !Array.isArray(config.contact_links)) {
    throw new Error('Issue-template config must define a contact_links array');
  }

  const contactLinks: ContactLink[] = config.contact_links.map(
    (entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== 'string' ||
        typeof entry.url !== 'string'
      ) {
        throw new Error(
          `Issue-template contact_links[${index}] must have string name and url fields`,
        );
      }
      return { name: entry.name, url: entry.url };
    },
  );
  const securityReportLinks = contactLinks.filter(
    (entry) => entry.name === 'Security Report',
  );

  if (securityReportLinks.length !== 1) {
    throw new Error(
      `Expected exactly one Security Report contact link, found ${securityReportLinks.length}`,
    );
  }

  const actualUrl = securityReportLinks[0].url;
  if (actualUrl !== CANONICAL_SECURITY_REPORT_URL) {
    throw new Error(
      `Security Report destination mismatch: expected ${CANONICAL_SECURITY_REPORT_URL}, received ${actualUrl}`,
    );
  }
}

function parseYaml(yaml: string): unknown {
  return load(yaml);
}

describe('issue-template Security Report contact link', () => {
  it('targets the exact Station private advisory destination in the real config', () => {
    const config = parseYaml(
      readFileSync(
        resolve(process.cwd(), '.github/ISSUE_TEMPLATE/config.yml'),
        'utf8',
      ),
    );

    expect(() => validateSecurityReportLink(config)).not.toThrow();
  });

  it('rejects the predecessor advisory destination through the same validator', () => {
    const predecessorConfig = parseYaml(`
blank_issues_enabled: false
contact_links:
  - name: Security Report
    url: ${PREDECESSOR_SECURITY_REPORT_URL}
    about: Report security vulnerabilities privately.
`);

    expect(() => validateSecurityReportLink(predecessorConfig)).toThrow(
      `Security Report destination mismatch: expected ${CANONICAL_SECURITY_REPORT_URL}, received ${PREDECESSOR_SECURITY_REPORT_URL}`,
    );
  });
});
