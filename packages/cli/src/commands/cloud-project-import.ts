import { isAbsolute, join, win32 } from 'node:path';
import {
  createProject,
  getProject,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import { writeJsonDurably } from '@kontourai/station-shared/durable-json-file';
import {
  inspectWorkspacePackage,
  unpackWorkspace,
  verifyWorkspacePackage,
} from '@kontourai/station-shared/workspace-package';
import {
  configureApiCredential,
  type ParsedCoreArgs,
  resolveApiBase,
} from './core-api.js';

/** Compose the existing import and Project owners. No cloud credential or
 * authority is inferred, and a failed HTTP mutation never deletes the import. */
export async function runCloudProjectImport(
  parsed: ParsedCoreArgs,
): Promise<void> {
  const required = (key: string) => {
    const value = parsed.flags[key];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Cloud import-project requires --${key}=<value>`);
    return value;
  };
  if (
    parsed.flags.station === undefined &&
    parsed.flags['api-base'] === undefined
  )
    throw new Error(
      'Select an enrolled target explicitly with --station or --api-base',
    );
  if (parsed.flags.station !== undefined) required('station');
  if (parsed.flags['api-base'] !== undefined) required('api-base');
  const name = required('name');
  const slug = required('slug');
  if (
    name.length > 200 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ||
    slug.length > 100
  )
    throw new Error(
      'Use a name of at most 200 characters and a lowercase hyphenated slug of at most 100 characters',
    );
  const archive = required('archive');
  const keyFile = required('key-file');
  const destination = required('destination');
  // A server in Docker sees a different path from a CLI on its host. Require
  // that mapping explicitly instead of claiming local realpath is remote truth.
  const workingDirectory = required('target-workspace');
  if (
    (!isAbsolute(workingDirectory) && !win32.isAbsolute(workingDirectory)) ||
    Array.from(workingDirectory).some(
      (character) => character.charCodeAt(0) < 32,
    )
  )
    throw new Error(
      '--target-workspace must be an absolute target-visible path',
    );
  const apiBase = resolveApiBase(parsed);
  configureApiCredential(parsed, apiBase);
  const requestOptions = {
    authentication: 'required' as const,
    timeoutMs: 15_000,
  };
  inspectWorkspacePackage({ archive, keyFile });
  // An exact slug collision or auth/transport failure leaves no local import.
  try {
    await getProject(apiBase, slug, requestOptions);
  } catch (error) {
    if (!(error instanceof StationHttpError) || error.status !== 404)
      throw error;
    return await importAndRegister();
  }
  throw new Error(
    `Target Project '${slug}' already exists; choose an unused slug`,
  );

  async function importAndRegister(): Promise<void> {
    const imported = unpackWorkspace({ archive, keyFile, destination });
    let localWorkspaceVerification: ReturnType<typeof verifyWorkspacePackage>;
    try {
      // The command owns a new, unregistered private checkout and has not
      // started execution. Read it back before publishing Project registration.
      localWorkspaceVerification = verifyWorkspacePackage({
        archive,
        keyFile,
        workspace: imported.workspace,
        workspacePaused: true,
      });
    } catch {
      throw new Error(
        `Workspace retained at ${imported.workspace}. Local verification failed; no Project creation was attempted. Inspect the import before retrying.`,
      );
    }
    const request = {
      name,
      slug,
      workingDirectory,
      defaultWorkspaceIsolation: 'shared',
    };
    const requestPath = join(destination, 'workspace-project-request.json');
    // Durable intent precedes the network mutation. A crash or lost reply leaves
    // enough information for explicit reconciliation without silently retrying.
    writeJsonDurably(requestPath, {
      schemaVersion: 'station.workspace-project-request/v1',
      targetOrigin: new URL(apiBase).origin,
      workspace: imported.workspace,
      head: imported.head,
      packageSha256: localWorkspaceVerification.packageSha256,
      project: request,
      executionAuthorityTransferred: false,
    });
    try {
      const created = await createProject(apiBase, request, requestOptions);
      // Remote metadata corroboration only: expanding this path on the CLI
      // host could falsely accept a different server-visible directory.
      if (
        !created ||
        typeof created.id !== 'string' ||
        !created.id ||
        created.slug !== slug ||
        created.workingDirectory !== workingDirectory
      )
        throw new Error('Target returned an unexpected Project identity');
      const observed = await getProject(apiBase, slug, requestOptions);
      // Keep the target read-back byte-exact for the same remote-path reason.
      if (
        !observed ||
        observed.id !== created.id ||
        observed.slug !== slug ||
        observed.workingDirectory !== workingDirectory
      )
        throw new Error('Target Project read-back did not match creation');
      const receipt = {
        schemaVersion: 'station.workspace-project-registration/v1',
        status: 'registered',
        targetOrigin: new URL(apiBase).origin,
        workspace: imported.workspace,
        targetWorkspace: workingDirectory,
        head: imported.head,
        project: { id: created.id, slug },
        localWorkspaceVerification,
        targetFilesystemVerification: 'required',
        credentialEnrollment: 'not-performed',
        executionAuthorityTransferred: false,
      };
      writeJsonDurably(
        join(destination, 'workspace-project-registration.json'),
        receipt,
      );
      console.log(JSON.stringify(receipt, null, 2));
    } catch {
      // Do not persist or echo arbitrary server error bodies, which can contain
      // sensitive configuration. A 409 race also retains the imported bytes.
      throw new Error(
        `Workspace retained at ${imported.workspace}. Project registration is unconfirmed; inspect '${slug}' on the selected target before retrying. Review ${requestPath}. No automatic retry or cleanup was performed.`,
      );
    }
  }
}
