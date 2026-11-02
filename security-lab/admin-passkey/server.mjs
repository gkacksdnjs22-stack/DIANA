import { createServer as httpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AdminAuth } from './auth.mjs';
import { NativeAuthorization } from './native.mjs';

export function createServer(auth) {
  const native=new NativeAuthorization(auth);
  let windowStart = Date.now(), requests = 0;
  const assets = new Map([
    ['/', ['ui/index.html', 'text/html']], ['/app.js', ['ui/app.js', 'text/javascript']],
    ['/native.html', ['ui/native.html','text/html']], ['/native.js',['ui/native.js','text/javascript']],
    ['/browser.js', ['node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js', 'text/javascript']],
  ]);
  return httpServer(async (req, res) => {
    const send = (status, value, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
      res.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      if (req.headers.host !== new URL(auth.origin).host) return send(403, { code: 'DENIED' });
      if (Date.now() - windowStart > 60_000) { requests = 0; windowStart = Date.now(); }
      if (++requests > 120) return send(429, { code: 'LIMIT' });
      if(req.method==='GET'&&req.url.startsWith('/authorize?')) {
        const params=new URL(req.url,auth.origin).searchParams;
        if([...params.keys()].some(k=>params.getAll(k).length!==1))throw Error();
        const id=native.begin(Object.fromEntries(params));
        auth.audit('native/authorize',true);
        res.writeHead(302,{'Location':'/native.html?request='+id,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }
      if(req.method==='GET'&&req.url.startsWith('/native.html?request='))req.url='/native.html';
      if (req.method === 'GET' && assets.has(req.url)) {
        const [file, type] = assets.get(req.url); return send(200, await readFile(new URL(file, import.meta.url)), type);
      }
      const nativeToken=req.url==='/api/native/token',nativeStatus=req.url==='/api/native/status';
      if (req.method !== 'POST' || !req.url.startsWith('/api/') || ((!nativeToken&&!nativeStatus || req.headers.origin)&&req.headers.origin !== auth.origin) || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type']||'')) return send(403, { code: 'DENIED' });
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32_768) throw Error(); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
      const raw = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
      if(nativeToken) {const result=native.exchange(body);auth.audit('native/token',true);return send(200,result);}
      if(nativeStatus){const s=auth.session(raw);auth.audit('native/status',true);return send(200,{authenticated:true,role:s.role,documentAccess:false,expires:s.expires});}
      if(req.url==='/api/native/approve'){const result=native.approve(body,raw);auth.audit('native/approve',true);return send(200,result);}
      send(200, await auth.dispatch(req.url.slice(5), body, raw));
    } catch {
      const operation=req.url.startsWith('/authorize?')?'native/authorize':new Map([['/api/native/token','native/token'],['/api/native/status','native/status'],['/api/native/approve','native/approve']]).get(req.url);
      if(operation)auth.audit(operation,false);
      send(403, { code: 'DENIED' });
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const auth = new AdminAuth({ dbPath: resolve(import.meta.dirname, 'test-data/service.sqlite') });
  const server = createServer(auth); server.requestTimeout = 10_000; server.headersTimeout = 10_000;
  server.listen(43871, '127.0.0.1', () => console.log('DIANA LAB 관리자: http://localhost:43871 (운영 연결 없음)'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => { auth.close(); process.exit(); }));
}
