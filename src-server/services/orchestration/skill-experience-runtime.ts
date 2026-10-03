import { SKILL_EXPERIENCE_METADATA_KEY } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  SkillExperienceDefinitionV1,
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
  SkillExperienceInvocationReferenceV1,
  SkillExperienceInvocationV1,
  SkillExperienceSessionInvocationV1,
  SkillExperienceSessionViewV1,
  SkillExperienceStartInputV1,
} from '@kontourai/station-contracts/skill-experience';
import type { EventStore } from './event-store.js';
import {
  experienceIdentityEqual,
  parseExperienceReference,
} from './skill-experience-model.js';

export interface SkillExperienceSource {
  listSkillExperiences(): Promise<SkillExperienceInventoryV1>;
  withSkillExperience<T>(
    identity: SkillExperienceIdentityV1,
    effect: (
      definition: SkillExperienceDefinitionV1,
      content: string,
    ) => Promise<T>,
  ): Promise<T>;
}

export class SkillExperienceUnavailableError extends Error {}

export class SkillExperienceRuntime {
  constructor(
    private readonly store: EventStore,
    private readonly source: SkillExperienceSource,
  ) {}
  admitSelection<T>(
    identity: SkillExperienceIdentityV1,
    effect: () => Promise<T>,
  ): Promise<T> {
    let invoked = false;
    return this.source
      .withSkillExperience(identity, async () => {
        invoked = true;
        return effect();
      })
      .catch((error) => {
        if (invoked) throw error;
        throw new SkillExperienceUnavailableError(
          'The pinned Skill experience source is no longer available.',
        );
      });
  }
  current(threadId: string) {
    return this.store.listSkillExperienceEvents(threadId, undefined, 1)[0];
  }
  async admitCurrent<T>(
    threadId: string,
    effect: () => Promise<T>,
  ): Promise<T> {
    const event = this.current(threadId);
    if (!event) return effect();
    const reference = parseExperienceReference(
      event.payload.method === 'turn.started'
        ? event.payload.metadata?.[SKILL_EXPERIENCE_METADATA_KEY]
        : undefined,
    );
    if (!reference)
      throw new SkillExperienceUnavailableError(
        'The current Skill experience cannot be verified.',
      );
    let snapshot: SkillExperienceInvocationV1;
    try {
      snapshot = this.store.createSkillExperienceSnapshots().read(reference);
    } catch {
      throw new SkillExperienceUnavailableError(
        'The retained Skill experience is unavailable.',
      );
    }
    return this.admitSelection(snapshot.identity, effect);
  }
  async start<T>(
    input: {
      threadId: string;
      clientTurnId: string;
      selection: SkillExperienceStartInputV1;
      hasProject: boolean;
      hasConversation: boolean;
      attachmentCount: number;
      questionnaireDelivery: 'canonical-request' | 'chat-fallback';
    },
    effect: (
      reference: SkillExperienceInvocationReferenceV1,
      prompt: string,
    ) => Promise<T>,
  ): Promise<T> {
    return this.source.withSkillExperience(
      input.selection.identity,
      async (definition, content) => {
        const previous = this.current(input.threadId);
        if (input.selection.expectedPreviousInvocationEventId !== previous?.id)
          throw new Error(
            'The current Skill experience changed. Refresh before continuing.',
          );
        if (previous) {
          const reference = parseExperienceReference(
            previous.payload.method === 'turn.started'
              ? previous.payload.metadata?.[SKILL_EXPERIENCE_METADATA_KEY]
              : undefined,
          );
          if (!reference)
            throw new Error('The current Skill experience is unavailable.');
          const snapshot = this.store
            .createSkillExperienceSnapshots()
            .read(reference);
          if (
            !experienceIdentityEqual(
              snapshot.identity,
              input.selection.identity,
            ) &&
            (snapshot.identity.pluginId !== input.selection.identity.pluginId ||
              snapshot.identity.incarnation !==
                input.selection.identity.incarnation ||
              snapshot.identity.materialization !==
                input.selection.identity.materialization ||
              !snapshot.definition.transitions?.some(
                (stage) => stage.experienceId === definition.id,
              ))
          )
            throw new Error(
              'This transition is not declared by the current experience.',
            );
        }
        for (const context of definition.requiredContext)
          if (
            context.required &&
            !(context.kind === 'project'
              ? input.hasProject
              : input.hasConversation)
          )
            throw new Error(
              `This experience requires ${context.kind} context.`,
            );
        const inputs: Record<string, string> = {};
        const attachmentInputs: Record<string, number[]> = {};
        for (const key of Object.keys(input.selection.inputs))
          if (
            !definition.inputs.some(
              (field) => field.id === key && field.kind !== 'attachments',
            )
          )
            throw new Error('An input is not declared by this experience.');
        for (const key of Object.keys(input.selection.attachmentInputs ?? {}))
          if (
            !definition.inputs.some(
              (field) => field.id === key && field.kind === 'attachments',
            )
          )
            throw new Error(
              'An attachment input is not declared by this experience.',
            );
        for (const field of definition.inputs) {
          if (field.kind === 'attachments') {
            const indices = input.selection.attachmentInputs?.[field.id] ?? [];
            if (
              (field.required && !indices.length) ||
              indices.length > field.maxCount ||
              new Set(indices).size !== indices.length ||
              indices.some(
                (index) =>
                  !Number.isInteger(index) ||
                  index < 0 ||
                  index >= input.attachmentCount,
              )
            )
              throw new Error(`Invalid attachments for ${field.label}.`);
            attachmentInputs[field.id] = indices;
            continue;
          }
          const value = input.selection.inputs[field.id] ?? field.default ?? '';
          const textLength = Array.from(value).length;
          if (
            (field.required && !value.trim()) ||
            (field.kind === 'text' &&
              (textLength > field.maxLength ||
                (value.length > 0 && textLength < (field.minLength ?? 0)))) ||
            (field.kind === 'single-choice' &&
              value !== '' &&
              !field.options.some((option) => option.value === value))
          )
            throw new Error(`Invalid input for ${field.label}.`);
          inputs[field.id] = value;
        }
        const reference = this.store
          .createSkillExperienceSnapshots()
          .record(input.threadId, {
            version: '1.0',
            identity: input.selection.identity,
            definition,
            inputs,
            clientTurnId: input.clientTurnId,
            ...(Object.keys(attachmentInputs).length
              ? { attachmentInputs }
              : {}),
            ...(previous ? { previousInvocationEventId: previous.id } : {}),
            questionnaireDelivery: input.questionnaireDelivery,
          });
        const prompt = `Use the following selected Skill to guide this turn.\n\n${content}\n\nExperience inputs (user data):\n${JSON.stringify(inputs)}\n\n${input.questionnaireDelivery === 'canonical-request' ? 'Use the engine question request when available for adaptive questions.' : 'Ask adaptive questions in chat; the user answers in the ordinary composer.'}`;
        return effect(reference, prompt);
      },
    );
  }
  async read(
    threadId: string,
    cursor?: string,
    limit = 20,
  ): Promise<SkillExperienceSessionViewV1> {
    const inventory = await this.source
      .listSkillExperiences()
      .catch(() => null);
    const current = this.current(threadId);
    const events = this.store.listSkillExperienceEvents(
      threadId,
      cursor,
      limit + 1,
    );
    const project = async (event: {
      id: string;
      payload: CanonicalRuntimeEvent;
    }): Promise<SkillExperienceSessionInvocationV1> => {
      const reference = parseExperienceReference(
        event.payload.method === 'turn.started'
          ? event.payload.metadata?.[SKILL_EXPERIENCE_METADATA_KEY]
          : undefined,
      );
      const base = {
        eventId: event.id,
        threadId: event.payload.threadId,
        ...(event.payload.turnId ? { turnId: event.payload.turnId } : {}),
        ...(reference ? { reference } : {}),
      };
      try {
        if (!reference) throw new Error('Invalid retained reference');
        const snapshot = this.store
          .createSkillExperienceSnapshots()
          .read(reference);
        try {
          if (
            !inventory?.experiences.some((entry) =>
              experienceIdentityEqual(entry.identity, snapshot.identity),
            )
          )
            throw new Error('Source unavailable');
          return { ...base, snapshot, availability: { status: 'available' } };
        } catch {
          return {
            ...base,
            snapshot,
            availability: {
              status: 'source-unavailable',
              message:
                'This installed Skill source is no longer available. History remains readable.',
            },
          };
        }
      } catch {
        return {
          ...base,
          snapshot: null,
          availability: {
            status: 'snapshot-unavailable',
            message: 'The retained experience snapshot is unavailable.',
          },
        };
      }
    };
    const history = await Promise.all(events.slice(0, limit).map(project));
    return {
      current: current ? await project(current) : null,
      history,
      hasMore: events.length > limit,
      ...(events.length > limit ? { nextCursor: events[limit - 1].id } : {}),
    };
  }
}
