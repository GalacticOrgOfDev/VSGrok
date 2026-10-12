// Chat history: record shape, titles, search, Markdown export, and sanitising before anything is written. Pure.
import { redact } from './diagLog';

export interface TranscriptMsg { role: 'user' | 'assistant'; text: string; imageNames?: string[]; ts: number; state?: 'done' | 'stopped' | 'error' }
export interface ChatRecord {
  v: 1;
  id: string;
  title: string;
  /** True once the user renamed it (auto-titles stop updating). */
  titled?: boolean;
  created: number;
  updated: number;
  model?: string;
  messages: TranscriptMsg[];
  /** Responses API state (images stripped, secrets redacted). Absent when too large or for Chat Completions chats. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conv?: { items: any[]; previousResponseId?: string };
  noStore?: boolean;
  convId?: string;
}
export interface ChatIndexEntry { id: string; title: string; created: number; updated: number; count: number; preview: string; text: string }

export const MAX_CHATS = 200;
export const MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const INDEX_TEXT_CHARS = 4000;

export function titleFrom(text: string): string {
  const l = String(text).split('\n').map(x => x.trim()).find(Boolean) ?? 'New chat';
  const t = l.replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

/** Deep-copy JSON-ish data with every string redacted and input_image parts replaced by a placeholder. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sanitize(v: any): any {
  if (typeof v === 'string') { return redact(v); }
  if (Array.isArray(v)) { return v.map(sanitize); }
  if (v && typeof v === 'object') {
    if (v.type === 'input_image') { return { type: 'input_text', text: '[image omitted from saved chat]' }; }
    if (v.type === 'image_url') { return { type: 'text', text: '[image omitted from saved chat]' }; }
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      // encrypted_content is opaque ciphertext from xAI; redaction patterns must not mangle it.
      o[k] = k === 'encrypted_content' && typeof x === 'string' ? x : sanitize(x);
    }
    return o;
  }
  return v;
}

/** Build the record to write: sanitised, conv dropped if the result would be too large. */
export function prepareRecord(r: ChatRecord): { record: ChatRecord; json: string; droppedConv: boolean } {
  const rec: ChatRecord = sanitize({ ...r, messages: r.messages.map(m => ({ ...m })) });
  let json = JSON.stringify(rec);
  let droppedConv = false;
  if (json.length > MAX_RECORD_BYTES && rec.conv) {
    rec.conv = { items: [], previousResponseId: rec.conv.previousResponseId };
    json = JSON.stringify(rec); droppedConv = true;
  }
  if (json.length > MAX_RECORD_BYTES) {
    // Still too large: keep the newest messages that fit.
    while (rec.messages.length > 2 && json.length > MAX_RECORD_BYTES) { rec.messages.shift(); json = JSON.stringify(rec); }
  }
  return { record: rec, json, droppedConv };
}

export function indexEntry(r: ChatRecord): ChatIndexEntry {
  const text = r.messages.map(m => m.text).join('\n').slice(0, INDEX_TEXT_CHARS);
  const firstAnswer = r.messages.find(m => m.role === 'assistant')?.text ?? '';
  return { id: r.id, title: r.title, created: r.created, updated: r.updated, count: r.messages.length, preview: firstAnswer.replace(/\s+/g, ' ').slice(0, 120), text: redact(text) };
}

/** Case-insensitive search over title and text; every word must match. Newest first. */
export function searchIndex(entries: ChatIndexEntry[], query: string): ChatIndexEntry[] {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const sorted = [...entries].sort((a, b) => b.updated - a.updated);
  if (!words.length) { return sorted; }
  return sorted.filter(e => { const hay = (e.title + '\n' + e.text).toLowerCase(); return words.every(w => hay.includes(w)); });
}

/** Rebuild model input from the transcript (resume when the stored conv is missing). */
export function transcriptToItems(msgs: TranscriptMsg[]): { role: 'user' | 'assistant'; content: string }[] {
  return msgs.filter(m => m.text.trim() && m.state !== 'error').map(m => ({ role: m.role, content: m.text + (m.imageNames?.length ? `\n[${m.imageNames.length} image(s) were attached; not kept in saved chats]` : '') }));
}

export function slug(title: string): string {
  return (String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'chat');
}

export function toMarkdown(r: ChatRecord): string {
  const d = new Date(r.updated).toISOString().slice(0, 16).replace('T', ' ');
  const out = [`# ${r.title.replace(/\n/g, ' ')}`, '', `_Exported from VSGrok · ${d} UTC${r.model ? ' · ' + r.model : ''} · ${r.messages.length} messages_`, ''];
  for (const m of r.messages) {
    out.push(m.role === 'user' ? '## You' : '## Grok', '');
    out.push(redact(m.text).trimEnd() || '_(empty)_');
    if (m.imageNames?.length) { out.push('', `_Images: ${m.imageNames.join(', ')}_`); }
    if (m.state === 'stopped') { out.push('', '_(stopped)_'); }
    if (m.state === 'error') { out.push('', '_(error)_'); }
    out.push('');
  }
  return out.join('\n');
}

