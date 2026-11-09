import {generateKeyPairSync,createPrivateKey,createPublicKey,sign,randomBytes,createHash,createHmac} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
// Public discovery endpoint. This is not a credential or a PC filesystem address.
export const RELAY_ORIGIN='https://diana-device-link.onrender.com';
const hash=s=>createHash('sha256').update(s).digest('hex');
const secret=()=>randomBytes(32).toString('hex');
const proof=b=>JSON.stringify([b.host,b.publicKey,b.lease,b.time,b.nonce]);
export async function createDeviceLink({state,origin=RELAY_ORIGIN,dispatch,pair}){
 const u=new URL(origin);if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1'))throw Error('중계 서버 주소를 확인하세요.');origin=u.origin;
 const keyPath=path.join(state,'relay-identity.pem');let pem;
 try{pem=await readFile(keyPath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;const keys=generateKeyPairSync('ed25519');const created=keys.privateKey.export({type:'pkcs8',format:'pem'});try{await writeFile(keyPath,created,{flag:'wx',mode:0o600});pem=created;}catch(err){if(err.code!=='EEXIST')throw err;pem=await readFile(keyPath,'utf8');}}
 const privateKey=createPrivateKey(pem),publicKey=createPublicKey(privateKey),host=hash(publicKey.export({type:'spki',format:'der'})),lease=secret();
 const controller=new AbortController();let stopped=false,registered=false,loop;
 const derive=(grant,requestId,pairKey)=>createHmac('sha256',pem).update(JSON.stringify([grant,requestId,pairKey])).digest('hex');
 async function post(route,body,withAuth=true,timeout=45000){
  const response=await fetch(origin+route,{method:'POST',redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(timeout)]),headers:{'content-type':'application/json',...(withAuth?{authorization:'Host '+host+'.'+lease}:{})},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error||'중계 서버에 연결하지 못했습니다.'),{status:response.status});return data;
 }
 async function register(){const b={host,publicKey:publicKey.export({type:'spki',format:'pem'}),lease,time:Date.now(),nonce:secret()};b.signature=sign(null,Buffer.from(proof(b)),privateKey).toString('base64');await post('/host/register',b,false);registered=true;}
 async function processMessage(m){let r;try{if(m.kind==='pair')r={status:200,body:await pair({...m,token:derive(m.grant,m.requestId,m.pairKey)})};else if(m.kind==='call')r=await dispatch(m.token,m.body);else throw Error('지원하지 않는 요청입니다.');}catch(e){r={status:e.status||400,body:{error:/[가-힣]/u.test(e.message)?e.message:'연결 요청을 처리하지 못했습니다.'}};}await post('/host/reply',{id:m.id,...r});}
 const pause=ms=>new Promise(ok=>{if(stopped)return ok();const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);ok();};const timer=setTimeout(finish,ms);controller.signal.addEventListener('abort',finish,{once:true});});
 async function run(){let backoff=1000;while(!stopped){try{if(!registered)await register();const r=await post('/host/poll',{});if(r.message)await processMessage(r.message);backoff=1000;}catch(e){if(stopped)break;if(e.status===401)registered=false;await pause(backoff);backoff=Math.min(30000,backoff*2);}}}
 loop=run();
 return {host,derive,code:async grant=>{try{if(!registered)await register();return await post('/host/code',{grant});}catch(e){if(e.status===401){registered=false;await register();return post('/host/code',{grant});}throw Object.assign(Error('중계 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도하세요.'),{status:503});}},close:async()=>{stopped=true;controller.abort();await loop;}};
}
