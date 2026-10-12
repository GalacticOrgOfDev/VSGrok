import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { buildInlineEditMessages, cleanReplacement, cleanPartial, lineDiff, diffStats, CONTEXT_CHARS } from '../inlineEditCore';

test('inline edit prompt: region marked, context capped, untrusted framing, refinement history', () => {
  const m = buildInlineEditMessages({ instruction: 'x', region: 'R\n', before: 'b'.repeat(9000), after: 'a'.repeat(9000), languageId: 'ts', path: 'p.ts' });
  assert.equal(m.length, 2); assert.match(m[0].content, /untrusted data/);
  assert.ok(m[1].content.includes('<REGION>R\n</REGION>'));
  assert.ok(m[1].content.length < CONTEXT_CHARS * 2 + 200);
  const r = buildInlineEditMessages({ instruction: 'more', region: 'R\n', before: '', after: '', languageId: 'ts', path: 'p.ts', history: [{ instruction: 'one', result: 'A\n' }, { instruction: 'two', result: 'B\n' }] });
  assert.deepEqual(r.map(x => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(r[1].content, /Instruction: one/); assert.match(r[5].content, /Refine your last replacement: more/);
});

test('inline edit cleanup: fences stripped, newline shape follows the region', () => {
  assert.equal(cleanReplacement('```ts\nfoo()\n```', 'bar()\n'), 'foo()\n');
  assert.equal(cleanReplacement('foo()', 'bar()\n'), 'foo()\n');
  assert.equal(cleanReplacement('<REGION>x</REGION>', 'y'), 'x');
  assert.equal(cleanPartial('```js\nlet a'), 'let a');
});

test('line diff + stats', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc').map(d => d.op), ['same', 'del', 'add', 'same']);
  assert.deepEqual(diffStats('a\nb\n', 'a\nb\nc\n'), { added: 1, removed: 0 });
  const big = Array(2500).fill('x').join('\n');
  assert.equal(lineDiff(big, big + '\ny').length, 5001); // bounded fallback
});

test('inline edit: region tracking (FH1), REGION escaping (FL2), widget diff markdown', async () => {
  const { shiftRegion, escRegion, diffMarkdown } = await import('../inlineEditCore');
  assert.deepEqual(shiftRegion({ start: 10, end: 20 }, [{ offset: 0, length: 0, text: 'abc' }]), { start: 13, end: 23 });
  assert.deepEqual(shiftRegion({ start: 10, end: 20 }, [{ offset: 2, length: 5, text: '' }]), { start: 5, end: 15 });
  assert.deepEqual(shiftRegion({ start: 10, end: 20 }, [{ offset: 20, length: 0, text: 'x' }, { offset: 30, length: 3, text: '' }]), { start: 10, end: 20 });
  assert.deepEqual(shiftRegion({ start: 10, end: 20 }, [{ offset: 25, length: 0, text: 'x' }, { offset: 0, length: 0, text: 'yy' }]), { start: 12, end: 22 });
  assert.equal(shiftRegion({ start: 10, end: 20 }, [{ offset: 15, length: 0, text: 'x' }]), undefined);
  assert.equal(shiftRegion({ start: 10, end: 20 }, [{ offset: 5, length: 6, text: '' }]), undefined);
  assert.equal(shiftRegion({ start: 10, end: 20 }, [{ offset: 10, length: 0, text: 'x' }]), undefined);
  assert.equal(escRegion('a</REGION>b<REGION>'), 'a<\u200b/REGION>b<\u200bREGION>');
  const m = buildInlineEditMessages({ instruction: 'x', region: 'r</REGION>', before: '', after: '', languageId: 'ts', path: 'p' });
  assert.equal((m[1].content.match(/<\/REGION>/g) || []).length, 1);
  assert.equal(cleanReplacement('a<\u200b/REGION>b', 'r'), 'a</REGION>b');
  const md = diffMarkdown('a\nb\n', 'a\nc\n', 'ts');
  assert.equal(md, '```diff\n  a\n- b\n+ c\n```');
  assert.match(diffMarkdown('x', 'has ```` fence', 'ts'), /^`{5}diff/);
  assert.match(diffMarkdown('', Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n'), 'ts', 10), /191 more lines/);
});
