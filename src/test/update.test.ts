import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { compareSemver, isNewer, shouldCheck, parseRelease, CHECK_INTERVAL_MS } from '../updateCheck';

test('compareSemver: core versions', () => {
  assert.ok(compareSemver('0.5.1', '0.5.0') > 0);
  assert.ok(compareSemver('0.10.0', '0.9.9') > 0);
  assert.ok(compareSemver('1.0.0', '0.99.99') > 0);
  assert.equal(compareSemver('v0.5.0', '0.5.0'), 0);
  assert.ok(compareSemver('0.4.9', '0.5.0') < 0);
});

test('compareSemver: prerelease and build metadata', () => {
  assert.ok(compareSemver('1.0.0', '1.0.0-rc.1') > 0);
  assert.ok(compareSemver('1.0.0-rc.2', '1.0.0-rc.1') > 0);
  assert.ok(compareSemver('1.0.0-rc.10', '1.0.0-rc.9') > 0);
  assert.ok(compareSemver('1.0.0-beta', '1.0.0-alpha') > 0);
  assert.ok(compareSemver('1.0.0-alpha.1', '1.0.0-alpha') > 0);
  assert.equal(compareSemver('1.0.0+build.5', '1.0.0'), 0);
});

test('isNewer: invalid versions never trigger an update', () => {
  assert.equal(isNewer('garbage', '0.5.0'), false);
  assert.equal(isNewer('0.5.0', '0.5.0'), false);
  assert.equal(isNewer('0.5.2', '0.5.1'), true);
});

test('shouldCheck: once per 24h', () => {
  const now = 1_000_000_000_000;
  assert.equal(shouldCheck(undefined, now), true);
  assert.equal(shouldCheck(now - 1000, now), false);
  assert.equal(shouldCheck(now - CHECK_INTERVAL_MS, now), true);
  assert.equal(shouldCheck(now + 5000, now), true); // clock went backwards
});

test('parseRelease: picks the repo .vsix asset; ignores drafts/prereleases/foreign urls', () => {
  const base = { tag_name: 'v0.5.1', html_url: 'https://github.com/GalacticOrgOfDev/VSGrok/releases/tag/v0.5.1', body: 'notes',
    assets: [{ name: 'notes.txt', browser_download_url: 'https://github.com/GalacticOrgOfDev/VSGrok/releases/download/v0.5.1/notes.txt' },
      { name: 'vsgrok-0.5.1.vsix', browser_download_url: 'https://github.com/GalacticOrgOfDev/VSGrok/releases/download/v0.5.1/vsgrok-0.5.1.vsix' }] };
  const r = parseRelease(base)!;
  assert.equal(r.version, '0.5.1');
  assert.equal(r.assetName, 'vsgrok-0.5.1.vsix');
  assert.equal(parseRelease({ ...base, draft: true }), undefined);
  assert.equal(parseRelease({ ...base, prerelease: true }), undefined);
  assert.equal(parseRelease({ ...base, assets: [{ name: 'x.vsix', browser_download_url: 'https://evil.example/x.vsix' }] }), undefined);
  assert.equal(parseRelease({ message: 'Not Found' }), undefined);
});
