import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {mkdir,mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {desktopSettings,desktopEnvironment,loadDesktopSettings} from '../financial-desktop/settings.mjs';
import {runDesktop,desktopEvent,desktopError} from '../financial-desktop/worker.mjs';
import {desktopSources} from '../scripts/build-financial-desktop.mjs';

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
