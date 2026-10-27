import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {strictJSON,keys} from './strict-json.mjs';
import {UUID} from '../lib/financial-contract.mjs';
import {reviewFailure} from './saved-review.mjs';

const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/review.js',['review.js','text/javascript; charset=utf-8']],['/recheck-view.mjs',['recheck-view.mjs','text/javascript; charset=utf-8']],['/review.css',['review.css','text/css; charset=utf-8']],['/diana-icon.png',['diana-icon.png','image/png']]]);

/** PC loopback UI. Relay credentials never authorize local decisions. */
export async function createReviewViewer({onCommand=null,onRecheck=null}={}){
  const token=randomBytes(32).toString('hex'),jobs=new Map(),busy=new Set();
  let connection={connected:false,checkedAt:null},origin;
  const files=new Map(await Promise.all([...assets].map(async([route,[file,type]])=>[route,{type,bytes:await readFile(new URL('./review-ui/'+file,import.meta.url))}])));
  const server=createServer((req,res)=>{
    const finish=(status,content,type='text/plain; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type});res.end(content);};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const site=req.headers['sec-fetch-site'];
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)||(site&&!['none','same-origin'].includes(site)))return finish(403,'LOCAL_VIEW_ONLY');
    let route;try{route=new URL(req.url,origin);}catch{return finish(400,'INVALID_REQUEST');}if(route.search)return finish(404,'NOT_FOUND');
    if(req.method==='GET'&&files.has(route.pathname)){const f=files.get(route.pathname);return finish(200,f.bytes,f.type);}
    const action=req.method==='POST'&&route.pathname==='/api/local-action';
    if(!action&&!(req.method==='GET'&&route.pathname==='/api/view'))return finish(req.method==='GET'?404:405,'NOT_FOUND');
    const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+token);
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return finish(401,'LOCAL_SESSION_REQUIRED');
    if(!action)return finish(200,JSON.stringify({connection,capabilities:{approve:typeof onCommand==='function',recheck:typeof onRecheck==='function'},jobs:[...jobs.values()].reverse().map(j=>({...j,busy:busy.has(j.job?.id)}))}),'application/json; charset=utf-8');
    // Every state-changing request needs an actual same-origin JSON fetch as
    // well as the process-local secret. Check state AFTER receiving its body.
    if(req.headers.origin!==origin||!/^application\/json(?:;\s*charset=utf-8)?$/iu.test(req.headers['content-type']||''))return finish(403,'LOCAL_ORIGIN_REQUIRED');
    void(async()=>{
      let body;try{let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024)throw Error();chunks.push(chunk);}
        body=strictJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));keys(body,['requestId','viewId','action']);
        if(!UUID.test(body.requestId)||!UUID.test(body.viewId)||!['approve','reject','recheck'].includes(body.action))throw Error();
      }catch{return finish(400,'INVALID_LOCAL_ACTION');}
      const entry=jobs.get(body.requestId),recheck=body.action==='recheck';
      const ready=entry&&!busy.has(body.requestId)&&(recheck?
        entry.resultId===body.viewId&&entry.result?.saved===true&&entry.result?.storageVerified===true&&typeof onRecheck==='function':
        entry.reviewId===body.viewId&&entry.approvalReady===true&&entry.job?.state==='PC_REVIEW_REQUIRED'&&Date.now()<=entry.approvalExpires&&typeof onCommand==='function');
      if(!ready)return finish(409,'LOCAL_ACTION_CHANGED');
      busy.add(body.requestId);
      if(!recheck)jobs.set(body.requestId,{...entry,approvalReady:false});
      try{if(recheck)await onRecheck(body.requestId);else await onCommand(body.action,body.requestId);finish(200,'{"ok":true}','application/json; charset=utf-8');}
      catch(error){
        if(recheck){const failure={...reviewFailure(error),checkedAt:new Date().toISOString()},current=jobs.get(body.requestId);if(current)jobs.set(body.requestId,{...current,recheck:failure});
          finish(409,JSON.stringify({ok:false,code:'SAVED_REVIEW_FAILED',review:failure}),'application/json; charset=utf-8');}
        else finish(409,'LOCAL_ACTION_REJECTED');
      }
      finally{busy.delete(body.requestId);}
    })().catch(()=>{if(!res.headersSent&&!res.destroyed)finish(409,'LOCAL_ACTION_REJECTED');});
  });
  server.requestTimeout=5000;server.headersTimeout=5000;server.keepAliveTimeout=1000;
  server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  return{
    url:origin+'/#view='+token,
    accept(event){
      if(event.type==='connection'){connection={connected:event.connected===true,checkedAt:new Date().toISOString()};return;}
      const id=event.job?.id||event.requestId;if(typeof id!=='string')return;
      const previous=jobs.get(id)||{};
      const next=event.type==='job'?{...previous,job:event.job,label:event.label,phase:event.phase,approvalReady:event.approvalReady,approvalExpires:event.approvalExpires}:
        event.type==='review'?{...previous,documents:event.documents,review:event.review,reviewId:randomUUID()}:
        event.type==='result'?{...previous,result:event.result,resultId:randomUUID()}:
        event.type==='recheck'?{...previous,recheck:event.recheck}:null;
      if(!next)return;jobs.set(id,structuredClone(next));
      while(jobs.size>8)jobs.delete(jobs.keys().next().value);
    },
    async close(){jobs.clear();connection={connected:false,checkedAt:null};server.closeAllConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
  };
}
