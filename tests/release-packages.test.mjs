import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {zipFiles} from './helpers/release-zip.mjs';
import {verifyAndroidRelease} from './helpers/android-release.mjs';
const root=new URL('../',import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>readFile(new URL(p,root));
const releases=JSON.parse(await read('public/downloads/releases.json'));
function readWindowsSource(release,p) {
 assert.match(release.sourceCommit,/^[a-f0-9]{40}$/);
 const raw=execFileSync('git',['show',release.sourceCommit+':'+p],{
  cwd:fileURLToPath(root),env:{...process.env,GIT_NO_REPLACE_OBJECTS:'1'},maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']
 });
 // These inputs were checked out with Windows line endings at build time.
 if(release.crlfBuildInputs?.includes(p)) {
  assert.match(p,/\.(?:mjs|ps1)$/);
  return Buffer.from(raw.toString('utf8').replace(/\r?\n/g,'\r\n'));
 }
 return raw;
}
for(const [channel,release] of [['paired',releases],['legacy',releases.legacy]]) {
test(channel+' Android package agrees with its recorded source commit, version and SDK',async()=>{
 const r=release.android,b=await read('public'+r.path);
 verifyAndroidRelease(r,b,fileURLToPath(root));
});
test(channel+' Windows bundle agrees with source hashes, native version and complete runtime manifest',async()=>{
 const r=release.windows,b=await read('public'+r.path);assert.equal(hash(b),r.sha256);assert.equal(b.length,r.bytes);
 const files=zipFiles(b),manifest=JSON.parse(files.get('DIANA-PC/manifest.json')());
 assert.equal(manifest.version,r.version);assert.equal(manifest.platform,'win-x64');
 if(channel==='paired') {
  assert.equal(JSON.parse(readWindowsSource(r,'financial-desktop/version.json')).version,r.version);
  assert.equal(manifest.windowsVersion.version,r.version);
  assert.equal(manifest.windowsVersion.numericVersion,r.numericVersion);
  const generated=files.get('DIANA-PC/runtime/native/BuildVersion.g.cs')().toString();
  assert.equal(generated.match(/AssemblyVersion\("([^" ]+)"\)/)[1],r.numericVersion);
  assert.equal(generated.match(/AssemblyInformationalVersion\("([^" ]+)"\)/)[1],r.version);
  assert(files.has('DIANA-PC/DIANA.exe'));
 } else {
  const cs=readWindowsSource(r,'financial-desktop/native/DesktopLauncher.cs').toString();
  assert.equal(cs.match(/AssemblyVersion\("([^" ]+)"\)/)[1],r.version+'.0');
  const builder=readWindowsSource(r,'scripts/build-financial-desktop.mjs').toString();
  assert.equal(builder.match(/desktopVersion='([^']+)'/)[1],r.version);
 }
 assert.equal(files.size,manifest.files.length+1);
 for(const f of manifest.files){const data=files.get('DIANA-PC/'+f.path)?.();assert(data,f.path);assert.equal(data.length,f.bytes,f.path);assert.equal(hash(data),f.sha256,f.path);}
 for(const f of manifest.build_inputs)assert.equal(hash(readWindowsSource(r,f.path)),f.sha256,'build input: '+f.path);
 for(const p of manifest.sources)assert.equal(hash(files.get('DIANA-PC/app/'+p)()),hash(readWindowsSource(r,p)),'packaged source: '+p);
 for(const p of files.keys())assert(!/(^|\/)\.env(?:\.|$)|desktop\.json$|worker\.json$|core\.json$|\.keystore$|\.jks$|service.account/i.test(p),'private configuration: '+p);
});
}
