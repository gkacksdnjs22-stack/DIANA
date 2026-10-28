import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {mkdir,mkdtemp,writeFile,readFile,rm,link,symlink} from 'node:fs/promises';
import {desktopSettings,desktopEnvironment,loadDesktopSettings} from '../financial-desktop/settings.mjs';
import {runDesktop,desktopEvent,desktopError} from '../financial-desktop/worker.mjs';
import {desktopSources} from '../scripts/build-financial-desktop.mjs';
import {boundedRead} from '../financial-documents/files.mjs';

const settings=()=>({schema_version:1,configPath:path.resolve('sample-documents/worker.json'),envFile:path.resolve('.env'),documentRoot:path.resolve('sample-documents'),apiBaseUrl:'https://diana-pzw3.onrender.com',autoOpen:false});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(check){for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,5));}throw Error('TEST_TIMEOUT');}
async function fixture(t){const parent=path.resolve('.local');await mkdir(parent,{recursive:true});const root=await mkdtemp(path.join(parent,'financial-desktop-test-'));t.after(async()=>{assert.equal(path.dirname(root),parent);assert.match(path.basename(root),/^financial-desktop-test-/u);await rm(root,{recursive:true,force:true});});return root;}

test('desktop settings accept exact local configuration and a fixed relay origin',()=>{
  const valid=desktopSettings(settings());assert.equal(valid.apiBaseUrl,'https://diana-pzw3.onrender.com');assert.equal(Object.isFrozen(valid),true);
  for(const change of [{autoOpen:'yes'},{approval:true},{configPath:'relative.json'},{envFile:'\\\\remote\\file.env'},{apiBaseUrl:'http://example.com'},{apiBaseUrl:'https://secret@example.com'},{apiBaseUrl:'https://example.com/?key=secret'},{apiBaseUrl:'https://example.com/path'},{documentRoot:'bad\npath'}])assert.throws(()=>desktopSettings({...settings(),...change}));
  assert.equal(desktopSettings({...settings(),apiBaseUrl:'http://127.0.0.1:12345'}).apiBaseUrl,'http://127.0.0.1:12345');
});
test('desktop reads only agent credential and never evaluates env runtime injection',async t=>{
  const root=await fixture(t),filename=path.join(root,'connection.env'),token='a'.repeat(40);
  await writeFile(filename,'AGENT_TOKEN="'+token+'"\nNODE_OPTIONS=--eval=PRIVATE_PAYLOAD\nGROQ_OPENAI_KEY=PRIVATE_AI_KEY\nAPI_BASE_URL=https://wrong.invalid\nDOCUMENT_ROOT=wrong\n');
  const result=await desktopEnvironment(filename,'https://diana-pzw3.onrender.com');assert.deepEqual(result,{API_BASE_URL:'https://diana-pzw3.onrender.com',AGENT_TOKEN:token});assert.equal(process.env.NODE_OPTIONS?.includes('PRIVATE_PAYLOAD')??false,false);
  await writeFile(filename,'AGENT_TOKEN=short');await assert.rejects(()=>desktopEnvironment(filename,'https://example.com'),{code:'DESKTOP_ENV_INVALID'});
  await writeFile(filename,'x'.repeat(100001));await assert.rejects(()=>desktopEnvironment(filename,'https://example.com'),{code:'DESKTOP_ENV_INVALID'});
});
test('desktop profile is inert bounded JSON, including duplicate-key rejection',async t=>{
  const root=await fixture(t),file=path.join(root,'desktop.json');await writeFile(file,JSON.stringify(settings()));assert.equal((await loadDesktopSettings(file)).autoOpen,false);
  await writeFile(file,JSON.stringify(settings()).replace('"schema_version":1','"schema_version":1,"schema_version":1'));await assert.rejects(()=>loadDesktopSettings(file));
});

test('shared AppData profile loads without opening AppData to document readers',async t=>{
  const root=await fixture(t),directory=path.join(root,'AppData/Local/DIANA/financial-desktop');
  await mkdir(directory,{recursive:true});const filename=path.join(directory,'desktop.json');
  await writeFile(filename,JSON.stringify(settings()));
  assert.deepEqual(await loadDesktopSettings(filename),desktopSettings(settings()));
  await assert.rejects(()=>boundedRead(filename),{code:'document_path_denied'});
});

test('explicit profile still rejects invalid bytes, oversized files, hardlinks and junction parents',async t=>{
  const root=await fixture(t),filename=path.join(root,'desktop.json');
  for(const bytes of [Buffer.alloc(0),Buffer.alloc(16385,32),Buffer.from([0xff]),Buffer.from('{"private":"PRIVATE_CANARY"}')]){
    await writeFile(filename,bytes);
    await assert.rejects(()=>loadDesktopSettings(filename),error=>error.code==='DESKTOP_SETTINGS_INVALID'&&!error.message.includes('PRIVATE_CANARY'));
  }
  await writeFile(filename,JSON.stringify(settings()));
  const linked=path.join(root,'linked.json');await link(filename,linked);
  await assert.rejects(()=>loadDesktopSettings(linked),{code:'DESKTOP_SETTINGS_INVALID'});
  await rm(linked);
  const original=path.join(root,'real');await mkdir(original);await writeFile(path.join(original,'desktop.json'),JSON.stringify(settings()));
  const junction=path.join(root,'redirected');await symlink(original,junction,process.platform==='win32'?'junction':'dir');
  await assert.rejects(()=>loadDesktopSettings(path.join(junction,'desktop.json')),{code:'DESKTOP_SETTINGS_INVALID'});
});

test('explicit profile pins an OS-redirected path and rejects a changed redirect target',async t=>{
  const root=await fixture(t),logicalDir=path.join(root,'AppData/Local/DIANA/financial-desktop');await mkdir(logicalDir,{recursive:true});
  const logical=path.join(logicalDir,'desktop.json'),physical=path.join(root,'physical.json'),other=path.join(root,'other.json'),value=settings();
  await writeFile(physical,JSON.stringify(value));await writeFile(other,JSON.stringify(value));
  const script=String.raw`
    import assert from 'node:assert/strict';import path from 'node:path';import {mock} from 'node:test';
    const fs=await import('node:fs/promises');const [mode,logical,physical,other,loader,expected]=process.argv.slice(1);
    let target=physical,reads=0,closed=0;
    const exports=Object.fromEntries(Object.entries(fs).filter(([key])=>key!=='default'));
    mock.module('node:fs/promises',{namedExports:{...exports,
      lstat:(name,...args)=>fs.lstat(path.resolve(name)===logical?target:name,...args),
      realpath:name=>fs.realpath(path.resolve(name)===logical?target:name),
      open:async(name,flags)=>{
        assert.equal(name,physical);const handle=await fs.open(name,flags);
        return{stat:()=>handle.stat({bigint:true}),read:async(...args)=>{const result=await handle.read(...args);if(mode==='changed'&&reads++===0)target=other;return result;},close:async()=>{closed++;await handle.close();}};
      }
    }});
    const {loadDesktopSettings,desktopSettings}=await import(loader);
    if(mode==='stable')assert.deepEqual(await loadDesktopSettings(logical),desktopSettings(JSON.parse(expected)));
    else await assert.rejects(()=>loadDesktopSettings(logical),{code:'DESKTOP_SETTINGS_INVALID'});
    assert.equal(closed,1);
  `;
  for(const mode of ['stable','changed'])await promisify(execFile)(process.execPath,['--no-warnings','--experimental-test-module-mocks','--input-type=module','-e',script,mode,logical,physical,other,pathToFileURL(path.resolve('financial-desktop/settings.mjs')).href,JSON.stringify(value)],{windowsHide:true,timeout:10000});
});
test('native status projection cannot carry document bodies, paths, tokens or hashes',()=>{
  const secret={body:'PRIVATE_ORIGINAL',before:'PRIVATE_EVIDENCE',approvalToken:'PRIVATE_APPROVAL',plan_hash:'PRIVATE_HASH',outputFile:'PRIVATE_PATH'};
  assert.equal(desktopEvent({type:'review',...secret}),null);assert.equal(desktopEvent({type:'recheck',...secret}),null);
  assert.deepEqual(desktopEvent({type:'job',job:{state:'PROCESSING',...secret}}),{type:'job',state:'PROCESSING'});
  assert.deepEqual(desktopEvent({type:'result',result:{saved:true,storageVerified:true,...secret}}),{type:'saved',saved:true});
  assert.equal(desktopEvent({type:'job',job:{state:'PRIVATE_TEXT'}}),null);assert.equal(desktopError({code:'PRIVATE_TEXT',message:'PRIVATE_DOC'}),'DESKTOP_START_FAILED');
});

function harness(overrides={}){
  const input=new PassThrough(),events=[],order=[],viewerEvents=[];
  const viewer={url:'http://127.0.0.1:12345/#view='+'a'.repeat(64),accept:event=>viewerEvents.push(event),close:async()=>order.push('viewer.close')};
  const worker={tick:async()=>{},close:async()=>order.push('worker.close'),localCommand:async()=>order.push('localCommand'),reviewSaved:async()=>order.push('reviewSaved'),...overrides};
  let callbacks;
  const done=runDesktop({settings:settings(),input,emit:value=>events.push(value),api:()=>{},pollMs:10,createViewer:async options=>{callbacks=options;return viewer;},createWorker:async options=>{worker.options=options;return worker;}});
  return{input,events,order,viewerEvents,worker,done,get callbacks(){return callbacks;}};
}
test('desktop pipe owns lifecycle only and never allows approval commands',async()=>{
  const h=harness();await until(()=>h.events.some(e=>e.type==='connection'));
  h.input.write('{"command":"approve","requestId":"anything"}\n');await until(()=>h.events.some(e=>e.type==='commandRejected'));assert.ok(!h.order.includes('localCommand'));
  h.input.write('{"command":"stop"}\n');await h.done;assert.deepEqual(h.order,['worker.close','viewer.close']);assert.equal(h.events.at(-1).type,'stopped');assert.equal(h.worker.options.detailOutput,false);
  assert.equal(h.input.listenerCount('data'),0);
});
test('stop waits for an in-flight tick before releasing worker and viewer',async()=>{
  const pending=deferred(),started=deferred(),h=harness({tick:async()=>{started.resolve();await pending.promise;}});await started.promise;
  h.input.write('{"command":"stop"}\n');await until(()=>h.events.some(e=>e.type==='stopping'));assert.deepEqual(h.order,[]);
  await assert.rejects(()=>h.callbacks.onCommand('approve','any'),{code:'DESKTOP_STOPPING'});
  pending.resolve();await h.done;assert.deepEqual(h.order,['worker.close','viewer.close']);assert.ok(!h.events.some(e=>e.type==='connection'));
});
test('parent pipe EOF drains pending operations and closes its own local server',async()=>{
  const h=harness();await until(()=>h.events.some(e=>e.type==='ready'));h.input.end();await h.done;assert.deepEqual(h.order,['worker.close','viewer.close']);
});
test('network failure reports offline and the same worker retries successfully',async()=>{
  let ticks=0;const h=harness({tick:async()=>{if(++ticks===1)throw Error('PRIVATE_NETWORK_DETAIL');}});await until(()=>h.events.some(e=>e.type==='connection'&&e.connected));
  assert.ok(h.events.some(e=>e.type==='connection'&&!e.connected));assert.ok(!JSON.stringify(h.events).includes('PRIVATE_NETWORK_DETAIL'));h.input.end();await h.done;
});
test('closing during worker startup releases the new owner without exposing a URL',async()=>{
  const input=new PassThrough(),pending=deferred(),started=deferred(),events=[],order=[];
  const done=runDesktop({settings:settings(),input,emit:event=>events.push(event),api:()=>{},createViewer:async()=>({url:'unused',accept:()=>{},close:async()=>order.push('viewer')}),createWorker:async()=>{started.resolve();await pending.promise;return{close:async()=>order.push('worker')};}});
  await started.promise;input.end();await until(()=>events.some(e=>e.type==='stopping'));pending.resolve();await done;assert.deepEqual(order,['worker','viewer']);assert.ok(!events.some(e=>e.type==='ready'));
});
test('failed ownership acquisition closes only the new viewer and preserves original error',async()=>{
  const input=new PassThrough(),events=[];let closed=0;
  await assert.rejects(()=>runDesktop({settings:settings(),input,emit:event=>events.push(event),api:()=>{},createViewer:async()=>({close:async()=>closed++}),createWorker:async()=>{throw Object.assign(Error('PRIVATE'),{code:'WORKER_ALREADY_RUNNING'});}}),{code:'WORKER_ALREADY_RUNNING'});
  assert.equal(closed,1);assert.equal(input.listenerCount('data'),0);assert.ok(!events.some(e=>e.type==='ready'));assert.equal(desktopError({code:'WORKER_ALREADY_RUNNING'}),'WORKER_ALREADY_RUNNING');
});
test('release source whitelist closes all relative imports and contains no user state',async()=>{
  const sources=new Set(desktopSources);
  for(const relative of desktopSources){assert.ok(!/(?:^|\/)(?:\.env|\.local|checkpoints|private-data|node_modules)(?:\/|$)/u.test(relative));if(!relative.endsWith('.mjs'))continue;
    const text=await readFile(relative,'utf8');for(const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/gu))assert.ok(sources.has(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[2]))),'Missing import: '+relative+' → '+match[2]);
  }
});
