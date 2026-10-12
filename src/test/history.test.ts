import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { titleFrom, sanitize, prepareRecord, indexEntry, searchIndex, transcriptToItems, toMarkdown, slug, MAX_RECORD_BYTES, ChatRecord } from '../historyCore';

const rec = (over: Partial<ChatRecord> = {}): ChatRecord => ({ v: 1, id: 'cabc123', title: 'Fix the parser', created: 0, updated: Date.UTC(2026, 9, 12, 18, 0), model: 'grok-4.7',
  messages: [{ role: 'user', text: 'Why does parse() fail?', ts: 1 }, { role: 'assistant', text: 'Because **x** is null.', ts: 2, state: 'done' }], ...over });

test('history: titles, slugs', () => {
  assert.equal(titleFrom('\n  How do I   fix this?\nmore'), 'How do I fix this?');
  assert.equal(titleFrom('x'.repeat(80)).length, 60);
  assert.equal(slug('Fix the Parser!! (v2)'), 'fix-the-parser-v2'); assert.equal(slug('???'), 'chat');
});

test('history: sanitize redacts secrets, drops images, keeps encrypted reasoning opaque', () => {
  const s = sanitize({ items: [{ role: 'user', content: [{ type: 'input_text', text: 'key xai-AAAAAAAAAAAAAAAA and token=abc123' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
    { type: 'reasoning', encrypted_content: 'sk-ABCDEFGHIJKLMNOPQRSTUV' }] });
  const j = JSON.stringify(s);
  assert.doesNotMatch(j, /xai-AAAA|abc123|data:image/); assert.match(j, /\[image omitted from saved chat\]/);
  assert.equal(s.items[1].encrypted_content, 'sk-ABCDEFGHIJKLMNOPQRSTUV');
});

test('history: oversized records drop conv first, then oldest messages', () => {
  const big = 'x'.repeat(MAX_RECORD_BYTES);
  const p = prepareRecord(rec({ conv: { items: [{ role: 'user', content: big }], previousResponseId: 'resp_1' } }));
  assert.equal(p.droppedConv, true); assert.deepEqual(p.record.conv, { items: [], previousResponseId: 'resp_1' });
  const msgs = Array.from({ length: 6 }, (_, i) => ({ role: 'user' as const, text: 'y'.repeat(MAX_RECORD_BYTES / 4), ts: i }));
  const q = prepareRecord(rec({ messages: msgs }));
  assert.ok(q.json.length <= MAX_RECORD_BYTES); assert.ok(q.record.messages.length < 6);
});

test('history: index + search (all words, newest first)', () => {
  const a = indexEntry(rec()); const b = indexEntry(rec({ id: 'cdef456', title: 'Docker setup', updated: a.updated + 1, messages: [{ role: 'user', text: 'compose file', ts: 1 }] }));
  assert.equal(a.preview, 'Because **x** is null.');
  assert.deepEqual(searchIndex([a, b], '').map(e => e.id), ['cdef456', 'cabc123']);
  assert.deepEqual(searchIndex([a, b], 'PARSE null').map(e => e.id), ['cabc123']);
  assert.deepEqual(searchIndex([a, b], 'compose').map(e => e.id), ['cdef456']);
  assert.deepEqual(searchIndex([a, b], 'nothing-here'), []);
});

test('history: transcript → items for resume; Markdown export', () => {
  const items = transcriptToItems([...rec().messages, { role: 'user', text: 'see pic', ts: 3, imageNames: ['a.png'] }, { role: 'assistant', text: 'boom', ts: 4, state: 'error' }]);
  assert.deepEqual(items.map(i => i.role), ['user', 'assistant', 'user']);
  assert.match(items[2].content, /1 image\(s\) were attached/);
  const md = toMarkdown(rec({ messages: [...rec().messages, { role: 'assistant', text: 'token=hunter2', ts: 3, state: 'stopped' }] }));
  assert.match(md, /^# Fix the parser\n\n_Exported from VSGrok · 2026-10-12 18:00 UTC · grok-4.7 · 3 messages_/);
  assert.match(md, /## You\n\nWhy does parse\(\) fail\?\n\n## Grok\n\nBecause \*\*x\*\* is null\./);
  assert.match(md, /token=\[redacted\]\n\n_\(stopped\)_/);
});
