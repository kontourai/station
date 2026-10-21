/**
 * `task_note` (#4003): an agent records Task memory (a decision, completed
 * work, its current step, or an open question) in the Task document of the
 * Task its own Session is working on.
 *
 * Authority never comes from arguments: the REST side
 * (`routes/orchestration/task-note.ts`) derives the Session from the verified
 * caller and the Task from that Session's room execution binding. The tool
 * cannot name a Task and cannot change Task status.
 *
 * Loaded by the stdio station-control child too, so it imports nothing from
 * Station's services: it speaks REST (`api`).
 */
import { z } from 'zod';
import {
  TASK_NOTE_MAX_TEXT_LENGTH,
  TASK_NOTE_SECTIONS,
  type TaskNoteSection,
} from '../domain/task-memory.js';
import type { StationControlToolRegistry } from './station-control-mcp-server.js';
import { api, jsonToolResult } from './station-control-shared.js';

const TASK_NOTE_API_PATH = '/api/orchestration/station-control/task-note';

const TASK_NOTE_DESCRIPTION = `Record a note in the Task document of the Task this session is working on, so people and later sessions see it. \`section\`: "decision" (a choice made and why), "done" (completed work), "in_progress" (what this session is doing now; each call replaces this session's own previous in-progress line) or "question" (an open question for a person). \`text\`: one line, at most ${TASK_NOTE_MAX_TEXT_LENGTH} characters; longer or multi-line text is refused, not cut. Station records which session wrote it and when. It only adds lines (or replaces this session's own in-progress line); it never edits other text and never changes the Task's status. Returns \`recorded\` with the entry, or an error when this session is not working on a Task.`;

const taskNoteShape = {
  section: z
    .enum(TASK_NOTE_SECTIONS as [TaskNoteSection, ...TaskNoteSection[]])
    .describe('"decision", "done", "in_progress" or "question".'),
  text: z
    .string()
    .describe(`One line, at most ${TASK_NOTE_MAX_TEXT_LENGTH} characters.`),
};

export function registerTaskNoteTools(registry: StationControlToolRegistry) {
  registry.tool(
    'task_note',
    TASK_NOTE_DESCRIPTION,
    taskNoteShape,
    async (args) =>
      // `api` forwards this call's caller credential; the route re-verifies it.
      jsonToolResult(
        await api(TASK_NOTE_API_PATH, {
          method: 'POST',
          body: JSON.stringify({ section: args.section, text: args.text }),
        }),
      ),
  );
}
