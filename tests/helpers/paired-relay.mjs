import http from 'node:http';
import {createHash,createPublicKey,verify,randomBytes,randomInt,randomUUID,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {isIP} from 'node:net';

export const hash=s=>createHash('sha256').update(s).digest('hex');
export const proof=b=>JSON.stringify([b.host,b.publicKey,b.lease,b.time,b.nonce]);
const hex=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const fail=(status,error)=>{throw Object.assign(Error(error),{status});};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function mobileAllowed(b){
 if(!b||typeof b!=='object'||Array.isArray(b))return false;
 if(['state','file','receipt','revoke','phone-preview','phone-approve'].includes(b.op))return true;
 return b.op==='job'&&['desk-start','desk-upload','desk-retry','desk-cancel','desk-invalidate'].includes(b.action);
}
export async function createRelay({port=0,host='127.0.0.1',clock=Date.now,codeTtl=300000,pollMs=20000,requestMs=35000,renderProxy=false}={}){
 const hosts=new Map(),codes=new Map(),requests=new Map(),claims=new Map(),limits=new Map(),nonces=new Map(),failures=new Map();
 let buffered=0,stopping=false;
 function limit(key,n,ms=60000){const now=clock();let v=limits.get(key);if(!v||v.until<=now){if(limits.size>=10000)fail(429,'잠시 뒤 다시 시도하세요.');limits.set(key,v={n:0,until:now+ms});}if(++v.n>n)fail(429,'시도가 많습니다. 잠시 뒤 다시 시도하세요.');}
 function send(res,status,b){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(b));}
 function auth(req){const m=/^Host ([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(req.headers.authorization||'');const h=m&&hosts.get(m[1]);if(!h||!same(h.lease,hash(m[2])))fail(401,'PC 연결을 다시 확인하세요.');h.seen=clock();return h;}
 function done(r,result){if(!requests.delete(r.id))return;clearTimeout(r.timer);buffered-=r.size;r.resolve(result);}
 function deliver(h){if(!h.poll)return;const r=[...requests.values()].find(x=>x.host===h.id&&!x.sent);if(r){r.sent=true;const res=h.poll;h.poll=null;clearTimeout(h.timer);send(res,200,{message:{id:r.id,...r.payload}});}}
 function queue(h,payload){if(!h||clock()-h.seen>65000)fail(503,'PC가 연결되어 있지 않습니다. PC 앱을 확인하세요.');if(requests.size>=150||[...requests.values()].filter(r=>r.host===h.id).length>=8)fail(429,'PC가 다른 요청을 처리하고 있습니다.');const size=Buffer.byteLength(JSON.stringify(payload));if(buffered+size>48000000)fail(429,'전송 중인 자료가 많습니다. 잠시 뒤 다시 시도하세요.');buffered+=size;return new Promise(resolve=>{const r={id:randomUUID(),host:h.id,payload,size,resolve,sent:false};r.timer=setTimeout(()=>done(r,{status:503,body:{error:'PC 응답이 지연됩니다. 같은 작업에서 다시 시도하세요.'}}),requestMs);requests.set(r.id,r);deliver(h);});}
 function sweep(){const now=clock();for(const [k,v]of codes)if(v.expires<=now)codes.delete(k);for(const [k,v]of claims)if(v.expires<=now)claims.delete(k);for(const [k,v]of limits)if(v.until<=now)limits.delete(k);for(const[k,v]of failures)if(v.until<=now)failures.delete(k);for(const[k,v]of nonces)if(v<=now)nonces.delete(k);for(const[k,h]of hosts)if(now-h.seen>180000&&!h.poll){hosts.delete(k);for(const r of requests.values())if(r.host===k)done(r,{status:503,body:{error:'PC 연결이 끊어졌습니다.'}});}}
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/health'){send(res,200,{ok:true,service:'diana-device-link',protocol:1});return;}
   if(stopping||req.method!=='POST'||req.headers.origin||!/^application\/json\b/.test(req.headers['content-type']||''))fail(403,'허용되지 않은 요청입니다.');
   // Trust the platform client-IP header only on the Render-hosted entry point.
   const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
   const ip=renderProxy&&isIP(forwarded)?forwarded:req.socket.remoteAddress;limit(ip+':http',1800);
   let bytes=0,chunks=[];const max=req.url==='/host/reply'?16000000:req.url==='/v1'?11000000:16000;
   for await(const c of req){if((bytes+=c.length)>max)fail(413,'전송 크기 한도를 넘었습니다.');chunks.push(c);}
   let b;try{b=JSON.parse(Buffer.concat(chunks));}catch{fail(400,'요청 형식을 확인하세요.');}if(!b||typeof b!=='object'||Array.isArray(b))fail(400,'요청 형식을 확인하세요.');
   if(req.url==='/host/register'){
    limit(ip+':register',60);if(!hex(b.host)||!hex(b.lease)||typeof b.publicKey!=='string'||b.publicKey.length>500||typeof b.signature!=='string'||b.signature.length>200||!hex(b.nonce)||!Number.isSafeInteger(b.time)||Math.abs(clock()-b.time)>120000)fail(401,'PC 인증을 확인하세요.');
    let key;try{key=createPublicKey(b.publicKey);}catch{fail(401,'PC 인증을 확인하세요.');}
    if(key.asymmetricKeyType!=='ed25519'||hash(key.export({type:'spki',format:'der'}))!==b.host||!verify(null,Buffer.from(proof(b)),key,Buffer.from(b.signature,'base64')))fail(401,'PC 인증을 확인하세요.');
    const nonce=b.host+':'+b.nonce;if(nonces.has(nonce))fail(409,'이미 사용한 PC 인증입니다.');if(nonces.size>=10000)fail(429,'잠시 뒤 다시 시도하세요.');nonces.set(nonce,clock()+240000);
    let h=hosts.get(b.host);if(!h){if(hosts.size>=100)fail(429,'연결 가능한 PC 수를 넘었습니다.');h={id:b.host};hosts.set(b.host,h);}if(h.poll){send(h.poll,200,{});h.poll=null;clearTimeout(h.timer);}h.lease=hash(b.lease);h.seen=clock();send(res,200,{ok:true});return;
   }
   if(req.url.startsWith('/host/')){
    const h=auth(req);
    if(req.url==='/host/poll'){
     if(h.poll)send(h.poll,200,{});clearTimeout(h.timer);h.poll=res;h.timer=setTimeout(()=>{if(h.poll===res){h.poll=null;send(res,200,{});}},pollMs);res.on('close',()=>{if(h.poll===res){h.poll=null;clearTimeout(h.timer);}});deliver(h);return;
    }
    if(req.url==='/host/code'){
     limit(h.id+':code',10);if(!hex(b.grant))fail(400,'연결 정보를 확인하세요.');for(const[k,v]of codes)if(v.host===h.id)codes.delete(k);let code;do{code=randomInt(100000,1000000).toString();}while(codes.has(hash(code)));codes.set(hash(code),{host:h.id,grant:b.grant,expires:clock()+codeTtl});send(res,200,{code,expires:clock()+codeTtl});return;
    }
    if(req.url==='/host/reply'){
     const r=requests.get(b.id);if(!r||r.host!==h.id)fail(410,'요청이 만료되었습니다.');if(!Number.isInteger(b.status)||b.status<200||b.status>599||!b.body||typeof b.body!=='object')fail(400,'응답 형식을 확인하세요.');done(r,{status:b.status,body:b.body});send(res,200,{ok:true});return;
    }
    fail(404,'지원하지 않는 요청입니다.');
   }
   if(req.url!=='/v1')fail(404,'지원하지 않는 요청입니다.');
   if(b.op==='pair-code'){
    limit(ip+':pair',60,600000);if(!/^\d{6}$/.test(b.code)||!hex(b.pairKey)||typeof b.requestId!=='string'||!/^[a-f0-9-]{36}$/.test(b.requestId))fail(400,'6자리 코드를 확인하세요.');
    const claimKey=hash(b.requestId+'|'+b.pairKey),existing=claims.get(claimKey);if(existing){const result=await existing.result;send(res,result.status,result.body);return;}
    const failKey=ip+':pair-fail';let f=failures.get(failKey);if(f&&f.until<=clock()){failures.delete(failKey);f=null;}
    if(f?.n>=5){const seconds=Math.ceil((f.until-clock())/1000);send(res,429,{error:'코드를 5회 잘못 입력했습니다. 잠시 뒤 다시 시도하세요.',retryAfter:seconds});return;}
    limit('code:'+hash(b.code),8,600000);const c=codes.get(hash(b.code));if(!c||c.expires<=clock()){
     if(!f){if(failures.size>=10000)fail(429,'잠시 뒤 다시 시도하세요.');failures.set(failKey,f={n:0,until:clock()+300000});}f.n++;
     if(f.n>=5){f.until=clock()+300000;send(res,429,{error:'코드를 5회 잘못 입력했습니다. 5분 뒤 다시 시도하세요.',retryAfter:300});return;}
     send(res,403,{error:'연결 코드가 만료됐거나 일치하지 않습니다. PC에서 확인하세요.',remaining:5-f.n});return;
    }
    failures.delete(failKey);
    codes.delete(hash(b.code));const entry={expires:clock()+600000};claims.set(claimKey,entry);
    entry.result=Promise.resolve().then(()=>queue(hosts.get(c.host),{kind:'pair',grant:c.grant,requestId:b.requestId,pairKey:b.pairKey})).then(r=>{if(r.status===200){if(!hex(r.body.token)||typeof r.body.device!=='string')return {status:502,body:{error:'PC 연결 응답을 확인하지 못했습니다.'}};return{status:200,body:{...r.body,token:'v1.'+c.host+'.'+r.body.token}};}return r;}).catch(e=>({status:e.status||503,body:{error:e.status?e.message:'PC 연결을 확인하세요.'}}));
    const result=await entry.result;send(res,result.status,result.body);return;
   }
   const match=/^Bearer v1\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(req.headers.authorization||'');if(!match)fail(401,'기기를 다시 연결하세요.');if(!mobileAllowed(b))fail(403,'현재 PC에서 확인하세요.');
   limit(match[1]+':mobile',800);const result=await queue(hosts.get(match[1]),{kind:'call',token:match[2],body:b});send(res,result.status,result.body);
  }catch(e){send(res,e.status||400,{error:e.status?e.message:'연결 요청을 처리하지 못했습니다.'});}
 });
 server.requestTimeout=50000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
 await new Promise((resolve,reject)=>server.once('error',reject).listen(port,host,resolve));const timer=setInterval(sweep,30000);timer.unref();
 return {origin:'http://127.0.0.1:'+server.address().port,close:async()=>{stopping=true;clearInterval(timer);for(const h of hosts.values()){clearTimeout(h.timer);if(h.poll)send(h.poll,503,{error:'연결을 다시 시도하세요.'});}for(const r of requests.values())done(r,{status:503,body:{error:'연결을 다시 시도하세요.'}});server.closeIdleConnections();await new Promise(ok=>server.close(ok));},sweep};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const relay=await createRelay({port:Number(process.env.PORT||10000),host:'0.0.0.0',renderProxy:process.env.RENDER==='true'});console.log('DIANA device link ready');
 for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>relay.close().then(()=>process.exit(0)));}
