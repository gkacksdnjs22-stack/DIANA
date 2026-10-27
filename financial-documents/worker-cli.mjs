import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { FinancialWorker, financialTransport } from './remote-worker.mjs';

export async function main(args=process.argv.slice(2)) {
  if (args.length!==2 || args[0]!=='--config') throw new Error('WORKER_CONFIG_REQUIRED');
  // Require an actual local terminal. Piped/server text can never approve a plan.
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('LOCAL_TERMINAL_REQUIRED');
  const worker=await FinancialWorker.create({configPath:path.resolve(args[1]),api:financialTransport(),output:text=>process.stdout.write(text),documentRoot:path.resolve(process.env.DOCUMENT_ROOT || 'sample-documents')});
  let stopped=false; const io=createInterface({input:process.stdin,output:process.stdout});
  const showError=()=>process.stdout.write('PC 연결 또는 로컬 정책 확인 필요. 상세 정보는 서버로 보내지 않습니다.\n');
  let polling=false;
  const run=async()=>{if(polling)return;polling=true;try{await worker.tick();}catch{showError();}finally{polling=false;}};
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
  await closed;await worker.close();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('FINANCIAL_WORKER_START_FAILED');process.exitCode=1;});
