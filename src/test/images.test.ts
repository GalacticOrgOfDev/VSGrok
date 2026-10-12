import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { checkImageDataUrl, filterImages, visionBlocked, MAX_IMAGES, decodedBytes, stripOldImages, dropUnresolvableReasoning, sniffImage } from '../imagesCore';
import { emptyMeter, addTurn, meterView, fmtTokens } from '../costMeter';
import { parseVision, withVision } from '../xai/models';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cards = require(path.join(__dirname, '..', '..', 'media', 'webview', 'cards.js'));

export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]).toString('base64');

test('images: only PNG/JPEG data URLs with matching magic bytes pass', () => {
  assert.equal(checkImageDataUrl(PNG).ok, true);
  assert.equal(checkImageDataUrl(JPG).ok, true);
  for (const bad of ['data:image/gif;base64,R0lGODlh', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://x/y.png', PNG.replace('image/png', 'image/jpeg'), 'data:image/png;base64,AAAA', 5, 'data:image/png;base64,iVBOR w0']) {
    assert.equal(checkImageDataUrl(bad).ok, false, String(bad).slice(0, 40));
  }
  assert.equal(decodedBytes('AAAA'), 3); assert.equal(decodedBytes('AA=='), 1);
});

test('images: 4 MiB per-image cap (extension-side) and count cap', () => {
  const huge = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(28 * 1024 * 1024);
  assert.match((checkImageDataUrl(huge) as { reason: string }).reason, /4 MiB/);
  const big = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(Math.ceil(4.5 * 1024 * 1024 / 3) * 4 - 11);
  assert.match((checkImageDataUrl(big) as { reason: string }).reason, /4 MiB/);
  const r = filterImages(Array(MAX_IMAGES + 2).fill(PNG).concat(['nope']));
  assert.equal(r.images.length, MAX_IMAGES); assert.equal(r.dropped.length, 3);
  assert.deepEqual(filterImages(['bad', PNG, 'x', PNG]).kept, [1, 3]);
});

test('vision gate: block only models known not to accept images; suggest a vision model', () => {
  const models = [{ id: 'a', vision: false }, { id: 'b' }, { id: 'c', vision: true }];
  assert.deepEqual(visionBlocked('a', models), { blocked: true, suggest: 'c' });
  assert.equal(visionBlocked('b', models).blocked, false);
  assert.equal(visionBlocked('zzz', models).blocked, false);
  assert.deepEqual(visionBlocked('a', [{ id: 'a', vision: false }]), { blocked: true, suggest: undefined });
});

test('models: /language-models input_modalities (incl. aliases) → vision flag', () => {
  const v = parseVision({ models: [{ id: 'grok-4.7', aliases: ['grok-latest'], input_modalities: ['text', 'image'] }, { id: 'grok-code', input_modalities: ['text'] }, { id: 7 }] });
  assert.equal(v.get('grok-4.7'), true); assert.equal(v.get('grok-latest'), true); assert.equal(v.get('grok-code'), false);
  assert.deepEqual(withVision([{ id: 'grok-4.7' }, { id: 'x' }], v), [{ id: 'grok-4.7', vision: true, aliases: ['grok-latest'] }, { id: 'x' }]);
  // L3: alias lookup in the gate
  const code = withVision([{ id: 'grok-code' }], parseVision({ models: [{ id: 'grok-code', aliases: ['grok-code-latest'], input_modalities: ['text'] }] }));
  assert.equal(visionBlocked('grok-code-latest', code).blocked, true);
  assert.equal(parseVision({}).size, 0);
});

test('cost meter: sums API usage; cost only when reported; "+" when some turns lack it', () => {
  let m = emptyMeter();
  assert.equal(meterView(m).hidden, true);
  m = addTurn(m, { input: 1200, output: 300, reasoning: 100, cached: 1000 });
  let v = meterView(m);
  assert.equal(v.text, '1.5k tok'); assert.match(v.tooltip, /not reported by the API/); assert.doesNotMatch(v.text, /\$/);
  m = addTurn(m, { input: 10_000, output: 500, reasoning: 0, cached: 0, costUsd: 0.0123 });
  v = meterView(m);
  assert.equal(v.text, '12k tok · $0.012+'); assert.match(v.tooltip, /some turns didn't report a cost \(1 of 2\)/);
  assert.match(v.ariaLabel, /at least \$0\.012/); assert.equal(v.lines.length, 6); assert.match(v.tooltip, /Input: 11,200 tokens \(1,000 cached\)/);
  const only = meterView(addTurn(emptyMeter(), { input: 1, output: 1, reasoning: 0, cached: 0, costUsd: 2.5 }));
  assert.equal(only.text, '2 tok · $2.50');
  assert.equal(fmtTokens(2_500_000), '2.5M');
});

test('cards: image helpers', () => {
  assert.deepEqual(cards.fitSize(4096, 1024, 2048), { w: 2048, h: 512, scaled: true });
  assert.deepEqual(cards.fitSize(100, 50), { w: 100, h: 50, scaled: false });
  assert.equal(cards.dataUrlBytes(PNG), Buffer.from(PNG.split(',')[1], 'base64').length);
  assert.equal(cards.keepOriginal('image/png', 1000, 100, 100), true);
  assert.equal(cards.keepOriginal('image/webp', 1000, 100, 100), false);
  assert.equal(cards.keepOriginal('image/png', 5e6, 100, 100), false);
  assert.equal(cards.keepOriginal('image/jpeg', 1000, 4000, 100), false);
  assert.deepEqual(cards.imageRoom(6, 4), { take: 2, dropped: 2 });
  assert.equal(cards.visionNote('m', 's').action, 'Switch to s and resend');
  assert.equal(cards.imagesOnlyPrompt(1), 'What is in this image?'); assert.equal(cards.imagesOnlyPrompt(3), 'What is in these images?');
  assert.equal(cards.toastMs('x'.repeat(80)), 8000);
  assert.equal(cards.visionNote('m', '').action, '');
});

test('H1: per-message image budget (16 MiB) and L1: count checked before scanning', () => {
  const b64 = (n: number) => 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(Math.floor(n * 4 / 3 / 4) * 4 - 11);
  const r = filterImages([b64(3.9e6), b64(3.9e6), b64(3.9e6), b64(3.9e6), b64(3.9e6)]);
  assert.equal(r.images.length, 4); assert.match(r.dropped[0], /16 MiB of images in one message/);
  const many = filterImages(Array(50).fill(PNG));
  assert.equal(many.images.length, MAX_IMAGES); assert.match(many.dropped.at(-1)!, /34 more images ignored/);
  assert.equal(checkImageDataUrl('data:image/png;base64,iVBO RwAA').ok, false);
  assert.equal(checkImageDataUrl('data:image/png;base64,iVBORw0KGgo=A==').ok, false);
});

test('H1/M2: stripOldImages keeps the last image turn, replaces older parts with placeholders', () => {
  const img = (t: string) => ({ role: 'user', content: [{ type: 'input_text', text: t }, { type: 'input_image', image_url: PNG }] });
  const items = [img('one'), { role: 'assistant', content: 'ok' }, img('two'), { role: 'user', content: 'three' }];
  const r = stripOldImages(items, 1);
  assert.equal(r.stripped, 1);
  assert.deepEqual(r.items[0].content[1], { type: 'input_text', text: '[image 1 from an earlier message omitted]' });
  assert.equal(r.items[2].content[1].type, 'input_image');
  assert.equal((items[0].content[1] as { type: string }).type, 'input_image', 'input not mutated');
  assert.equal(stripOldImages(items, 0).stripped, 2);
});

test('M1: dropUnresolvableReasoning drops reasoning without encrypted_content', () => {
  const r = dropUnresolvableReasoning([{ type: 'reasoning', id: 'r1' }, { type: 'reasoning', encrypted_content: 'x' }, { role: 'user', content: 'hi' }]);
  assert.equal(r.dropped, 1); assert.equal(r.items.length, 2);
});

test('M3: sniffImage uses magic bytes', () => {
  assert.equal(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.equal(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF....WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('hello world')), undefined);
});

test('M4: Chat Completions turn without prompt_tokens says "not reported", not 0', () => {
  let m = addTurn(emptyMeter(), { input: 0, inputUnknown: true, output: 50, reasoning: 0, cached: 0 });
  assert.match(meterView(m).tooltip, /Input: not reported \(Chat Completions\)/);
  m = addTurn(m, { input: 900, output: 10, reasoning: 0, cached: 0, costUsd: 0.001 });
  assert.match(meterView(m).tooltip, /Input: 900 tokens .*not reported for 1 turn/);
});
