import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readAndroidReleaseSources, verifyAndroidRelease } from './helpers/android-release.mjs';

const root = new URL('../', import.meta.url);
const published = JSON.parse(readFileSync(new URL('public/downloads/releases.json', root))).legacy.android;
const apk = readFileSync(new URL('public' + published.path, root));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('release provenance stays pinned to the build commit and rejects corrupt evidence', async t => {
  const repo = mkdtempSync(join(tmpdir(), 'diana-release-provenance-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['init', '--quiet']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'commit.gpgsign', 'false']);
  const gradlePath = 'android-app/app/build.gradle';
  const sources = {
    [gradlePath]: `applicationId 'kr.nightdesk.phone'\nversionName '${published.version}'\nversionCode ${published.versionCode}\nminSdk ${published.minSdk}\n`,
    'android-app/build.gradle': '// release build\n',
    'android-app/settings.gradle': '// release settings\n',
    'android-app/app/src/main/AndroidManifest.xml': '<manifest />\n',
  };
  for (const [path, content] of Object.entries(sources)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  const commit = () => {
    git(['add', '--', 'android-app']);
    git(['-c', 'user.name=Release test', '-c', 'user.email=release-test@example.invalid', 'commit', '--quiet', '-m', 'Test source snapshot']);
    return git(['rev-parse', 'HEAD']);
  };
  const release = {
    ...published, sourceCommit: commit(),
    sourceFiles: Object.entries(sources).map(([path, content]) => ({ path, sha256: hash(content) })),
  };
  // Development moves forward while the published package and recorded hashes stay fixed.
  writeFileSync(join(repo, gradlePath), "applicationId 'future.development'\n");
  const developmentCommit = commit();
  const changed = fn => { const result = structuredClone(release); fn(result); return result; };

  await t.test('the original commit validates even after HEAD and the working file change', () => {
    assert.notEqual(developmentCommit, release.sourceCommit);
    assert.equal(readAndroidReleaseSources(release, repo).get(gradlePath).toString(), sources[gradlePath]);
    assert.equal(verifyAndroidRelease(release, apk, repo).versionName, published.version);
  });
  await t.test('a changed recorded source hash fails', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceFiles[0].sha256 = '0'.repeat(64)), repo), /Android release source:/);
  });
  await t.test('substituting the newer commit without rebuilding the APK fails', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceCommit = developmentCommit), repo), /Android release source:/);
  });
  await t.test('an omitted source record fails', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceFiles.pop()), repo), /source scope exactly/);
  });
  await t.test('an additional path outside the source inventory fails', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceFiles.push({ path: '../outside', sha256: '0'.repeat(64) })), repo), /source scope exactly/);
  });
  await t.test('duplicate source records fail', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceFiles.push(r.sourceFiles[0])), repo), /Duplicate Android source/);
  });
  await t.test('a malformed source hash fails', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceFiles[0].sha256 = 'not-a-hash'), repo), /Invalid Android source hash/);
  });
  await t.test('a branch name cannot replace the pinned commit', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceCommit = 'HEAD'), repo), /full commit SHA/);
  });
  await t.test('a missing commit fails without falling back to working files', () => {
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceCommit = '0'.repeat(40)), repo), /source commit unavailable; run: git fetch/);
  });
  await t.test('a blob cannot replace the commit', () => {
    const blob = git(['rev-parse', `${release.sourceCommit}:${gradlePath}`]);
    assert.throws(() => readAndroidReleaseSources(changed(r => r.sourceCommit = blob), repo), /must identify a commit/);
  });
  await t.test('changed APK bytes fail', () => {
    const altered = Buffer.from(apk); altered[100] ^= 1;
    assert.throws(() => verifyAndroidRelease(release, altered, repo), /APK SHA-256/);
  });
  await t.test('wrong APK length fails', () => {
    assert.throws(() => verifyAndroidRelease(changed(r => r.bytes++), apk, repo), /APK size/);
  });
  for (const field of ['version', 'versionCode', 'minSdk']) {
    await t.test(`wrong published ${field} fails`, () => {
      assert.throws(() => verifyAndroidRelease(changed(r => r[field] += 1), apk, repo), assert.AssertionError);
    });
  }
  await t.test('even updated hashes cannot hide a Gradle/APK package mismatch', () => {
    const newer = changed(r => {
      r.sourceCommit = developmentCommit;
      r.sourceFiles[0].sha256 = hash(readFileSync(join(repo, gradlePath)));
    });
    assert.throws(() => verifyAndroidRelease(newer, apk, repo), assert.AssertionError);
  });
});
