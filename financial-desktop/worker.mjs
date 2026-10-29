import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {FinancialWorker,financialTransport} from '../financial-documents/remote-worker.mjs';
import {createReviewViewer} from '../financial-documents/review-viewer.mjs';
import {loadDesktopSettings,desktopEnvironment} from './settings.mjs';
import {FINANCE_STATES} from '../lib/financial-contract.mjs';
import {LocalRegistration} from '../financial-documents/local-registration.mjs';
import {RequestRecords} from '../financial-documents/request-records.mjs';
import {pickLocalFolder} from './folder-picker.mjs';

const states=new Set(FINANCE_STATES);
const errors=new Set(['WORKER_ALREADY_RUNNING','WORKER_LOCK_UNCERTAIN','INVALID_SERVER_CONFIG','DESKTOP_SETTINGS_INVALID','DESKTOP_ENV_INVALID','FILE_DENIED','PATH_DENIED','PYTHON_PATH_INVALID','INVALID_WORKER_CONFIG','FINANCE_STATE_OVERLAP','FINANCE_CATALOG_OVERLAP']);
export const desktopError=error=>errors.has(error?.code)?error.code:'DESKTOP_START_FAILED';
export function desktopEvent(event){
  if(event.type==='job'&&states.has(event.job?.state))return {type:'job',state:event.job.state};
  if(event.type==='result')return {type:'saved',saved:event.result?.saved===true&&event.result?.storageVerified===true};
  return null;
}

/** Dedicated inherited pipes, not an HTTP management API. No approval command.
 * The existing TTY-only CLI and its ownership checks remain unchanged. */
export async function runDesktop({settings,input=process.stdin,emit=value=>process.stdout.write(JSON.stringify(value)+'\n'),createWorker=options=>FinancialWorker.create(options),createViewer=createReviewViewer,api,pollMs=5000,pickFolder=pickLocalFolder}){
  let worker,viewer,registry,records,stopping=false,polling=null,timer,buffer='',ended=false;const dialogs=new AbortController();
  let stop;const stopped=new Promise(resolve=>stop=()=>{if(stopping)return;stopping=true;dialogs.abort();clearInterval(timer);emit({type:'stopping'});resolve();});
  const onData=chunk=>{
    buffer+=chunk.toString('utf8');if(Buffer.byteLength(buffer)>1024){stop();return;}
    let index;while((index=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line==='{"command":"stop"}')stop();else if(line)emit({type:'commandRejected'});}
  };
  const onEnd=()=>{ended=true;stop();};
  input.on('data',onData);input.once('end',onEnd);input.once('close',onEnd);input.once('error',onEnd);
  if(input.readableEnded||input.destroyed)stop();
  const guard=fn=>async(...args)=>{if(stopping)throw Object.assign(Error('DESKTOP_STOPPING'),{code:'DESKTOP_STOPPING'});return fn(...args);};
  try{
    viewer=await createViewer({onCommand:guard((command,id)=>worker.localCommand(command,id)),onRecheck:guard(id=>worker.reviewSaved(id)),onReadCatalog:guard(()=>registry.view()),onRegister:guard((type,body)=>registry.register(type,body)),onPickFolder:guard(body=>registry.pickFolder(body,()=>pickFolder({signal:dialogs.signal}))),onDiscover:guard(body=>registry.discover(body)),onConnect:guard(body=>registry.connect(body)),onRequestRecords:guard((body,jobs)=>records.handle(body,jobs))});
    if(stopping)return;
    worker=await createWorker({configPath:settings.configPath,api:api??financialTransport(await desktopEnvironment(settings.envFile,settings.apiBaseUrl)),documentRoot:settings.documentRoot,detailOutput:false,output:()=>{},onEvent:event=>{viewer.accept(event);const minimal=desktopEvent(event);if(minimal)emit(minimal);}});
    if(typeof worker.registrationBase==='function'){registry=await LocalRegistration.open(worker);const b=worker.registrationBase();records=new RequestRecords({stateDir:b.config.stateDir,protectedRoots:[...b.core.readRoots,b.core.outputRoot,b.documentRoot],withContext:fn=>registry.withRecordingContext(fn),withLocalReview:fn=>registry.withLocalReview(fn),aiPython:b.core.python,appVersion:'desktop-0.3.5'});}
    if(stopping)return;
    emit({type:'ready',url:viewer.url});
    const tick=()=>{
      if(stopping||polling)return polling;
      const revision=registry?.revision;
      polling=(async()=>{try{await worker.tick();registry?.markPublished(revision);if(!stopping){viewer.accept({type:'connection',connected:true});emit({type:'connection',connected:true});}}
        catch{if(!stopping){viewer.accept({type:'connection',connected:false});emit({type:'connection',connected:false});}}finally{polling=null;}})();
      return polling;
    };
    timer=setInterval(()=>void tick(),pollMs);void tick();
    await stopped;
  }finally{
    stopping=true;dialogs.abort();clearInterval(timer);input.off('data',onData);input.off('end',onEnd);input.off('close',onEnd);input.off('error',onEnd);
    try{await polling;await records?.close();await worker?.close();}finally{await viewer?.close();emit({type:'stopped'});if(!ended)input.pause();}
  }
}

export async function main(args=process.argv.slice(2)){
  if(args.length!==2||args[0]!=='--settings')throw Object.assign(Error('DESKTOP_SETTINGS_INVALID'),{code:'DESKTOP_SETTINGS_INVALID'});
  // A crashed launcher closes its pipes. Do not turn a broken status pipe into
  // an unhandled exception while a local save is being drained.
  const broken=()=>process.stdin.emit('close');process.stdout.on('error',broken);
  try{await runDesktop({settings:await loadDesktopSettings(path.resolve(args[1]))});}
  finally{process.stdout.off('error',broken);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.stdout.on('error',()=>{});
  main().catch(error=>{process.stdout.write(JSON.stringify({type:'error',code:desktopError(error)})+'\n');process.exitCode=1;});
}
