// Commit-message structured output (pure, unit-tested).
import { stripFences } from './sse';

/** Structured output schema for commit messages (docs.x.ai/developers/model-capabilities/text/structured-outputs). */
export const COMMIT_FORMAT = {
  type: 'json_schema',
  name: 'commit_message',
  schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Conventional-commit subject line, imperative, under 72 characters' },
      body: { type: 'array', items: { type: 'string' }, description: 'Short bullet points explaining the change; may be empty' },
    },
    required: ['subject', 'body'],
    additionalProperties: false,
  },
  strict: true,
};

/** Render a structured commit message; falls back to the raw text when it is not the expected JSON. */
export function renderCommitMessage(raw: string): string {
  try {
    const j = JSON.parse(stripFences(raw).trim()) as { subject?: unknown; body?: unknown };
    if (typeof j.subject === 'string' && j.subject.trim()) {
      const body = Array.isArray(j.body) ? j.body.filter((b): b is string => typeof b === 'string' && !!b.trim()).map(b => '- ' + b.trim().replace(/^[-*]\s*/, '')) : [];
      return j.subject.trim() + (body.length ? '\n\n' + body.join('\n') : '');
    }
  } catch { /* not JSON */ }
  return stripFences(raw).trim();
}
