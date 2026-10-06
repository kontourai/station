import {
  inspectSkillLibrary,
  readSkillExperienceReview,
  reviewSkillExperiencePackage,
  skillExperiencePackageDigest,
} from '@kontourai/station-shared/skill-experience-workflow';

export function runExperienceCommand(args: string[]): void {
  const [action, path, ...options] = args;
  const entries =
    options
      .find((arg) => arg.startsWith('--entries='))
      ?.slice(10)
      .split(',') ?? [];
  if (!path || !entries.length)
    throw new Error(
      'Usage: station plugin experience inspect <library> --entries=<skill,...> | review <plugin> --library=<path> --entries=<skill,...> --receipt=<json>',
    );
  if (action === 'inspect') {
    if (options.some((arg) => !arg.startsWith('--entries=')))
      throw new Error('Unknown experience inspect option');
    console.log(JSON.stringify(inspectSkillLibrary(path, entries), null, 2));
    return;
  }
  if (action !== 'review')
    throw new Error(`Unknown experience action: ${action}`);
  if (
    options.some(
      (arg) =>
        !['--entries=', '--library=', '--receipt='].some((prefix) =>
          arg.startsWith(prefix),
        ),
    )
  )
    throw new Error('Unknown experience review option');
  const library = options
    .find((arg) => arg.startsWith('--library='))
    ?.slice(10);
  const receipt = options
    .find((arg) => arg.startsWith('--receipt='))
    ?.slice(10);
  if (!library) throw new Error('Experience review requires --library=<path>');
  if (!receipt) {
    console.log(
      JSON.stringify(
        {
          packageDigest: skillExperiencePackageDigest(path),
          sourceDigest: inspectSkillLibrary(library, entries).digest,
          status: 'needs-review',
        },
        null,
        2,
      ),
    );
    return;
  }
  const review = readSkillExperienceReview(receipt);
  console.log(
    JSON.stringify(
      reviewSkillExperiencePackage(path, library, entries, review),
      null,
      2,
    ),
  );
}
