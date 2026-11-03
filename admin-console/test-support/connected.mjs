import {createServer} from 'node:https';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,X509Certificate} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pgliteStore} from '../../security-lab/admin-passkey/staging/test-support.mjs';
import {StagingAdminAuth} from '../../security-lab/admin-passkey/staging/auth.mjs';
import {createAdminConsole} from '../router.mjs';
const run=promisify(execFile);

/** Test only: ephemeral TLS key stays in memory; never reads .env or a remote DB. */
export async function connectedFixture(){
  const parent=resolve(import.meta.dirname,'../generated/connected');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(join(parent,'case-')),certificate=join(dir,'certificate.pem');
  let key,cert;
  try{
    const result=await run(process.env.ADMIN_TEST_OPENSSL||'openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-keyout','-','-out',certificate,'-days','1','-subj','/CN=admin-console.test','-addext','subjectAltName=DNS:admin-console.test','-addext','extendedKeyUsage=serverAuth'],{cwd:dir,windowsHide:true,maxBuffer:1024*1024});
    key=result.stdout;if(!key.includes('-----BEGIN PRIVATE KEY-----'))throw Error();cert=await readFile(certificate);
  }catch{if(dir.startsWith(parent+sep))await rm(dir,{recursive:true,force:true});throw Error('EPHEMERAL_TEST_TLS_CREATION_FAILED');}
  const publicKey=new X509Certificate(cert).publicKey.export({type:'spki',format:'der'});
  const certificatePin=createHash('sha256').update(publicKey).digest('base64');
  let server,store,auth,handler,origin,port=0;
  const rpID='admin-console.test';
  async function start(){
    handler=undefined;
    server=createServer({key,cert},(req,res)=>{
      if(!handler){res.writeHead(503);res.end();return;}
      void handler.handle(req,res).catch(()=>{res.destroy();});
    });
    server.listen(port,'127.0.0.1');await once(server,'listening');port=server.address().port;origin='https://'+rpID+':'+port;
    store=await pgliteStore({dataDir:join(dir,'database')});auth=new StagingAdminAuth({store,origin,rpID});
    handler=createAdminConsole({mode:'connected',auth,origin,rpID});
  }
  async function stop(){
    if(server){server.closeAllConnections();await new Promise(r=>server.close(r));server=undefined;}
    await store?.close();store=undefined;handler=undefined;
  }
  try{await start();}catch{await stop().catch(()=>{});if(dir.startsWith(parent+sep))await rm(dir,{recursive:true,force:true});throw Error('CONNECTED_FIXTURE_START_FAILED');}
  const enrollmentTicket=(await auth.bootstrap()).enrollmentTicket;
  return{get origin(){return origin;},rpID,certificatePin,enrollmentTicket,get auth(){return auth;},async restart(){await stop();await start();},async dispose(){await stop();key=undefined;cert=undefined;if(!dir.startsWith(parent+sep))throw Error('UNSAFE_TEST_CLEANUP_PATH');await rm(dir,{recursive:true,force:true});}};
}
