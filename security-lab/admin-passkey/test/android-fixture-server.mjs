// Test harness only. NEVER used by server.mjs or packaged with EXE/APK.
import {createServer as httpServer} from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {AdminAuth} from '../auth.mjs';
import {createServer} from '../server.mjs';
import {NativeAuthorization} from '../native.mjs';
import {Authenticator} from './software-authenticator.mjs';
const auth=new AdminAuth({dbPath:path.resolve(import.meta.dirname,'../test-data','android-'+randomBytes(12).toString('hex')+'.sqlite')});
const key=new Authenticator(),ticket=auth.bootstrap().enrollmentTicket,c=await auth.dispatch('register/begin',{ticket});
await auth.dispatch('register/finish',{ceremonyId:c.ceremonyId,response:key.register(c.options)});
const native=new NativeAuthorization(auth),base=createServer(auth);
const server=httpServer(async(req,res)=>{
  if(!req.url.startsWith('/__fixture/'))return base.emit('request',req,res);
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    if(req.headers.host!=='localhost:43871'||req.method!=='POST')throw Error();
    const chunks=[];let size=0;for await(const b of req){size+=b.length;if(size>8192)throw Error();chunks.push(b);}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    if(req.url==='/__fixture/authorize'){
      const url=new URL(body.url);if(url.origin!==auth.origin||url.pathname!=='/authorize')throw Error();
      const requestId=native.begin(Object.fromEntries(url.searchParams));
      const begin=await auth.dispatch('login/begin'),login=await auth.dispatch('login/finish',{ceremonyId:begin.ceremonyId,response:key.login(begin.options)});
      const approved=native.approve({requestId},login.sessionToken);auth.run('INSERT OR IGNORE INTO fixture_sources VALUES(?)',auth.session(login.sessionToken).hash);
      return send(200,approved);
    }
    if(req.url==='/__fixture/revoke'){
      auth.run('UPDATE sessions SET revoked=1 WHERE hash NOT IN (SELECT hash FROM fixture_sources)');return send(200,{revoked:true});
    }
    throw Error();
  }catch{send(403,{code:'TEST_DENIED'});}
});
auth.db.exec('CREATE TABLE fixture_sources(hash TEXT PRIMARY KEY)');
server.listen(43871,'127.0.0.1',()=>console.log('Android fixture ready (software WebAuthn, isolated DB only).'));
let stopped=false;const stop=()=>{if(stopped)return;stopped=true;server.close(()=>{auth.close();process.exit();});};
process.stdin.on('data',b=>{if(b.toString().trim()==='stop')stop();});process.on('SIGINT',stop);process.on('SIGTERM',stop);
