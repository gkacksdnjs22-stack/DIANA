import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { androidManifest, zipFiles } from './release-zip.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Preserve the existing release manifest's source scope, including binary resources.
const sourceScope = [
  'android-app/app/build.gradle',
  'android-app/build.gradle',
  'android-app/settings.gradle',
  'android-app/app/src/main',
];
const pairedSources = [
  'android-app/app/src/debug',
  'android-app/app/src/paired',
  'android-app/gradle.properties',
  'financial-desktop/version.json',
];

export function readAndroidReleaseSources(release, repoRoot) {
  const commit = release.sourceCommit;
  assert.match(commit ?? '', /^[0-9a-f]{40}$/, 'Android sourceCommit must be a full commit SHA');
  const git = args => execFileSync('git', args, {
    cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
  let type;
  try {
    type = git(['cat-file', '-t', commit]).toString().trim();
  } catch {
    throw new Error(`Android release source commit unavailable; run: git fetch --no-tags --depth=1 origin ${commit}`);
  }
  assert.equal(type, 'commit', 'Android sourceCommit must identify a commit');
  const scope = release.variant === 'paired-debug' ? [...sourceScope, ...pairedSources] : sourceScope;
  const entries = git(['ls-tree', '-r', '-z', commit, '--', ...scope])
    .toString().split('\0').filter(Boolean).map(entry => {
      const [header, path] = entry.split('\t');
      const [mode, kind, object] = header.split(' ');
      assert.equal(mode, '100644', `Android release source must be a regular file: ${path}`);
      assert.equal(kind, 'blob', `Android release source must be a blob: ${path}`);
      return { path, object };
    });
  assert(Array.isArray(release.sourceFiles), 'Android sourceFiles must be an array');
  const recorded = new Map();
  for (const file of release.sourceFiles) {
    assert.equal(typeof file.path, 'string', 'Android source path must be a string');
    assert(!recorded.has(file.path), `Duplicate Android source: ${file.path}`);
    assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/, `Invalid Android source hash: ${file.path}`);
    recorded.set(file.path, file.sha256);
  }
  assert.deepEqual([...recorded.keys()].sort(), entries.map(entry => entry.path).sort(),
    'Android sourceFiles must cover the recorded commit source scope exactly');
  for (const required of [...sourceScope.slice(0, 3), 'android-app/app/src/main/AndroidManifest.xml']) {
    assert(recorded.has(required), `Required Android release source missing: ${required}`);
  }
  const sources = new Map();
  for (const entry of entries) {
    const bytes = git(['cat-file', 'blob', entry.object]);
    assert.equal(hash(bytes), recorded.get(entry.path), `Android release source: ${entry.path}`);
    sources.set(entry.path, bytes);
  }
  return sources;
}

export function verifyAndroidRelease(release, apk, repoRoot) {
  assert.equal(hash(apk), release.sha256, 'Android APK SHA-256');
  assert.equal(apk.length, release.bytes, 'Android APK size');
  const sources = readAndroidReleaseSources(release, repoRoot);
  const gradle = sources.get('android-app/app/build.gradle').toString('utf8');
  const manifest = androidManifest(zipFiles(apk).get('AndroidManifest.xml')());
  if (release.variant === 'paired-debug') {
    assert(sources.has('android-app/app/src/paired/AndroidManifest.xml'), 'Missing paired launcher manifest');
    const { version } = JSON.parse(sources.get('financial-desktop/version.json'));
    const parts = /^(\d+)\.(\d+)\.(\d+)-dev-[a-z]+([1-9]\d*)$/.exec(version);
    assert(parts, 'Invalid paired release version');
    const [, major, minor, patch, revision] = parts.map(Number);
    assert.equal(manifest.package, gradle.match(/applicationId\s+pairedProduct\s*\?\s*'([^']+)'/)[1]);
    assert.equal(manifest.versionName, version);
    assert.equal(manifest.versionCode, major * 1000000 + minor * 10000 + patch * 100 + revision);
  } else {
    assert.equal(manifest.package, gradle.match(/applicationId\s+'([^']+)'/)[1]);
    assert.equal(manifest.versionName, gradle.match(/versionName\s+'([^']+)'/)[1]);
    assert.equal(manifest.versionCode, Number(gradle.match(/versionCode\s+(\d+)/)[1]));
  }
  assert.equal(manifest.minSdk, Number(gradle.match(/minSdk\s+(\d+)/)[1]));
  assert.equal(manifest.versionName, release.version);
  assert.equal(manifest.versionCode, release.versionCode);
  assert.equal(manifest.minSdk, release.minSdk);
  return manifest;
}
