import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { FinancialWorker, financialTransport } from './remote-worker.mjs';
import { createReviewViewer } from './review-viewer.mjs';

export function openReviewWindow(url,launch=spawn){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/#view=[a-f0-9]{64}$/u.test(url))throw new Error('LOCAL_VIEW_URL_REQUIRED');
  if(process.platform!=='win32')return;
  const child=launch('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});
  child.once('error',()=>{});child.unref();
}

export async function main(args=process.argv.slice(2)) {
  if (![2,3].includes(args.length) || args[0]!=='--config' || args.length===3&&!['--console','--no-open'].includes(args[2])) throw new Error('WORKER_CONFIG_REQUIRED');
  // Startup remains interactive. Local UI decisions use a separate loopback
  // session and the same request/plan/expiry/save gates as terminal decisions.
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('LOCAL_TERMINAL_REQUIRED');
  let viewer,worker;
  try {
  if(args[2]!=='--console')viewer=await createReviewViewer({onCommand:(command,id)=>worker.localCommand(command,id),onRecheck:id=>worker.reviewSaved(id)});
  worker=await FinancialWorker.create({configPath:path.resolve(args[1]),api:financialTransport(),output:text=>process.stdout.write(text),
    detailOutput:!viewer,onEvent:event=>{viewer?.accept(event);if(event.type==='review'&&viewer)process.stdout.write('검토 내용이 준비됐습니다. PC 검토 화면에서 내용을 확인해 주세요.\n');if(event.type==='result'&&viewer)process.stdout.write(event.result.saved&&event.result.storageVerified?'PC 저장·재읽기를 확인했습니다. 검토 화면에서 저장 결과를 확인해 주세요.\n':'PC 저장 결과를 검토 화면에서 확인해 주세요.\n');},
    documentRoot:path.resolve(process.env.DOCUMENT_ROOT || 'sample-documents')});
  if(viewer){process.stdout.write('PC 검토 화면: '+viewer.url+'\n원문·근거·수정안은 이 PC의 로컬 화면에서 확인합니다.\n');if(args[2]!=='--no-open')openReviewWindow(viewer.url);}
  let stopped=false; const io=createInterface({input:process.stdin,output:process.stdout});
  const showError=()=>{viewer?.accept({type:'connection',connected:false});process.stdout.write('PC 연결 또는 로컬 정책 확인 필요. 상세 정보는 서버로 보내지 않습니다.\n');};
  let polling=false;
  const run=async()=>{if(polling)return;polling=true;try{await worker.tick();viewer?.accept({type:'connection',connected:true});}catch{showError();}finally{polling=false;}};
  const timer=setInterval(()=>{if(!stopped)void run();},5000);
  const closed=new Promise(resolve=>io.once('close',()=>{stopped=true;clearInterval(timer);resolve();}));
  io.on('line',line=>{
    if(line.trim()==='exit'){io.close();return;}
    const m=/^(approve|reject|cancel) ([a-f0-9-]{36})$/u.exec(line.trim());
    if(!m){process.stdout.write('approve 요청ID / reject 요청ID / cancel 요청ID / exit\n');return;}
    void worker.localCommand(m[1],m[2]).catch(showError);
  });
  io.on('SIGINT',()=>io.close());
  await run(); process.stdout.write('금융 작업 대기 중 · 관리 메타데이터 통신 있음 · 종료: exit\n');
  await closed;
  } finally {try{await worker?.close();}finally{await viewer?.close();}}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('FINANCIAL_WORKER_START_FAILED');process.exitCode=1;});
