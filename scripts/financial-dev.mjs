import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createControlServer } from '../lib/control.mjs';
import { main as workerMain } from '../financial-documents/worker-cli.mjs';

// In-process temporary local server; never .env, Render, training or OS services.
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--config'||!process.stdin.isTTY)throw new Error('LOCAL_TERMINAL_AND_CONFIG_REQUIRED');
const config=path.resolve(args[1]),root=path.dirname(config);
const tokens=Object.fromEntries(['userToken','agentToken','gatewayToken'].map(k=>[k,randomBytes(32).toString('hex')]));
const server=createControlServer({...tokens,deviceId:'finance-local-demo',dbPath:path.join(root,'dev-control.sqlite'),transferDir:path.join(root,'dev-relay')});
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+server.address().port;
  process.env.API_BASE_URL=base;process.env.AGENT_TOKEN=tokens.agentToken;process.env.DOCUMENT_ROOT=path.join(root,'generic');
  const r=await fetch(base+'/api/phone/pair-code',{method:'POST',headers:{Authorization:'Bearer '+tokens.userToken}});const pair=await r.json();
  console.log('로컬 개발 서버 '+base+' · 에뮬레이터에서는 127.0.0.1 대신 10.0.2.2 사용');
  console.log('5분 유효 테스트 연결 코드: '+pair.code+' · 가상 자료만 사용 · 종료 exit');
  await workerMain(['--config',config]);
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
