/**
 * `station policy templates` (#4523, #4524): the Group Policy template
 * (ADMX and its en-US ADML) and a macOS configuration profile.
 *
 * The ADMX/ADML come from the control table in `managed-policy-controls.ts`,
 * the same table the registry reader uses, filtered to the limits this build
 * enforces; a test fails when an enforced limit has no control. The output
 * validates against the ADMX schema of [MS-GPREG] §7.
 */
import { createHash } from 'node:crypto';
import type { ManagedPolicyDocument } from '@kontourai/station-contracts/managed-policy';
import {
  type ManagedPolicyControl,
  type ManagedPolicyElement,
  templateManagedPolicyControls,
  WINDOWS_POLICY_SUBKEY,
} from './managed-policy-controls.js';
import { MACOS_POLICY_DOMAIN } from './managed-policy-macos.js';

const CATEGORY = 'Station';
const SUPPORTED_ON = 'SUPPORTED_Station';
/** Bumped when the template changes shape; Group Policy shows it. */
const TEMPLATE_REVISION = '1.0';
/** Longest JSON or list box; the reader's own limit is the policy size. */
const MULTI_TEXT_MAX_LENGTH = 32_767;

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const ON_OFF =
  '<enabledValue><decimal value="1" /></enabledValue>\n      <disabledValue><decimal value="0" /></disabledValue>';

function admxElements(element: ManagedPolicyElement): string[] {
  switch (element.kind) {
    case 'text':
      return [
        `<text id="${element.valueName}" valueName="${element.valueName}"${element.required ? ' required="true"' : ''} maxLength="${element.maxLength}" />`,
      ];
    case 'json':
    case 'lines':
      return [
        `<multiText id="${element.valueName}" valueName="${element.valueName}" required="true" maxLength="${MULTI_TEXT_MAX_LENGTH}" />`,
      ];
    case 'enum':
      return [
        `<enum id="${element.valueName}" valueName="${element.valueName}" required="true">`,
        ...element.items.map(
          (item) =>
            `  <item displayName="$(string.${element.valueName}_${item.value})"><value><string>${escapeXml(item.value)}</string></value></item>`,
        ),
        '</enum>',
      ];
    case 'checkboxes':
      return element.items.map(
        (item) =>
          `<boolean id="${item.valueName}" valueName="${item.valueName}"><trueValue><decimal value="1" /></trueValue><falseValue><decimal value="0" /></falseValue></boolean>`,
      );
  }
}

function admxPolicy(control: ManagedPolicyControl): string {
  const head = `<policy name="${control.id}" class="Machine" displayName="$(string.${control.id})" explainText="$(string.${control.id}_Help)" key="${WINDOWS_POLICY_SUBKEY}"`;
  const common = `<parentCategory ref="${CATEGORY}" />\n      <supportedOn ref="${SUPPORTED_ON}" />`;
  if (control.kind === 'switch')
    return `    ${head} valueName="${control.valueName}">
      ${common}
      ${ON_OFF}
    </policy>`;
  const state = control.stateValueName
    ? ` valueName="${control.stateValueName}"`
    : '';
  const body = control.elements.flatMap(admxElements);
  return `    ${head}${state} presentation="$(presentation.${control.id})">
      ${common}${control.stateValueName ? `\n      ${ON_OFF}` : ''}
      <elements>
        ${body.join('\n        ')}
      </elements>
    </policy>`;
}

/** The language-neutral template, for `PolicyDefinitions\station.admx`. */
export function managedPolicyAdmx(
  controls: readonly ManagedPolicyControl[] = templateManagedPolicyControls(),
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="${TEMPLATE_REVISION}" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="station" namespace="Kontour.Policies.Station" />
  </policyNamespaces>
  <resources minRequiredRevision="${TEMPLATE_REVISION}" />
  <supportedOn>
    <definitions>
      <definition name="${SUPPORTED_ON}" displayName="$(string.${SUPPORTED_ON})" />
    </definitions>
  </supportedOn>
  <categories>
    <category name="${CATEGORY}" displayName="$(string.${CATEGORY})" />
  </categories>
  <policies>
${controls.map(admxPolicy).join('\n')}
  </policies>
</policyDefinitions>
`;
}

function presentationElements(element: ManagedPolicyElement): string[] {
  switch (element.kind) {
    case 'text':
      return [
        `<textBox refId="${element.valueName}"><label>${escapeXml(element.label)}</label></textBox>`,
      ];
    case 'json':
    case 'lines':
      // The schema's multiTextBox has no content, so the label is its own line.
      return [
        `<text>${escapeXml(element.label)}</text>`,
        `<multiTextBox refId="${element.valueName}" />`,
      ];
    case 'enum':
      return [
        `<dropdownList refId="${element.valueName}" noSort="true" defaultItem="0">${escapeXml(element.label)}</dropdownList>`,
      ];
    case 'checkboxes':
      return [
        `<text>${escapeXml(element.label)}</text>`,
        ...element.items.map(
          (item) =>
            `<checkBox refId="${item.valueName}" defaultChecked="${item.defaultChecked}">${escapeXml(item.label)}</checkBox>`,
        ),
      ];
  }
}

/** The en-US strings and dialogs, for `PolicyDefinitions\en-US\station.adml`. */
export function managedPolicyAdml(
  controls: readonly ManagedPolicyControl[] = templateManagedPolicyControls(),
): string {
  const strings: Array<[string, string]> = [
    [CATEGORY, 'Station'],
    [SUPPORTED_ON, 'Station with managed policy support'],
  ];
  const presentations: string[] = [];
  for (const control of controls) {
    strings.push(
      [control.id, control.title],
      [`${control.id}_Help`, control.help],
    );
    if (control.kind !== 'policy') continue;
    for (const element of control.elements)
      if (element.kind === 'enum')
        for (const item of element.items)
          strings.push([`${element.valueName}_${item.value}`, item.label]);
    presentations.push(
      `      <presentation id="${control.id}">\n        ${control.elements.flatMap(presentationElements).join('\n        ')}\n      </presentation>`,
    );
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" revision="${TEMPLATE_REVISION}" schemaVersion="1.0" xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName>Station</displayName>
  <description>Managed policy for Station</description>
  <resources>
    <stringTable>
${strings.map(([id, text]) => `      <string id="${id}">${escapeXml(text)}</string>`).join('\n')}
    </stringTable>
    <presentationTable>
${presentations.join('\n')}
    </presentationTable>
  </resources>
</policyDefinitionResources>
`;
}

// ---------------------------------------------------------------------------
// macOS configuration profile
// ---------------------------------------------------------------------------

/** The first path holding a `null`, which a property list cannot express. */
function nullPath(value: unknown, path: string[] = []): string[] | null {
  if (value === null) return path;
  if (typeof value !== 'object') return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const found = nullPath(item, [...path, key]);
    if (found) return found;
  }
  return null;
}

function plistValue(value: unknown, indent: string): string {
  const inner = `${indent}  `;
  if (typeof value === 'string')
    return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return `${indent}<${value} />`;
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? `${indent}<integer>${value}</integer>`
      : `${indent}<real>${value}</real>`;
  if (Array.isArray(value))
    return value.length === 0
      ? `${indent}<array />`
      : `${indent}<array>\n${value.map((item) => plistValue(item, inner)).join('\n')}\n${indent}</array>`;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${indent}<dict />`;
  return `${indent}<dict>\n${entries
    .map(
      ([key, item]) =>
        `${inner}<key>${escapeXml(key)}</key>\n${plistValue(item, inner)}`,
    )
    .join('\n')}\n${indent}</dict>`;
}

/** A UUID derived from `seed`, so one document always yields one profile. */
function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase();
}

export type ManagedPolicyProfileResult =
  | { ok: true; profile: string }
  | { ok: false; reason: string };

/**
 * A device (System scope) configuration profile whose one payload, of type
 * `io.kontourai.station`, carries `document`'s keys. macOS installs them as
 * `/Library/Managed Preferences/io.kontourai.station.plist`. The identifiers
 * are fixed, so a regenerated profile replaces the installed one; the UUIDs
 * follow the document.
 */
export function managedPolicyMobileconfig(
  document: ManagedPolicyDocument,
): ManagedPolicyProfileResult {
  const empty = nullPath(document);
  if (empty)
    return {
      ok: false,
      reason: `${empty.join('.')} is null, which a configuration profile cannot hold; deploy this policy as a file instead`,
    };
  const seed = JSON.stringify(document);
  const payloadUuid = stableUuid(`payload:${seed}`);
  const profile = {
    PayloadContent: [
      {
        PayloadDisplayName: 'Station managed policy',
        PayloadIdentifier: `${MACOS_POLICY_DOMAIN}.policy.payload`,
        PayloadType: MACOS_POLICY_DOMAIN,
        PayloadUUID: payloadUuid,
        PayloadVersion: 1,
        ...document,
      },
    ],
    PayloadDescription:
      'Applies the Station managed policy to every user on this Mac.',
    PayloadDisplayName: `Station policy for ${document.organization}`,
    PayloadIdentifier: `${MACOS_POLICY_DOMAIN}.policy`,
    PayloadOrganization: document.organization,
    PayloadScope: 'System',
    PayloadType: 'Configuration',
    PayloadUUID: stableUuid(`profile:${seed}`),
    PayloadVersion: 1,
  };
  return {
    ok: true,
    profile: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${plistValue(profile, '')}
</plist>
`,
  };
}

/** The files `station policy templates` writes, relative to its directory. */
export const MANAGED_POLICY_TEMPLATE_FILES = {
  mobileconfig: 'macos/station.mobileconfig',
  admx: 'windows/station.admx',
  adml: 'windows/en-US/station.adml',
} as const;
