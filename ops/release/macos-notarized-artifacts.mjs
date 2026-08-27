import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const MAX_CODESIGN_REQUIREMENT_STREAM_BYTES = 64 * 1024;

function exec(program, args, capture = false) {
  const isDesignatedRequirementQuery = program === 'codesign' && args.includes('-r-');
  const result = spawnSync(program, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true, ...(isDesignatedRequirementQuery ? { maxBuffer: MAX_CODESIGN_REQUIREMENT_STREAM_BYTES } : {}) });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} failed with status ${result.status}.`);
  return capture ? { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' } : '';
}
function captured(value) { return typeof value === 'string' ? { status: 0, stdout: value, stderr: '' } : value; }
function need(value, name) { if (!value) throw new Error(`Expected ${name}.`); return value; }
const DEVELOPER_ID_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.6';
const DEVELOPER_ID_APPLICATION_OID = '1.2.840.113635.100.6.1.13';
const KONTOUR_TEAM_ID = 'U7KHF2QAC4';

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function existsClause(certificateSelector) {
  return new RegExp(
    `\\b${certificateSelector}\\s*(?:/\\*\\s*)?exists\\b(?:\\s*\\*/)?`,
  );
}

/**
 * `codesign -d -r-` has emitted both of these complete, line-oriented forms:
 *
 *   designated => <requirement>
 *   Designated Requirement=<requirement>
 *
 * Treat diagnostics as untrusted input. A release must observe exactly one
 * complete form across the separately-captured output streams, rather than
 * selecting a convenient line from mixed output.
 */
export function outerAppDesignatedRequirement(output) {
  const streams = typeof output === 'string'
    ? [{ name: 'output', value: output }]
    : [{ name: 'stdout', value: output?.stdout }, { name: 'stderr', value: output?.stderr }];
  const records = [];
  let malformed = false;
  let diagnostics = 0;
  for (const { name, value } of streams) {
    if (typeof value !== 'string') throw new Error(`Outer app designated requirement ${name} must be text.`);
    if (Buffer.byteLength(value, 'utf8') > MAX_CODESIGN_REQUIREMENT_STREAM_BYTES) throw new Error(`Outer app designated requirement ${name} exceeds the capture limit.`);
    for (const line of value.split(/\r?\n/)) {
      if (line === '') continue;
      const canonical = line.match(/^\s*designated =>\s+(identifier\b.*\S)\s*$/);
      const legacy = line.match(/^\s*Designated Requirement\s*=\s*(identifier\b.*\S)\s*$/);
      if (canonical || legacy) records.push((canonical ?? legacy)[1]);
      else if (/^Executable=.+\S$/.test(line)) diagnostics += 1;
      else malformed = true;
    }
  }
  if (malformed || diagnostics > 1 || records.length !== 1) {
    throw new Error('Outer app designated requirement must be reported exactly once in one supported codesign form.');
  }
  return records[0];
}

export function assertOuterAppCertificateBackedRequirement(output, bundleId) {
  const requirement = outerAppDesignatedRequirement(output);
  const requiredClauses = [
    new RegExp(`\\bidentifier\\s+"${escapedRegExp(bundleId)}"(?=\\s|$)`),
    /\banchor\s+apple\s+generic\b/,
    existsClause(`certificate\\s+1\\s*\\[\\s*field\\.${escapedRegExp(DEVELOPER_ID_INTERMEDIATE_OID)}\\s*\\]`),
    existsClause(`certificate\\s+leaf\\s*\\[\\s*field\\.${escapedRegExp(DEVELOPER_ID_APPLICATION_OID)}\\s*\\]`),
    new RegExp(`\\bcertificate\\s+leaf\\s*\\[\\s*subject\\.OU\\s*\\]\\s*=\\s*"?${KONTOUR_TEAM_ID}"?(?=\\s|$)`),
  ];
  const combinedOutput = typeof output === 'string' ? output : `${output?.stdout}\n${output?.stderr}`;
  if (
    /\bcdhash\b/i.test(combinedOutput) ||
    /\b(?:or|not)\b/i.test(requirement) ||
    requiredClauses.some((clause) => !clause.test(requirement))
  ) {
    throw new Error('Outer app designated requirement must be certificate-backed for the expected bundle identifier and Kontour Developer ID team.');
  }
  return requirement;
}

function submit(run, file, key, keyId, issuer) {
  const out = captured(run('xcrun', ['notarytool', 'submit', file, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait', '--output-format', 'json'], true));
  let receipt; try { receipt = JSON.parse(out.stdout); } catch { throw new Error('notarytool did not return JSON.'); }
  if (receipt.status !== 'Accepted') throw new Error(`notarytool rejected ${basename(file)}.`);
}

export function createMacosNotarizedArtifacts(options, injected = {}) {
  const run = injected.run ?? exec;
  const fs = injected.fs ?? { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync };
  const app = need(options.app, 'app'); const identity = need(options.identity, 'identity');
  const key = need(options.notaryKey, 'notaryKey'); const keyId = need(options.notaryKeyId, 'notaryKeyId');
  const issuer = need(options.notaryIssuer, 'notaryIssuer'); const assets = need(options.assetsDir, 'assetsDir');
  const tag = need(options.releaseTag, 'releaseTag'); const arch = need(options.architecture, 'architecture');
  const bundleId = need(options.bundleId, 'bundleId');
  if (!['aarch64', 'x86_64'].includes(arch)) throw new Error('Expected a canonical macOS architecture.');
  if (!fs.existsSync(app)) throw new Error('Staged app does not exist.');
  if (!fs.existsSync(key)) throw new Error('Notary API key file does not exist.');
  const appName = basename(app); if (!appName.endsWith('.app')) throw new Error('Expected a staged application bundle.');
  fs.mkdirSync(assets, { recursive: true });
  const root = fs.mkdtempSync(join(tmpdir(), 'station-macos-release-')); const mount = join(root, 'mounted');
  const dmgRoot = join(root, 'dmg-root'); const zip = join(root, 'notarization-input.zip');
  const prefix = `station-${tag}-macos-${arch}`; const dmg = join(assets, `${prefix}.dmg`); const updater = join(assets, `${prefix}.app.tar.gz`);
  try {
    run('node', ['ops/nightly/macos-embedded-signing.mjs', app, identity]);
    run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', app]);
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const actualBundleId = captured(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(app, 'Contents/Info.plist')], true)).stdout.trim();
    if (actualBundleId !== bundleId) throw new Error('Staged app bundle identifier does not match the release channel.');
    const metadata = captured(run('codesign', ['-dvv', app], true)).stderr;
    for (const field of ['Authority=Developer ID Application: Kontour AI LLC (U7KHF2QAC4)', 'TeamIdentifier=U7KHF2QAC4', 'Timestamp=', 'runtime']) if (!metadata.includes(field)) throw new Error(`Outer app signing metadata lacks ${field}.`);
    const dr = captured(run('codesign', ['-d', '-r-', app], true));
    if (dr.status !== 0) throw new Error(`codesign designated requirement query failed with status ${dr.status}.`);
    assertOuterAppCertificateBackedRequirement(dr, bundleId);
    const entitlementOutput = captured(run('codesign', ['-d', '--entitlements', '-', '--xml', app], true));
    const entitlementDiagnostic = `Executable=${app}`;
    if (entitlementOutput.status !== 0 || entitlementOutput.stdout !== '' || /[\r\n]/.test(app) || (entitlementOutput.stderr !== entitlementDiagnostic && entitlementOutput.stderr !== `${entitlementDiagnostic}\n`)) throw new Error('Outer app has unexpected entitlements.');
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]); submit(run, zip, key, keyId, issuer);
    run('xcrun', ['stapler', 'staple', app]); run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    fs.mkdirSync(dmgRoot, { recursive: true }); run('ditto', [app, join(dmgRoot, appName)]);
    run('hdiutil', ['create', '-volname', 'Station', '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmg]);
    run('codesign', ['--force', '--sign', identity, '--timestamp', dmg]); submit(run, dmg, key, keyId, issuer);
    run('xcrun', ['stapler', 'staple', dmg]); run('xcrun', ['stapler', 'validate', dmg]);
    run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', dmg]);
    fs.mkdirSync(mount, { recursive: true }); run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
    const files = fs.readdirSync(mount); if (files.length !== 1 || files[0] !== appName) throw new Error('DMG must contain exactly the staged application bundle.');
    const mounted = join(mount, appName); run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', mounted]); if (captured(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(mounted, 'Contents/Info.plist')], true)).stdout.trim() !== bundleId) throw new Error('Mounted app bundle identifier does not match the release channel.'); run('spctl', ['--assess', '--type', 'execute', '--verbose=4', mounted]); run('hdiutil', ['detach', mount]);
    run('tar', ['-C', join(app, '..'), '-czf', updater, appName]); run('tar', ['-tzf', updater]); run('npx', ['tauri', 'signer', 'sign', updater]);
    if (!fs.existsSync(`${updater}.sig`)) throw new Error('Tauri updater signer did not produce a signature.');
    return { dmg, updater, signature: `${updater}.sig` };
  } finally { try { run('hdiutil', ['detach', mount]); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const raw = {}; for (let i = 2; i < process.argv.length; i += 2) { if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1] || raw[process.argv[i]]) throw new Error('Expected unique --name value arguments.'); raw[process.argv[i]] = process.argv[i + 1]; }
  createMacosNotarizedArtifacts({ app: raw['--app'], identity: raw['--identity'], notaryKey: raw['--notary-key'], notaryKeyId: raw['--notary-key-id'], notaryIssuer: raw['--notary-issuer'], assetsDir: raw['--assets-dir'], releaseTag: raw['--release-tag'], architecture: raw['--architecture'], bundleId: raw['--bundle-id'] });
}
