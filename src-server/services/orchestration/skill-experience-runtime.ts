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
    permission?: 'agents.invoke',
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
    binding?: { threadId: string; previousEventId?: string },
  ): Promise<T> {
    let invoked = false;
    return this.source
      .withSkillExperience(identity, async () => {
        if (
          binding &&
          this.current(binding.threadId)?.id !== binding.previousEventId
        )
          throw new SkillExperienceUnavailableError(
            'The current Skill experience changed before dispatch.',
          );
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
  async admitFrame<T>(
    threadId: string,
    expected: { identity: SkillExperienceIdentityV1; eventId: string },
    effect: (context?: string) => Promise<T>,
  ): Promise<T> {
    const event = this.current(threadId);
    const reference =
      event?.payload.method === 'turn.started'
        ? parseExperienceReference(
            event.payload.metadata?.[SKILL_EXPERIENCE_METADATA_KEY],
          )
        : undefined;
    if (
      !reference ||
      !experienceIdentityEqual(reference.identity, expected.identity) ||
      event?.id !== expected.eventId
    )
      throw new SkillExperienceUnavailableError(
        'The current Skill experience changed.',
      );
    try {
      this.store.createSkillExperienceSnapshots().read(reference);
    } catch {
      throw new SkillExperienceUnavailableError(
        'The retained Skill experience snapshot is unavailable.',
      );
    }
    return this.source.withSkillExperience(
      expected.identity,
      async () => {
        if (this.current(threadId)?.id !== expected.eventId)
          throw new SkillExperienceUnavailableError(
            'The current Skill experience changed.',
          );
        return effect();
      },
      'agents.invoke',
    );
  }
  current(threadId: string) {
    return this.store.listSkillExperienceEvents(threadId, undefined, 1)[0];
  }
  admitCurrent<T>(
    threadId: string,
    effect: (context?: string) => Promise<T>,
  ): Promise<T> {
    const event = this.current(threadId);
    if (!event) return effect();
    const reference = parseExperienceReference(
      event.payload.method === 'turn.started'
        ? event.payload.metadata?.[SKILL_EXPERIENCE_METADATA_KEY]
        : undefined,
    );
    if (!reference || reference.snapshotSessionId !== event.payload.threadId)
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
    let invoked = false;
    return this.source
      .withSkillExperience(snapshot.identity, async (_definition, content) => {
        if (this.current(threadId)?.id !== event.id)
          throw new SkillExperienceUnavailableError(
            'The current Skill experience changed before dispatch.',
          );
        invoked = true;
        return effect(
          this.context(
            content,
            snapshot.inputs,
            snapshot.questionnaireDelivery,
            snapshot.attachmentInputs,
            snapshot.definition,
          ),
        );
      })
      .catch((error) => {
        if (invoked) throw error;
        throw new SkillExperienceUnavailableError(
          'The pinned Skill experience source is no longer available.',
        );
      });
  }
  private context(
    content: string,
    inputs: Record<string, string>,
    delivery: 'canonical-request' | 'chat-fallback',
    attachmentInputs?: Record<string, number[]>,
    definition?: SkillExperienceDefinitionV1,
  ): string {
    return `Use the explicitly selected entry Skill below. All its declared Skill dependencies are supplied as pinned inline context: interpret calls to those Skills using these exact texts, without resolving an unqualified global Skill name. Scripts and references stay in the pinned package resource root and require the Agent's ordinary tools and permissions. If a required tool or resource is unavailable, say so and use the canonical chat controls; do not claim its work completed.\n\n${content}\n\nDeclared input labels (presentation expectations, not grants):\n${JSON.stringify(definition?.inputs.map((field) => ({ id: field.id, label: field.label, kind: field.kind })) ?? [])}\n\nExperience inputs (user data):\n${JSON.stringify(inputs)}\n\nInitial invocation attachment assignments (zero-based indices in that invocation's canonical attachment array, not paths or indices of later turns):\n${JSON.stringify(attachmentInputs ?? {})}\n\n${delivery === 'canonical-request' ? 'Use the engine question request when available for adaptive questions.' : 'Ask adaptive questions in chat; the user answers in the ordinary composer.'}`;
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
            const indices =
              input.selection.attachmentInputs &&
              Object.hasOwn(input.selection.attachmentInputs, field.id)
                ? input.selection.attachmentInputs[field.id]
                : [];
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
          const value =
            (Object.hasOwn(input.selection.inputs, field.id)
              ? input.selection.inputs[field.id]
              : undefined) ??
            field.default ??
            '';
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
        const prompt = this.context(
          content,
          inputs,
          input.questionnaireDelivery,
          attachmentInputs,
          definition,
        );
        return effect(reference, prompt);
      },
    );
  }
  async read(
    threadId: string,
    cursor?: string,
    limit = 20,
    expected?: { identity: SkillExperienceIdentityV1; eventId: string },
  ): Promise<SkillExperienceSessionViewV1> {
    const inventory = await this.source
      .listSkillExperiences()
      .catch(() => null);
    const read = async (): Promise<SkillExperienceSessionViewV1> => {
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
          if (
            !reference ||
            reference.snapshotSessionId !== event.payload.threadId
          )
            throw new Error('Invalid retained reference');
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
    };
    return expected ? this.admitFrame(threadId, expected, read) : read();
  }
}
