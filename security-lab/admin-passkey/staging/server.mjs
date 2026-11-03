import {createServer as httpServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,timingSafeEqual} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stageConfig} from './config.mjs';
import {openPostgresStore} from './store.mjs';
import {StagingAdminAuth} from './auth.mjs';
import {StagingNativeAuthorization} from './native.mjs';
import {StagingRateLimits,sourceResolver} from './rate-limit.mjs';
const hash=x=>createHash('sha256').update(String(x||'')).digest('hex');
export function createStagingServer(auth,config){
  const native=new StagingNativeAuthorization(auth,config.androidRedirect);
  const limits=new StagingRateLimits(),source=sourceResolver(config.trustedProxyIPs);
  const assets=new Map([
    ['/native.html',['../ui/native.html','text/html']],['/native.js',['../ui/native.js','text/javascript']],
    ['/browser.js',['../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js','text/javascript']],
    ['/admin/', ['../../../admin-console/ui/index.html','text/html']],
    ['/admin/app.js', ['../../../admin-console/ui/app.js','text/javascript']],
    ['/admin/style.css', ['../../../admin-console/ui/style.css','text/css']],
    ['/admin/browser.js',['../node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js','text/javascript']],
  ]);
  return httpServer(async(req,res)=>{
    const send=(status,data,type='application/json')=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Strict-Transport-Security':'max-age=86400','Content-Security-Policy':req.url.startsWith('/admin/')?"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'":"default-src 'self'; script-src 'self'; style-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'"});res.end(type==='application/json'?JSON.stringify(data):data);};
    try{
      if(req.method==='GET'&&req.url==='/healthz'){
        const metadata=await auth.get('SELECT version FROM staging_metadata WHERE id=1');return send(metadata?.version===1?200:503,{service:'diana-admin-passkey-stage',database:metadata?.version===1?'ready':'unavailable'});
      }
      if(req.headers.host!==new URL(config.origin).host||req.headers['x-forwarded-proto']!=='https')return send(403,{code:'DENIED'});
      const raw=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
      const session=raw?await auth.session(raw).catch(()=>null):null;
      const lane=session?'administrator':req.method==='GET'&&!req.url.startsWith('/authorize?')?'read':'anonymous';
      // Only a DB-verified session can use the account lane. All that account's sessions share it.
      if(!limits.allow(lane,session?session.user_id:source(req)))return send(429,{code:'LIMIT'});
      if(req.method==='GET'&&req.url==='/'){res.writeHead(308,{'Location':'/admin/','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();}
      if(req.method==='GET'&&req.url==='/admin'){res.writeHead(308,{'Location':'/admin/','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();}
      if(req.method==='GET'&&req.url==='/admin/config.json')return send(200,{configured:true,basePath:'/admin/',apiBasePath:'/api/',origin:config.origin,rpID:config.rpID,documentAccess:false});
      if(req.method==='GET'&&req.url.startsWith('/authorize?')){
        const params=new URL(req.url,config.origin).searchParams;if([...params.keys()].some(k=>params.getAll(k).length!==1))throw Error();
        const id=await native.begin(Object.fromEntries(params));await auth.audit('native/authorize',true);
        res.writeHead(302,{'Location':'/native.html?request='+id,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }
      const assetPath=req.url.startsWith('/native.html?request=')?'/native.html':req.url;
      if(req.method==='GET'&&assets.has(assetPath)){const[file,type]=assets.get(assetPath);return send(200,await readFile(new URL(file,import.meta.url)),type);}
      const tokenRoute=req.url==='/api/native/token',statusRoute=req.url==='/api/native/status';
      if(req.method!=='POST'||!req.url.startsWith('/api/')||((!tokenRoute&&!statusRoute||req.headers.origin)&&req.headers.origin!==config.origin)||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return send(403,{code:'DENIED'});
      const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>32768)throw Error();chunks.push(b);}
      const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();
      if(req.url==='/api/stage/bootstrap'){
        const result=await auth.tx(async()=>{
          const metadata=await auth.get('SELECT bootstrap_hash,bootstrap_expires FROM staging_metadata WHERE id=1');
          const expected=Buffer.from(metadata.bootstrap_hash,'hex'),actual=Buffer.from(hash(body.token),'hex');
          if(metadata.bootstrap_expires<=auth.now()||!timingSafeEqual(expected,actual))throw Error();return auth.bootstrap();
        });await auth.audit('stage/bootstrap',true);return send(200,result);
      }
      if(tokenRoute){const result=await native.exchange(body);await auth.audit('native/token',true);return send(200,result);}
      if(statusRoute){const session=await auth.session(raw);await auth.audit('native/status',true);return send(200,{authenticated:true,role:session.role,documentAccess:false,expires:session.expires});}
      if(req.url==='/api/native/approve'){const result=await native.approve(body,raw);await auth.audit('native/approve',true);return send(200,result);}
      if(req.url==='/api/stage/persistence'){await auth.session(raw);return send(200,{instance:(await auth.get('SELECT instance_id FROM staging_metadata WHERE id=1')).instance_id});}
      return send(200,await auth.dispatch(req.url.slice(5),body,raw));
    }catch{
      const operation=new Map([['/api/native/token','native/token'],['/api/native/approve','native/approve'],['/api/stage/bootstrap','stage/bootstrap'],['/api/native/status','native/status']]).get(req.url);
      if(operation)await auth.audit(operation,false).catch(()=>{});return send(403,{code:'DENIED'});
    }
  });
}
export async function main(env=process.env){
  const config=stageConfig(env),store=await openPostgresStore(config),auth=new StagingAdminAuth({store,origin:config.origin,rpID:config.rpID});
  const server=createStagingServer(auth,config);server.requestTimeout=10000;server.headersTimeout=10000;
  server.listen(config.port,'0.0.0.0',()=>console.log('DIANA administrator HTTPS staging service ready.'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>void store.close().then(()=>process.exit())));
  return{server,auth};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('Staging startup failed. Check staging-only configuration and database.');process.exitCode=1;});
