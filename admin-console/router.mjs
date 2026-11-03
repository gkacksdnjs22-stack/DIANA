import {readFile} from 'node:fs/promises';
import {BlockList,isIP} from 'node:net';
import {StagingRateLimits,sourceResolver} from '../security-lab/admin-passkey/staging/rate-limit.mjs';

export const ADMIN_PATH='/admin/';
const actions=new Set(['register/begin','register/finish','login/begin','login/finish','list','invite','role','disable','accounts/purge','credential/revoke','recovery/codes','session/revoke','logout']);
const assets=new Map([
  ['/admin/',new URL('ui/index.html',import.meta.url)],
  ['/admin/app.js',new URL('ui/app.js',import.meta.url)],
  ['/admin/style.css',new URL('ui/style.css',import.meta.url)],
  ['/admin/diana-logo.png',new URL('ui/diana-logo.png',import.meta.url)],
  ['/admin/browser.js',new URL('node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js',import.meta.url)],
]);
export function isAdminRequest(target=''){
  const path=target.split('?')[0];return path==='/admin'||path.startsWith(ADMIN_PATH);
}
function configuredOrigin(origin,rpID){
  const u=new URL(origin);
  if(u.protocol!=='https:'||u.origin!==origin||u.username||u.password||u.hostname!==rpID||isIP(u.hostname)||!u.hostname.includes('.')||u.hostname.endsWith('.localhost'))throw Error('EXPLICIT_HTTPS_ADMIN_ORIGIN_REQUIRED');
  return u;
}
export function createAdminConsole({mode='preview',auth,origin,rpID,trustedProxyIPs=[]}={}){
  if(!['preview','connected'].includes(mode))throw Error('ADMIN_MODE_INVALID');
  if(trustedProxyIPs.length>32||trustedProxyIPs.some(x=>!isIP(x)))throw Error('TRUSTED_PROXY_IPS_INVALID');
  const configured=mode==='connected';
  const url=configured?configuredOrigin(origin,rpID):undefined;
  if(configured&&(!auth||auth.origin!==origin||auth.rpID!==rpID||typeof auth.dispatch!=='function'||typeof auth.session!=='function'))throw Error('ADMIN_AUTH_ADAPTER_REQUIRED');
  if(!configured&&auth)throw Error('PREVIEW_CANNOT_ACCEPT_AUTH');
  const peers=new BlockList();for(const ip of trustedProxyIPs)peers.addAddress(ip,isIP(ip)===4?'ipv4':'ipv6');
  const trusted=req=>{const p=req.socket.remoteAddress?.replace(/^::ffff:(?=\d+\.)/,'');return isIP(p)&&peers.check(p,isIP(p)===4?'ipv4':'ipv6');};
  const tls=req=>req.socket.encrypted===true||trusted(req)&&req.headers['x-forwarded-proto']==='https';
  const source=sourceResolver(trustedProxyIPs),limits=new StagingRateLimits();
  function send(res,status,value,type='application/json; charset=utf-8'){
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      ...(configured?{'Strict-Transport-Security':'max-age=86400'}:{})});
    res.end(type.startsWith('application/json')?JSON.stringify(value):value);
  }
  async function body(req){
    const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('BODY_LIMIT');chunks.push(chunk);}
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_BODY');return value;
  }
  return {path:ADMIN_PATH,async handle(req,res){
    if(!isAdminRequest(req.url))throw Error('OUTSIDE_ADMIN_MOUNT');
    try{
      const path=req.url.split('?')[0];
      if(path.includes('%')||path.includes('\\')||new URL(req.url,'http://invalid.local').pathname!==path||req.url.includes('?'))return send(res,404,{code:'NOT_FOUND'});
      if(configured&&(req.headers.host!==url.host||!tls(req)))return send(res,403,{code:'DENIED'});
      const raw=/^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization||'')?.[1];
      const session=configured&&raw?await auth.session(raw).catch(()=>null):null;
      const lane=session?'administrator':req.method==='GET'||req.method==='HEAD'?'read':'anonymous';
      if(!limits.allow(lane,session?session.user_id:source(req)))return send(res,429,{code:'LIMIT'});
      if(path==='/admin'&&req.method==='GET'){res.setHeader('Location',ADMIN_PATH);return send(res,308,'','text/plain; charset=utf-8');}
      if((req.method==='GET'||req.method==='HEAD')&&assets.has(path)){
        const type=path.endsWith('.png')?'image/png':path.endsWith('.js')?'text/javascript; charset=utf-8':path.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';
        return send(res,200,req.method==='HEAD'?'':await readFile(assets.get(path)),type);
      }
      if(path==='/admin/config.json'&&req.method==='GET')return send(res,200,{configured,basePath:ADMIN_PATH,origin:configured?origin:null,rpID:configured?rpID:null,documentAccess:false});
      if(!path.startsWith('/admin/api/'))return send(res,404,{code:'NOT_FOUND'});
      if(!configured)return send(res,503,{code:'ADMIN_NOT_CONFIGURED'});
      if(req.method!=='POST'||req.headers.origin!==origin||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))return send(res,403,{code:'DENIED'});
      const action=path.slice('/admin/api/'.length);if(!actions.has(action))return send(res,403,{code:'DENIED'});
      return send(res,200,await auth.dispatch(action,await body(req),raw));
    }catch{return send(res,403,{code:'DENIED'});}
  }};
}
