import type { Skill } from '@kontourai/station-contracts/catalog';
import {
  resolveSkillCommandName,
  skillCommandSlug,
} from '@kontourai/station-contracts/skill-command';
import { useSkillsQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import type { KeyboardShortcut } from '../contexts/KeyboardShortcutsContext';
import { useToast } from '../contexts/ToastContext';
import { useKeyboardShortcut } from '../hooks/useKeyboardShortcut';

/**
 * One bindable chord: the device-settings key it is stored under, what to call
 * it, and the command it types.
 *
 * The stored key is the skill's NAME slug, not its command word: a user rebinds
 * a chord to "that skill", and renaming the command word must not silently drop
 * the chord they set.
 */
interface ShortcutTarget {
  slug: string;
  name: string;
  cmd: string;
}

/**
 * A chord typed INTO the composer is text, not a command; ditto inside a
 * terminal or under a dialog (dock shortcuts already
 * declared this, these did not).
 *
 * Hoisted to a module constant because it is a dependency of the registering
 * effect: a fresh object literal per render re-registers on every render.
 */
const SKILL_SHORTCUT_WHEN: KeyboardShortcut['when'] = {
  and: [
    { not: 'composerFocused' },
    { not: 'terminalFocused' },
    { not: 'dialogOpen' },
  ],
};

const NO_MODIFIERS: KeyboardShortcut['modifiers'] = [];

/**
 * One skill's chord, registered through the same primitive every other
 * shortcut in the app uses.
 *
 * The chord ITSELF is not read here. `KeyboardShortcutsProvider.resolveShortcut`
 * already applies the stored `skillShortcuts` override to any `skill.*` id, so
 * this registers the unbound base — no chord, not dispatching — and the
 * override supplies the binding. Reading the same device setting a second time
 * to pre-apply it was a second derivation of one fact, and it is what put a
 * changing value in the registering effect's dependencies.
 */
function SkillShortcut({
  target,
  hasContext,
  onRun,
}: {
  target: ShortcutTarget;
  hasContext: boolean;
  onRun: (target: { cmd: string; name: string }) => void;
}) {
  const { showToast } = useToast();
  useKeyboardShortcut(
    `skill.${target.slug}.run`,
    '',
    NO_MODIFIERS,
    `Run /${target.cmd}`,
    () => {
      if (!hasContext) {
        showToast('Open a chat before running a shortcut.', 'warning');
        return;
      }
      onRun({ cmd: `/${target.cmd}`, name: target.name });
    },
    true,
    0,
    SKILL_SHORTCUT_WHEN,
    true,
  );
  return null;
}

export function SkillShortcutRegistrar({
  hasContext,
  onRun,
}: {
  hasContext: boolean;
  onRun: (target: { cmd: string; name: string }) => void;
}) {
  const { data: skills = [] } = useSkillsQuery() as { data?: Skill[] };

  const targets: ShortcutTarget[] = useMemo(
    () =>
      // Only command skills: a chord that "runs" a skill with no command word
      // would have nothing to type into the composer.
      skills.flatMap((skill) => {
        const command = resolveSkillCommandName(skill);
        return command
          ? [
              {
                slug: skillCommandSlug(skill.name),
                name: skill.name,
                cmd: command,
              },
            ]
          : [];
      }),
    [skills],
  );

  // One child per skill, so each registration is a hook with its own
  // lifecycle. The previous shape registered every skill inside ONE effect
  // whose dependencies included the `onRun` callback identity; every render of
  // the dock re-ran it, and while `register` still re-rendered the whole
  // context that was an unbounded loop (React archive#185, archive#3736).
  return (
    <>
      {targets.map((target) => (
        <SkillShortcut
          key={target.slug}
          target={target}
          hasContext={hasContext}
          onRun={onRun}
        />
      ))}
    </>
  );
}
