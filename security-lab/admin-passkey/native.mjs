import { createHash, randomBytes } from 'node:crypto';
const secret=()=>randomBytes(32).toString('base64url');
const hash=x=>createHash('sha256').update(x).digest('hex');
const need=x=>{if(!x)throw Error('DENIED');return x;};
export const pkce=x=>createHash('sha256').update(x).digest('base64url');
export class NativeAuthorization {
  constructor(auth) {
    this.auth=auth;
    auth.db.exec(`CREATE TABLE IF NOT EXISTS native_requests(id TEXT PRIMARY KEY,client TEXT NOT NULL,redirect TEXT NOT NULL,state TEXT NOT NULL,challenge TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_codes(hash TEXT PRIMARY KEY,client TEXT NOT NULL,redirect TEXT NOT NULL,challenge TEXT NOT NULL,source TEXT NOT NULL,expires INTEGER NOT NULL);`);
  }
  validate(client,redirect) {
    if(client==='diana-lab-android')return need(redirect==='kr.nightdesk.phone.lab.passkey://oauth2/callback');
    need(client==='diana-lab-desktop');const u=new URL(redirect);
    need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&Number(u.port)>0&&u.pathname==='/oauth2/callback'&&!u.username&&!u.password&&!u.search&&!u.hash);
  }
  begin(params) {
    need(params.response_type==='code'&&params.code_challenge_method==='S256');
    need(/^[A-Za-z0-9_-]{43}$/.test(params.state)&&/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge));
    this.validate(params.client_id,params.redirect_uri);
    const id=secret(),a=this.auth;
    a.run('DELETE FROM native_requests WHERE expires<=?',a.now());a.run('DELETE FROM native_codes WHERE expires<=?',a.now());
    a.run('INSERT INTO native_requests VALUES(?,?,?,?,?,?)',id,params.client_id,params.redirect_uri,params.state,params.code_challenge,a.now()+120_000);
    return id;
  }
  approve({requestId},raw) {
    const a=this.auth;
    return a.tx(()=>{
      const s=a.session(raw);need(['owner','admin'].includes(s.role));
      need(s.kind==='webauthn'&&a.now()>=s.webauthn_at&&a.now()-s.webauthn_at<60_000);
      const r=need(a.get('SELECT * FROM native_requests WHERE id=? AND expires>?',requestId,a.now()));
      a.run('DELETE FROM native_requests WHERE id=?',requestId);
      const code=secret();a.run('INSERT INTO native_codes VALUES(?,?,?,?,?,?)',hash(code),r.client,r.redirect,r.challenge,s.hash,a.now()+60_000);
      const redirect=new URL(r.redirect);redirect.searchParams.set('code',code);redirect.searchParams.set('state',r.state);
      return {redirect:redirect.href};
    });
  }
  exchange(body) {
    const a=this.auth;
    // A submitted authorization code is consumed even if the proof is incorrect.
    const c=a.tx(()=>{const row=need(a.get('SELECT * FROM native_codes WHERE hash=?',hash(String(body.code||''))));a.run('DELETE FROM native_codes WHERE hash=?',hash(body.code));return row;});
    return a.tx(()=>{
      need(body.grant_type==='authorization_code'&&c.expires>a.now());
      need(c.client===body.client_id&&c.redirect===body.redirect_uri&&/^[A-Za-z0-9_-]{43,128}$/.test(body.code_verifier)&&pkce(body.code_verifier)===c.challenge);
      const s=a.activeSessionHash(c.source);need(['owner','admin'].includes(s.role));need(s.kind==='webauthn');
      const expires=Math.min(s.expires,s.absolute_expires);need(expires>a.now());
      const access=secret();a.run('INSERT INTO sessions VALUES(?,?,?,?,0)',hash(access),s.user_id,s.credential_id,expires);
      a.run('INSERT INTO session_authentication VALUES(?,?,?,?)',hash(access),s.webauthn_at,s.absolute_expires,'native');
      return {access_token:access,token_type:'Bearer',expires_in:Math.floor((expires-a.now())/1000)};
    });
  }
}
