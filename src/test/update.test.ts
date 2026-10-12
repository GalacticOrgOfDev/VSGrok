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

import { describeError, isAllowedRedirect, stepError } from '../updateCheck';

test('describeError never yields "undefined" (string rejections like VS Code\'s "No Servers")', () => {
  assert.equal(describeError('No Servers'), 'No Servers');
  assert.equal(describeError(undefined), 'unknown error (no details)');
  assert.equal(describeError(null), 'unknown error (no details)');
  assert.equal(describeError(''), 'unknown error (empty message)');
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.equal(describeError({ code: 'ENOENT' }), 'ENOENT');
  assert.equal(describeError({}), 'unknown error (no details)');
  assert.equal(describeError({ foo: 1 }), '{"foo":1}');
  const fetchErr = new TypeError('fetch failed'); (fetchErr as any).cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND github.com' }; // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.equal(describeError(fetchErr), 'fetch failed (ENOTFOUND getaddrinfo ENOTFOUND github.com)');
  for (const v of ['x', undefined, null, {}, 42, new Error('')]) { assert.doesNotMatch(describeError(v), /^undefined$|: undefined/); }
});

test('stepError names the step and HTTP status', () => {
  assert.equal(stepError('installing', 'No Servers'), 'Update failed while installing: No Servers');
  assert.equal(stepError('downloading', new Error('download returned HTTP 404'), 404), 'Update failed while downloading (HTTP 404): download returned HTTP 404');
});

test('download redirects: only GitHub asset hosts over https', () => {
  assert.ok(isAllowedRedirect('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'));
  assert.ok(isAllowedRedirect('https://objects.githubusercontent.com/x'));
  assert.ok(!isAllowedRedirect('http://objects.githubusercontent.com/x'));
  assert.ok(!isAllowedRedirect('https://evil.example/x.vsix'));
  assert.ok(!isAllowedRedirect('https://objects.githubusercontent.com.evil.example/x'));
  assert.ok(!isAllowedRedirect('not a url'));
  assert.ok(isAllowedRedirect('http://127.0.0.1:5/dl', 'http://127.0.0.1:5'));
});
