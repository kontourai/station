/**
 * The managed policy's Group Policy controls (#4524): one table that both
 * the Windows registry reader and the ADMX/ADML generator read, so a control
 * the template offers is always one the reader understands, and the reverse.
 *
 * Every value lives directly in `HKLM\SOFTWARE\Policies\Kontour\Station`.
 * The key holds either the template's values or one `Policy` string with the
 * whole document as JSON, never both.
 *
 * The meaning of **Disabled** is fixed per control kind:
 * - a `switch` ("Allow …") is a capability switch: Disabled turns the
 *   capability off (writes the limit's off value), Enabled leaves it to each
 *   user, exactly like Not Configured;
 * - every other policy carries its own state value, and Disabled on it is a
 *   startup error. Disabled never reads as "no restriction", because an
 *   administrator who disabled "Allowed clients" did not ask for every
 *   client.
 *
 * Organization has no state value: Disabled deletes its text, which leaves
 * any other configured policy without the organization it requires, so that
 * is a startup error too.
 *
 * This module is pure (no Node APIs) so the mapping is tested on every OS.
 */
import {
  duplicateJsonMemberPath,
  MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
  MANAGED_POLICY_SCHEMA_VERSION,
  type ManagedPolicyDocument,
} from '@kontourai/station-contracts/managed-policy';
import {
  MANAGED_POLICY_ENGINE_IDS,
  type ManagedPolicyEngineId,
} from '@kontourai/station-contracts/managed-policy-engines';
import {
  REMOTE_TASK_VENDOR_IDS,
  REMOTE_TASK_VENDOR_LABELS,
  type RemoteTaskVendorId,
} from '@kontourai/station-contracts/remote-task-engine';

/** The key, relative to HKEY_LOCAL_MACHINE, as an ADMX `key` attribute. */
export const WINDOWS_POLICY_SUBKEY = 'SOFTWARE\\Policies\\Kontour\\Station';
/** The key as administrators and the error messages write it. */
export const WINDOWS_POLICY_KEY = `HKLM\\${WINDOWS_POLICY_SUBKEY}`;
/** The single-value route: the whole policy document as JSON. */
export const WINDOWS_POLICY_JSON_VALUE = 'Policy';

/** A value as the registry API returned it. */
export type RegistryValue =
  | { name: string; type: 'REG_SZ'; data: string }
  | { name: string; type: 'REG_MULTI_SZ'; data: string[] }
  | { name: string; type: 'REG_DWORD'; data: number }
  /** Any other type (REG_EXPAND_SZ, REG_BINARY, REG_QWORD, …), by its code. */
  | { name: string; type: 'other'; typeCode: number };

export interface RegistryKeySnapshot {
  values: RegistryValue[];
  subkeys: string[];
}

/** A dropdown item: the REG_SZ the enum writes, and its label. */
export interface ManagedPolicyEnumItem {
  value: string;
  label: string;
}

/** One element inside a policy's dialog, and where its value lands. */
export type ManagedPolicyElement =
  | {
      kind: 'text';
      valueName: string;
      path: readonly string[];
      label: string;
      required?: boolean;
      maxLength: number;
    }
  /** A multi-line box (REG_MULTI_SZ) holding one JSON object. */
  | {
      kind: 'json';
      valueName: string;
      path: readonly string[];
      label: string;
    }
  /** A multi-line box (REG_MULTI_SZ): one list entry per non-blank line. */
  | {
      kind: 'lines';
      valueName: string;
      path: readonly string[];
      label: string;
    }
  | {
      kind: 'enum';
      valueName: string;
      path: readonly string[];
      label: string;
      items: readonly ManagedPolicyEnumItem[];
    }
  /** Checkboxes (REG_DWORD 1/0 each): the checked items form the list. */
  | {
      kind: 'checkboxes';
      path: readonly string[];
      label: string;
      items: ReadonlyArray<{
        valueName: string;
        item: string;
        label: string;
        defaultChecked: boolean;
      }>;
    };

export type ManagedPolicyControl =
  /**
   * An "Allow …" capability switch: `valueName` is a REG_DWORD, 1 for
   * Enabled (leave it to users) and 0 for Disabled (write `offValue` at
   * `path`).
   */
  | {
      kind: 'switch';
      id: string;
      title: string;
      help: string;
      limitKey: string;
      valueName: string;
      path: readonly string[];
      offValue: unknown;
    }
  /**
   * A policy with a dialog. `stateValueName`, when set, is a REG_DWORD the
   * policy writes itself: 1 for Enabled and 0 for Disabled.
   */
  | {
      kind: 'policy';
      id: string;
      title: string;
      help: string;
      limitKey?: string;
      stateValueName?: string;
      elements: readonly ManagedPolicyElement[];
    };

/**
 * #4520: the template's checkbox for each engine id the policy can name.
 * Keyed by `ManagedPolicyEngineId`, so a new engine id without a checkbox
 * does not compile.
 */
const ENGINE_LABELS: Readonly<Record<ManagedPolicyEngineId, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  muse: 'Muse',
  acp: 'ACP engines (Agent Client Protocol)',
  'station-agent': "Station's own agent",
  'remote-task': 'Remote task engine chats (cloud agents)',
};
const ENGINE_VALUE_NAMES: Readonly<Record<ManagedPolicyEngineId, string>> = {
  claude: 'EngineClaude',
  codex: 'EngineCodex',
  muse: 'EngineMuse',
  acp: 'EngineAcp',
  'station-agent': 'EngineStationAgent',
  'remote-task': 'EngineRemoteTask',
};

/**
 * The checkbox value for each remote task engine vendor
 * (docs/decisions/remote-task-engines.md). Keyed by `RemoteTaskVendorId`, so
 * a new vendor without a checkbox does not compile.
 */
const REMOTE_TASK_VALUE_NAMES: Readonly<Record<RemoteTaskVendorId, string>> = {
  devin: 'RemoteTaskDevin',
  'github-copilot': 'RemoteTaskGitHubCopilot',
  cursor: 'RemoteTaskCursor',
};

const NOT_A_SANDBOX =
  'Every user on the machine can read this policy, so do not put credentials in it.';

/**
 * Every control, in template order. `limitKey` names the `limits` key the
 * control writes; the template carries a limit's controls only while this
 * build enforces that key (see {@link templateManagedPolicyControls}).
 * Controls for keys a later slice enforces may be listed ahead of time: the
 * reader still maps their values, and the parser then refuses the key as
 * "not supported by this version", which fails closed.
 */
export const MANAGED_POLICY_CONTROLS: readonly ManagedPolicyControl[] = [
  {
    kind: 'policy',
    id: 'Organization',
    title: 'Organization',
    help: 'Required whenever any other Station policy is set. Station will not start with policies that do not name an organization.\n\nUsers see "Managed by <organization>" beside every managed control. The support URL is optional and must be https.',
    elements: [
      {
        kind: 'text',
        valueName: 'Organization',
        path: ['organization'],
        label: 'Organization name',
        required: true,
        maxLength: 200,
      },
      {
        kind: 'text',
        valueName: 'SupportUrl',
        path: ['supportUrl'],
        label: 'Support URL (optional, https)',
        maxLength: 2048,
      },
    ],
  },
  {
    kind: 'policy',
    id: 'ManagedSettings',
    title: 'Managed settings (JSON)',
    help: `Defaults and locks for Station settings, as the "settings" object of a Station policy: each key is a setting path and each value is {"value": ..., "locked": true|false}.\n\nRun "station policy check" on a policy file holding the same object to validate it first.\n\nDisabled is not supported: Station will not start. Use Not Configured for no managed settings.\n\n${NOT_A_SANDBOX}`,
    stateValueName: 'ManagedSettings',
    elements: [
      {
        kind: 'json',
        valueName: 'ManagedSettingsJson',
        path: ['settings'],
        label: 'Settings JSON',
      },
    ],
  },
  {
    kind: 'switch',
    id: 'Telemetry',
    title: 'Allow usage data and telemetry',
    help: 'Disabled: Station sends no usage data and exports no OpenTelemetry data, whatever users or the environment choose.\n\nEnabled or Not Configured: each user decides. Enabled cannot turn sharing on for a user who turned it off.',
    limitKey: 'telemetry',
    valueName: 'Telemetry',
    path: ['limits', 'telemetry'],
    offValue: false,
  },
  {
    kind: 'switch',
    id: 'WebhookAutomations',
    title: 'Allow webhook automations',
    help: 'Disabled: inbound webhook automations are refused before anything is read. Existing webhook configuration is kept.\n\nEnabled or Not Configured: webhook automations follow their own configuration.',
    limitKey: 'webhookAutomations',
    valueName: 'WebhookAutomations',
    path: ['limits', 'webhookAutomations'],
    offValue: false,
  },
  {
    kind: 'policy',
    id: 'RegistryAllowList',
    title: 'Allowed plugin and skill registries',
    help: "Only these registries may supply plugins, skills and tool servers: one https URL per line. Station's bundled catalog is always allowed. An empty list allows no other registry.\n\nDisabled is not supported: Station will not start. Use Not Configured for no allow list.",
    limitKey: 'registries',
    stateValueName: 'RegistryAllowList',
    elements: [
      {
        kind: 'lines',
        valueName: 'RegistryAllowedUrls',
        path: ['limits', 'registries', 'allowedUrls'],
        label: 'Registry URLs, one per line',
      },
    ],
  },
  {
    kind: 'switch',
    id: 'RegistryUnsignedPackages',
    title: 'Allow unsigned registry packages',
    help: "Disabled: a plugin from a registry must be signed by a key the host's registry trust already trusts, and skills and tool servers come only from Station's bundled catalogs.\n\nEnabled or Not Configured: the host's own registry trust decides.",
    limitKey: 'registries',
    valueName: 'RegistryUnsignedPackages',
    path: ['limits', 'registries', 'unsignedPackages'],
    offValue: false,
  },
  {
    kind: 'switch',
    id: 'DefaultSkillRegistries',
    title: 'Allow the default skill registries',
    help: "Disabled: Station's built-in skill registries are not registered.\n\nEnabled or Not Configured: they are registered as usual.",
    limitKey: 'registries',
    valueName: 'DefaultSkillRegistries',
    path: ['limits', 'registries', 'defaultSkillRegistries'],
    offValue: false,
  },
  {
    kind: 'switch',
    id: 'AcpRegistryInstalls',
    title: 'Allow engine installs from the ACP registry',
    help: "Disabled: engines cannot be installed from the public ACP registry. Station's own engine entries remain.\n\nEnabled or Not Configured: ACP registry installs are allowed.",
    limitKey: 'registries',
    valueName: 'AcpRegistryInstalls',
    path: ['limits', 'registries', 'acpRegistryInstalls'],
    offValue: false,
  },
  {
    kind: 'policy',
    id: 'ApprovalCeiling',
    title: 'Broadest approval mode',
    help: 'The broadest approval mode any run may use, whoever starts it. Ask < Auto < Never ask.\n\nDisabled is not supported: Station will not start. Use Not Configured for no ceiling.',
    limitKey: 'maxApprovalMode',
    stateValueName: 'ApprovalCeiling',
    elements: [
      {
        kind: 'enum',
        valueName: 'MaxApprovalMode',
        path: ['limits', 'maxApprovalMode'],
        label: 'Broadest approval mode',
        items: [
          { value: 'ask', label: 'Ask before acting' },
          { value: 'auto', label: 'Auto' },
          { value: 'never', label: 'Never ask' },
        ],
      },
    ],
  },
  {
    kind: 'policy',
    id: 'Clients',
    title: 'Allowed clients',
    help: 'What may connect to Station servers on this machine. Without Remote, the server listens only on this machine, pairing is refused and devices paired earlier are signed out. This version requires the desktop app and a local browser.\n\nDisabled is not supported: Station will not start. Use Not Configured for no restriction.',
    limitKey: 'clients',
    stateValueName: 'Clients',
    elements: [
      {
        kind: 'checkboxes',
        path: ['limits', 'clients'],
        label: 'Allowed clients',
        items: [
          {
            valueName: 'ClientDesktop',
            item: 'desktop',
            label: 'The desktop app on this machine',
            defaultChecked: true,
          },
          {
            valueName: 'ClientLocalBrowser',
            item: 'local-browser',
            label: 'A browser on this machine',
            defaultChecked: true,
          },
          {
            valueName: 'ClientRemote',
            item: 'remote',
            label: 'Remote: phones, other computers and relays',
            defaultChecked: false,
          },
        ],
      },
    ],
  },
  {
    kind: 'switch',
    id: 'Updates',
    title: 'Allow updates',
    help: 'Disabled: Station never checks for, downloads or installs updates, for machines that receive Station through device management.\n\nEnabled or Not Configured: updates work as usual.',
    limitKey: 'updates',
    valueName: 'Updates',
    path: ['limits', 'updates', 'mode'],
    offValue: 'off',
  },
  {
    kind: 'policy',
    id: 'UpdateMirror',
    title: 'Update mirror',
    help: "An https mirror of approved Station releases that replaces the default download location on every update surface. The URL may carry an access token; it never reaches clients.\n\nDisabled is not supported: Station will not start. Use Not Configured for Station's default location.",
    limitKey: 'updates',
    stateValueName: 'UpdateMirror',
    elements: [
      {
        kind: 'text',
        valueName: 'UpdateFeedUrl',
        path: ['limits', 'updates', 'feedUrl'],
        label: 'Mirror URL (https)',
        required: true,
        maxLength: 2048,
      },
    ],
  },
  {
    kind: 'switch',
    id: 'NightlyChannel',
    title: 'Allow the nightly channel',
    help: 'Disabled: the nightly update channel is unavailable.\n\nEnabled or Not Configured: users may choose it.',
    limitKey: 'updates',
    valueName: 'NightlyChannel',
    path: ['limits', 'updates', 'allowNightly'],
    offValue: false,
  },
  {
    kind: 'policy',
    id: 'AllowedEngines',
    title: 'Allowed engines',
    help: `The only engines that may run on this machine. An engine left unchecked does not run, and neither does any plugin engine.\n\nDisabled is not supported: Station will not start. Use Not Configured to let every engine run.\n\n${NOT_A_SANDBOX}`,
    limitKey: 'engines',
    stateValueName: 'AllowedEngines',
    elements: [
      {
        kind: 'checkboxes',
        path: ['limits', 'engines', 'allowed'],
        label: 'Allowed engines',
        items: MANAGED_POLICY_ENGINE_IDS.map((id) => ({
          valueName: ENGINE_VALUE_NAMES[id],
          item: id,
          label: ENGINE_LABELS[id],
          defaultChecked: true,
        })),
      },
    ],
  },
  {
    kind: 'policy',
    id: 'RemoteTaskEngines',
    title: 'Allowed remote task engines',
    help: `The cloud coding agents users may send work to. A remote task runs on the vendor's machines: the prompt and the repository code leave this computer, and Station's sandbox and approval settings do not apply there.

On a machine with any Station policy, a vendor left unchecked is off, and so is every vendor while this policy is Not Configured.

Disabled is not supported: Station will not start. Use Not Configured to allow none.

${NOT_A_SANDBOX}`,
    limitKey: 'engines',
    stateValueName: 'RemoteTaskEngines',
    elements: [
      {
        kind: 'checkboxes',
        path: ['limits', 'engines', 'remoteTasks'],
        label: 'Allowed remote task engines',
        items: REMOTE_TASK_VENDOR_IDS.map((id) => ({
          valueName: REMOTE_TASK_VALUE_NAMES[id],
          item: id,
          label: REMOTE_TASK_VENDOR_LABELS[id],
          defaultChecked: false,
        })),
      },
    ],
  },
  {
    kind: 'switch',
    id: 'AcpRegistryAgents',
    title: 'Allow ACP registry agents',
    help: 'Disabled: ACP connections added from the public ACP registry do not run.\n\nEnabled or Not Configured: they run as usual.',
    limitKey: 'engines',
    valueName: 'AcpRegistryAgents',
    path: ['limits', 'engines', 'acpRegistryAgents'],
    offValue: false,
  },
  {
    kind: 'switch',
    id: 'EngineHostAuth',
    title: 'Allow Station to sign engines in',
    help: 'Disabled: Station gives no engine an access token from its own engine sign-in store (for example Kiro without kiro-cli). Engines that keep their own sign-in, such as kiro-cli, are unaffected.\n\nEnabled or Not Configured: Station answers an engine it launched that asks for its token.',
    limitKey: 'engines',
    valueName: 'EngineHostAuth',
    path: ['limits', 'engines', 'engineHostAuth'],
    offValue: 'off',
  },
  {
    kind: 'policy',
    id: 'EngineInstances',
    title: 'Engine launch configuration (JSON)',
    help: `How the engines Station starts are launched, as the "limits.engines.instances" object of a Station policy: for each engine, "locked" and any of "binaryPath" (absolute), "launchArgs" and "environment".\n\nRun "station policy check" on a policy file holding the same object to validate it first.\n\nDisabled is not supported: Station will not start. Use Not Configured for no pinned launch.\n\n${NOT_A_SANDBOX}`,
    limitKey: 'engines',
    stateValueName: 'EngineInstances',
    elements: [
      {
        kind: 'json',
        valueName: 'EngineInstancesJson',
        path: ['limits', 'engines', 'instances'],
        label: 'Engine launch configuration JSON',
      },
    ],
  },
];

/**
 * The controls the generated template offers: every control that is not a
 * limit, and each limit control whose key this build enforces.
 */
export function templateManagedPolicyControls(
  enforced: readonly string[] = MANAGED_POLICY_ENFORCED_LIMIT_KEYS,
): ManagedPolicyControl[] {
  return MANAGED_POLICY_CONTROLS.filter(
    (control) =>
      control.limitKey === undefined || enforced.includes(control.limitKey),
  );
}

/** Each registry value name the controls write, in their template order. */
function controlValueNames(control: ManagedPolicyControl): string[] {
  if (control.kind === 'switch') return [control.valueName];
  const names = control.stateValueName ? [control.stateValueName] : [];
  for (const element of control.elements) {
    if (element.kind === 'checkboxes')
      names.push(...element.items.map((item) => item.valueName));
    else names.push(element.valueName);
  }
  return names;
}

export type RegistryPolicyInput =
  | { kind: 'absent' }
  | { kind: 'text'; text: string }
  | { kind: 'value'; value: unknown }
  | { kind: 'problem'; reason: string };

function describeType(value: RegistryValue): string {
  return value.type === 'other' ? `type ${value.typeCode}` : value.type;
}

function setPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let node = target;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (next === undefined) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  }
  node[path[path.length - 1]] = value;
}

class RegistryMappingProblem extends Error {}

function dword(value: RegistryValue, what: string): 0 | 1 {
  if (value.type !== 'REG_DWORD' || (value.data !== 0 && value.data !== 1))
    throw new RegistryMappingProblem(
      `${what} must be a REG_DWORD of 0 or 1, but is ${value.type === 'REG_DWORD' ? `the REG_DWORD ${value.data}` : `a ${describeType(value)}`}`,
    );
  return value.data;
}

function multiString(value: RegistryValue, what: string): string[] {
  if (value.type !== 'REG_MULTI_SZ')
    throw new RegistryMappingProblem(
      `${what} must be a REG_MULTI_SZ, but is a ${describeType(value)}`,
    );
  return value.data;
}

function singleString(value: RegistryValue, what: string): string {
  if (value.type !== 'REG_SZ')
    throw new RegistryMappingProblem(
      `${what} must be a REG_SZ, but is a ${describeType(value)}`,
    );
  return value.data;
}

function jsonObject(lines: string[], what: string): unknown {
  const text = lines.join('\n');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RegistryMappingProblem(
      `${what} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const duplicate = duplicateJsonMemberPath(text);
  if (duplicate !== null)
    throw new RegistryMappingProblem(`${what} repeats the key ${duplicate}`);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new RegistryMappingProblem(`${what} must hold a JSON object`);
  return parsed;
}

function applyElement(
  element: ManagedPolicyElement,
  values: ReadonlyMap<string, RegistryValue>,
  document: Record<string, unknown>,
  title: string,
  enabled: boolean,
): void {
  const what = (valueName: string) => `${valueName} ("${title}")`;
  if (element.kind === 'checkboxes') {
    const present = element.items.filter((item) => values.has(item.valueName));
    if (present.length === 0 && !enabled) return;
    // A checkbox Group Policy did not write is unchecked: for an allow list
    // that is the narrower reading.
    const checked = element.items.filter((item) => {
      const value = values.get(item.valueName);
      return value !== undefined && dword(value, what(item.valueName)) === 1;
    });
    setPath(
      document,
      element.path,
      checked.map((item) => item.item),
    );
    return;
  }
  const value = values.get(element.valueName);
  if (value === undefined) {
    if (enabled && element.kind === 'text' && element.required)
      throw new RegistryMappingProblem(
        `"${title}" is Enabled but ${element.valueName} is missing`,
      );
    if (enabled && element.kind !== 'text')
      throw new RegistryMappingProblem(
        `"${title}" is Enabled but ${element.valueName} is missing`,
      );
    return;
  }
  switch (element.kind) {
    case 'text': {
      const text = singleString(value, what(element.valueName));
      // Group Policy writes an empty string for an optional box left blank.
      if (text === '' && !element.required) return;
      setPath(document, element.path, text);
      return;
    }
    case 'enum': {
      const text = singleString(value, what(element.valueName));
      if (!element.items.some((item) => item.value === text))
        throw new RegistryMappingProblem(
          `${what(element.valueName)} must be one of ${element.items.map((item) => `"${item.value}"`).join(', ')}`,
        );
      setPath(document, element.path, text);
      return;
    }
    case 'json':
      setPath(
        document,
        element.path,
        jsonObject(
          multiString(value, what(element.valueName)),
          what(element.valueName),
        ),
      );
      return;
    case 'lines':
      setPath(
        document,
        element.path,
        multiString(value, what(element.valueName))
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      );
      return;
  }
}

function applyControl(
  control: ManagedPolicyControl,
  values: ReadonlyMap<string, RegistryValue>,
  document: Record<string, unknown>,
): void {
  if (control.kind === 'switch') {
    const value = values.get(control.valueName);
    if (value === undefined) return;
    if (dword(value, `${control.valueName} ("${control.title}")`) === 0)
      setPath(document, control.path, control.offValue);
    return;
  }
  let enabled = false;
  if (control.stateValueName) {
    const state = values.get(control.stateValueName);
    if (state !== undefined) {
      if (dword(state, `${control.stateValueName} ("${control.title}")`) === 0)
        throw new RegistryMappingProblem(
          `the policy "${control.title}" is set to Disabled, which Station does not support for it (only "Allow …" policies can be Disabled); set it to Enabled or Not Configured`,
        );
      enabled = true;
    }
  }
  for (const element of control.elements)
    applyElement(element, values, document, control.title, enabled);
}

/**
 * What the policy key holds: nothing, the `Policy` JSON text, the document
 * the template values describe, or why it cannot be used. Value names are
 * compared without case, as the registry does.
 */
export function registryPolicyInput(
  snapshot: RegistryKeySnapshot,
): RegistryPolicyInput {
  if (snapshot.subkeys.length > 0)
    return {
      kind: 'problem',
      reason: `${WINDOWS_POLICY_KEY}\\${snapshot.subkeys[0]} is not a Station policy key; Station refuses settings it cannot enforce`,
    };
  if (snapshot.values.length === 0) return { kind: 'absent' };

  const byName = new Map<string, RegistryValue>();
  for (const value of snapshot.values)
    byName.set(value.name.toLowerCase(), value);

  const json = byName.get(WINDOWS_POLICY_JSON_VALUE.toLowerCase());
  if (json) {
    if (snapshot.values.length > 1)
      return {
        kind: 'problem',
        reason: `it holds both a ${WINDOWS_POLICY_JSON_VALUE} value and Group Policy template values (${snapshot.values
          .filter((value) => value !== json)
          .map((value) => value.name)
          .join(
            ', ',
          )}); deploy the policy one way: the single ${WINDOWS_POLICY_JSON_VALUE} value or the template`,
      };
    if (json.type !== 'REG_SZ')
      return {
        kind: 'problem',
        reason: `its ${WINDOWS_POLICY_JSON_VALUE} value must be a REG_SZ holding the policy JSON, but is a ${describeType(json)}`,
      };
    return { kind: 'text', text: json.data };
  }

  const known = new Map<string, string>();
  for (const control of MANAGED_POLICY_CONTROLS)
    for (const name of controlValueNames(control))
      known.set(name.toLowerCase(), name);
  const values = new Map<string, RegistryValue>();
  for (const value of snapshot.values) {
    const canonical = known.get(value.name.toLowerCase());
    if (canonical === undefined)
      return {
        kind: 'problem',
        reason: `${value.name} is not a Station policy value; it may be a setting from a newer Station template, and Station refuses settings it cannot enforce`,
      };
    values.set(canonical, value);
  }

  const document: Record<string, unknown> = {
    schemaVersion: MANAGED_POLICY_SCHEMA_VERSION,
  };
  try {
    for (const control of MANAGED_POLICY_CONTROLS)
      applyControl(control, values, document);
  } catch (error) {
    if (error instanceof RegistryMappingProblem)
      return { kind: 'problem', reason: error.message };
    throw error;
  }
  // The parser would name `organization`, which an administrator cannot map
  // to a Group Policy setting; name the policy instead.
  if (document.organization === undefined)
    return {
      kind: 'problem',
      reason:
        'set the "Organization" policy whenever another Station policy is set; it is missing or Disabled',
    };
  return { kind: 'value', value: document };
}

function valueAt(source: unknown, path: readonly string[]): unknown {
  let node = source;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * The template values Group Policy would write for `document`: the inverse
 * of {@link registryPolicyInput}, for the round-trip tests and for
 * administrators who script the template values. A field no control covers
 * is left out, so `registryPolicyInput(encode(document))` reproduces only
 * what the template can express; the round-trip test compares the two.
 */
export function managedPolicyRegistryValues(
  document: ManagedPolicyDocument,
): RegistryValue[] {
  const values: RegistryValue[] = [];
  for (const control of MANAGED_POLICY_CONTROLS) {
    if (control.kind === 'switch') {
      const value = valueAt(document, control.path);
      if (value === undefined) continue;
      values.push({
        name: control.valueName,
        type: 'REG_DWORD',
        data: value === control.offValue ? 0 : 1,
      });
      continue;
    }
    const present = control.elements.some(
      (element) => valueAt(document, element.path) !== undefined,
    );
    if (!present) continue;
    if (control.stateValueName)
      values.push({ name: control.stateValueName, type: 'REG_DWORD', data: 1 });
    for (const element of control.elements) {
      const value = valueAt(document, element.path);
      switch (element.kind) {
        case 'checkboxes': {
          const list = Array.isArray(value) ? value : [];
          for (const item of element.items)
            values.push({
              name: item.valueName,
              type: 'REG_DWORD',
              data: list.includes(item.item) ? 1 : 0,
            });
          break;
        }
        case 'text':
        case 'enum':
          if (typeof value === 'string')
            values.push({
              name: element.valueName,
              type: 'REG_SZ',
              data: value,
            });
          break;
        case 'json':
          if (value !== undefined)
            values.push({
              name: element.valueName,
              type: 'REG_MULTI_SZ',
              data: JSON.stringify(value, null, 2).split('\n'),
            });
          break;
        case 'lines':
          if (Array.isArray(value))
            values.push({
              name: element.valueName,
              type: 'REG_MULTI_SZ',
              data: value.map(String),
            });
          break;
      }
    }
  }
  return values;
}
