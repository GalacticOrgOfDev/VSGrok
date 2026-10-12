// Route API errors to the chat as error cards instead of VS Code notifications.
export interface ErrorCard { msg: string; kind: string; attempts?: number; source?: string }
let sink: ((c: ErrorCard) => void) | undefined;
export function setErrorSink(s: ((c: ErrorCard) => void) | undefined) { sink = s; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function reportError(e: any, source?: string): void {
  const c: ErrorCard = { msg: String(e?.message ?? e), kind: String(e?.kind ?? 'generic'), attempts: typeof e?.attempts === 'number' ? e.attempts : undefined, source };
  if (c.kind === 'aborted') { return; }
  sink?.(c);
}
